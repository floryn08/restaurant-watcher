# --- Build stage ---
FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# --- Runtime stage ---
FROM node:24-alpine AS runner

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 watcher

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# /data is where the registry JSON is persisted via a mounted PVC
RUN mkdir -p /data && chown watcher:nodejs /data

USER watcher

CMD ["node", "dist/watcher.js"]
