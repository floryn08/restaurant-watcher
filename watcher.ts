import * as fs from 'node:fs';

// --- ENV LOADING ---
const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const DATA_FILE = './city_center_registry.json';

const SW = { lat: Number(process.env.SW_LAT), lng: Number(process.env.SW_LNG) };
const NE = { lat: Number(process.env.NE_LAT), lng: Number(process.env.NE_LNG) };
const GRID_SIZE = Number(process.env.GRID_SIZE) || 3;

if (!API_KEY || isNaN(SW.lat) || isNaN(NE.lat)) {
  console.error("❌ Error: Missing configuration in .env file (API_KEY or Coordinates).");
  process.exit(1);
}

interface Restaurant {
  id: string;
  displayName: { text: string };
  businessStatus: string;
}

/**
 * Searches a specific rectangle using Text Search (New)
 */
async function searchSquare(lowLat: number, lowLng: number, highLat: number, highLng: number): Promise<Restaurant[]> {
  const url = 'https://places.googleapis.com/v1/places:searchText';
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY!,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.businessStatus'
    },
    body: JSON.stringify({
      textQuery: 'restaurants',
      locationRestriction: {
        rectangle: {
          low: { latitude: lowLat, longitude: lowLng },
          high: { latitude: highLat, longitude: highLng }
        }
      }
    })
  });

  if (!response.ok) return [];
  const data = await response.json() as { places?: Restaurant[] };
  return data.places || [];
}

/**
 * Audit specific ID to confirm permanent closure
 */
async function verifyPlaceStatus(id: string): Promise<Restaurant | null> {
  const url = `https://places.googleapis.com/v1/places/${id}`;
  const response = await fetch(url, {
    headers: { 'X-Goog-Api-Key': API_KEY!, 'X-Goog-FieldMask': 'id,displayName,businessStatus' }
  });
  return response.ok ? await response.json() as Restaurant : null;
}

async function runWatcher() {
  console.log(`🚀 Scanning Bounding Box Grid (${GRID_SIZE}x${GRID_SIZE})...`);
  const allFound = new Map<string, Restaurant>();

  const latStep = (NE.lat - SW.lat) / GRID_SIZE;
  const lngStep = (NE.lng - SW.lng) / GRID_SIZE;

  // 1. Tiled Scan
  for (let i = 0; i < GRID_SIZE; i++) {
    for (let j = 0; j < GRID_SIZE; j++) {
      const lowLat = SW.lat + (i * latStep);
      const lowLng = SW.lng + (j * lngStep);
      const highLat = lowLat + latStep;
      const highLng = lowLng + lngStep;

      const results = await searchSquare(lowLat, lowLng, highLat, highLng);
      results.forEach(p => allFound.set(p.id, p));

      if (results.length >= 20) {
        console.warn(`⚠️ Warning: Sector [${i},${j}] hit the 20-result limit. You might be missing restaurants.`);
      }
    }
  }

  const currentSnapshot = Array.from(allFound.values());
  const previousSnapshot: Restaurant[] = fs.existsSync(DATA_FILE) 
    ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) 
    : [];

  const currentIds = new Set(currentSnapshot.map(r => r.id));
  const previousIds = new Set(previousSnapshot.map(r => r.id));

  // 2. Identify Changes
  const openings = currentSnapshot.filter(r => !previousIds.has(r.id));
  const missing = previousSnapshot.filter(r => !currentIds.has(r.id));
  const confirmedClosures: string[] = [];

  // 3. Confirm Closures (The "Ghost Hunter" check)
  for (const place of missing) {
    const actual = await verifyPlaceStatus(place.id);
    if (!actual || actual.businessStatus === 'CLOSED_PERMANENTLY') {
      confirmedClosures.push(place.displayName.text);
    } else {
      // It's still open, just re-add it to the snapshot
      currentSnapshot.push(actual);
    }
  }

  // 4. Output & Persist
  console.log(`\n✅ Scan Finished. Registry count: ${currentSnapshot.length}`);
  if (openings.length) console.log(`✨ NEW OPENINGS: ${openings.map(o => o.displayName.text).join(', ')}`);
  if (confirmedClosures.length) console.log(`❌ CONFIRMED CLOSED: ${confirmedClosures.join(', ')}`);
  
  if (!openings.length && !confirmedClosures.length) {
    console.log("📭 No changes detected since last scan.");
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify(currentSnapshot, null, 2));
}

runWatcher();