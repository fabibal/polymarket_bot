FROM node:20-alpine

# Install Bullpen CLI globally
RUN npm install -g @bullpenfi/cli

WORKDIR /app

# Install Node dependencies first (layer cache)
COPY package*.json ./
RUN npm install

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Copy static dashboard
COPY public/ ./public/

# Data directory is mounted as a volume at runtime
RUN mkdir -p data

EXPOSE 8080

CMD ["node", "dist/index.js"]
