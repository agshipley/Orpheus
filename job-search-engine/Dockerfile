# ─── Build stage ─────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Install root (server) dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Install client dependencies
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci

# Copy source
COPY . .

# Build server (TypeScript → dist/)
RUN npm run build:server

# Build client (Vite → dist/client/)
RUN npm run build:client

# ─── Production stage ─────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Install runtime dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Only copy production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Copy personal config (private repo — safe to commit)
COPY --from=builder /app/archimedes.config.yaml ./archimedes.config.yaml

# Data directory for SQLite and dashboard state
RUN mkdir -p data

# Railway injects PORT at runtime; default to 3000 locally
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE ${PORT}

CMD ["node", "dist/server/index.js"]
