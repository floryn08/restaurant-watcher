import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';

// --- Configuration ---
const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const DATA_FILE = process.env.DATA_FILE ?? '/data/city_center_registry.json';
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 30000;
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 60000;
const NOTIFY_ON_INITIAL_SCAN = process.env.NOTIFY_ON_INITIAL_SCAN === 'true';
const DISCORD_MAX_LENGTH = 2000;

const SW = { lat: Number(process.env.SW_LAT), lng: Number(process.env.SW_LNG) };
const NE = { lat: Number(process.env.NE_LAT), lng: Number(process.env.NE_LNG) };
const GRID_SIZE = Number(process.env.GRID_SIZE) || 3;

if (!API_KEY || isNaN(SW.lat) || isNaN(SW.lng) || isNaN(NE.lat) || isNaN(NE.lng)) {
  console.error('Missing required config: GOOGLE_MAPS_API_KEY, SW_LAT, SW_LNG, NE_LAT, NE_LNG');
  process.exit(1);
}

// --- Types ---
interface Restaurant {
  id: string;
  displayName: { text: string };
  businessStatus: string;
}

// --- Helpers ---
let apiCallCount = { textSearch: 0, placeDetails: 0 };

async function fetchWithRetry(url: string, options: RequestInit, retries = 3, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok || res.status < 500) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < retries - 1) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function searchSquare(
  lowLat: number,
  lowLng: number,
  highLat: number,
  highLng: number,
): Promise<Restaurant[]> {
  const res = await fetchWithRetry('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY!,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.businessStatus',
    },
    body: JSON.stringify({
      textQuery: 'restaurants',
      locationRestriction: {
        rectangle: {
          low: { latitude: lowLat, longitude: lowLng },
          high: { latitude: highLat, longitude: highLng },
        },
      },
    }),
  });
  apiCallCount.textSearch++;
  const data = (await res.json()) as { places?: Restaurant[] };
  return data.places ?? [];
}

async function verifyPlaceStatus(id: string): Promise<Restaurant | null> {
  const res = await fetchWithRetry(`https://places.googleapis.com/v1/places/${id}`, {
    headers: {
      'X-Goog-Api-Key': API_KEY!,
      'X-Goog-FieldMask': 'id,displayName,businessStatus',
    },
  });
  apiCallCount.placeDetails++;
  return res.ok ? ((await res.json()) as Restaurant) : null;
}

async function generateAnnouncement(openings: Restaurant[], closures: string[]): Promise<string> {
  const bulletPoints = [
    ...openings.map(o => `- 🆕 DESCHIS RECENT: ${o.displayName.text}`),
    ...closures.map(c => `- 🚪 ÎNCHIS PERMANENT: ${c}`),
  ].join('\n');

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: `You are a friendly local city food reporter writing for a Discord community. Based on these restaurant changes detected this week, write a short and engaging announcement in Romanian. Use emojis naturally. List every restaurant as a markdown bullet point and always include the restaurant names. Do not use markdown headers:

${bulletPoints}`,
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`Ollama responded with ${res.status}`);
    const data = (await res.json()) as { response: string };
    return data.response.trim();
  } catch (err) {
    console.warn('Ollama unavailable, using plain fallback message:', err);
    return `🍽️ Actualizare restaurante!\n${bulletPoints}`;
  }
}

async function sendDiscordNotification(message: string): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) return;
  const content = message.length > DISCORD_MAX_LENGTH
    ? message.slice(0, DISCORD_MAX_LENGTH - 20).trimEnd() + "\n..."
    : message;

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Restaurant Watcher', content }),
    });
    if (!res.ok) throw new Error(`Discord webhook responded with ${res.status}`);
  } catch (err) {
    throw new Error('Failed to send Discord notification: ' + (err instanceof Error ? err.message : String(err)));
  }
}

function readPreviousSnapshot(): { exists: boolean; restaurants: Restaurant[] } {
  if (!fs.existsSync(DATA_FILE)) return { exists: false, restaurants: [] };

  try {
    return {
      exists: true,
      restaurants: JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) as Restaurant[],
    };
  } catch (err) {
    throw new Error('Failed to read registry file ' + DATA_FILE + ': ' + (err instanceof Error ? err.message : String(err)));
  }
}

function writeSnapshot(restaurants: Restaurant[]): void {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tempFile = DATA_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tempFile, JSON.stringify(restaurants, null, 2));
  fs.renameSync(tempFile, DATA_FILE);
}

/**
 * Recursively scans a cell. If the result hits the 20-place API cap the cell
 * is split into 4 quadrants and each is scanned independently, repeating until
 * every leaf cell returns fewer than 20 results.
 */
async function scanCell(
  lowLat: number,
  lowLng: number,
  highLat: number,
  highLng: number,
  found: Map<string, Restaurant>,
  depth = 0,
): Promise<void> {
  const results = await searchSquare(lowLat, lowLng, highLat, highLng);
  results.forEach(p => found.set(p.id, p));

  if (results.length < 20) return;

  // Hit the cap — subdivide into 4 quadrants and recurse
  console.log(`${'  '.repeat(depth)}Cell [${lowLat.toFixed(5)},${lowLng.toFixed(5)}] saturated (${results.length} results) — subdividing...`);
  const midLat = (lowLat + highLat) / 2;
  const midLng = (lowLng + highLng) / 2;

  await scanCell(lowLat, lowLng, midLat, midLng, found, depth + 1);
  await scanCell(lowLat, midLng, midLat, highLng, found, depth + 1);
  await scanCell(midLat, lowLng, highLat, midLng, found, depth + 1);
  await scanCell(midLat, midLng, highLat, highLng, found, depth + 1);
}

// --- Main ---
async function runWatcher(): Promise<void> {
  console.log(`Scanning bounding box grid (${GRID_SIZE}x${GRID_SIZE}) with adaptive subdivision...`);
  const allFound = new Map<string, Restaurant>();

  const latStep = (NE.lat - SW.lat) / GRID_SIZE;
  const lngStep = (NE.lng - SW.lng) / GRID_SIZE;

  for (let i = 0; i < GRID_SIZE; i++) {
    for (let j = 0; j < GRID_SIZE; j++) {
      const lowLat = SW.lat + i * latStep;
      const lowLng = SW.lng + j * lngStep;
      await scanCell(lowLat, lowLng, lowLat + latStep, lowLng + lngStep, allFound);
    }
  }

  const currentSnapshot = Array.from(allFound.values());
  const previousSnapshot = readPreviousSnapshot();

  if (!previousSnapshot.exists && !NOTIFY_ON_INITIAL_SCAN) {
    writeSnapshot(currentSnapshot);
    console.log('Initial registry created with ' + currentSnapshot.length + ' restaurants. Skipping notification.');
    return;
  }

  const currentIds = new Set(currentSnapshot.map(r => r.id));
  const previousIds = new Set(previousSnapshot.restaurants.map(r => r.id));

  const openings = currentSnapshot.filter(r => !previousIds.has(r.id));
  const missing = previousSnapshot.restaurants.filter(r => !currentIds.has(r.id));
  const confirmedClosures: string[] = [];

  // "Ghost Hunter" — verify each missing place before marking as closed
  for (const place of missing) {
    const actual = await verifyPlaceStatus(place.id);
    if (!actual || actual.businessStatus === 'CLOSED_PERMANENTLY') {
      confirmedClosures.push(place.displayName.text);
    } else {
      // Still open, just slipped through the grid scan — keep it
      currentSnapshot.push(actual);
    }
  }

  console.log(`Scan complete. Registry: ${currentSnapshot.length} restaurants.`);
  console.log(`API calls — Text Search: ${apiCallCount.textSearch}, Place Details: ${apiCallCount.placeDetails}, Total: ${apiCallCount.textSearch + apiCallCount.placeDetails}`);

  if (openings.length > 0 || confirmedClosures.length > 0) {
    if (openings.length > 0) console.log(`New openings: ${openings.map(o => o.displayName.text).join(', ')}`);
    if (confirmedClosures.length > 0) console.log(`Confirmed closures: ${confirmedClosures.join(', ')}`);

    const message = await generateAnnouncement(openings, confirmedClosures);
    await sendDiscordNotification(message);
    if (DISCORD_WEBHOOK_URL) console.log('Discord notification sent.');
  } else {
    console.log('No changes detected since last scan.');
  }

  writeSnapshot(currentSnapshot);
}

runWatcher().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
