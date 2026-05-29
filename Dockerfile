# Standard Node image — Playwright installs its own matching Chromium at build time
# so the browser version always matches the package version, no matter what.
FROM node:20-bookworm-slim

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Install Playwright's Chromium + all system dependencies it needs
RUN npx playwright install chromium --with-deps

# Copy app source
COPY . .

# Pre-create data directories (volumes will overlay these at runtime)
RUN mkdir -p snapshots reports debug

EXPOSE 3737

CMD ["node", "server.js"]
