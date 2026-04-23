FROM node:20-alpine

# Build deps for native modules (better-sqlite3 uses node-gyp → needs python/make/g++)
RUN apk add --no-cache python3 make g++

# Install Bullpen CLI globally
RUN npm install -g @bullpenfi/cli

WORKDIR /app

# Install Node dependencies first (layer cache).
# Includes devDependencies so ts-node is available for the one-shot migrator.
COPY package*.json ./
RUN npm install

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Copy static dashboard and operational scripts (migrator + verifier)
COPY public/ ./public/
COPY scripts/ ./scripts/

# Data directory is mounted as a volume at runtime
RUN mkdir -p data

EXPOSE 8080

CMD ["node", "dist/index.js"]
