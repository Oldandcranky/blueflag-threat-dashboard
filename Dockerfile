# Use the official Playwright image — Chromium and all dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Install Node dependencies (skip browser download — image already has Chromium)
COPY package*.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev

# Copy app source
COPY . .

# Pre-create data directories (volumes will overlay these at runtime)
RUN mkdir -p snapshots reports debug

EXPOSE 3737

CMD ["node", "server.js"]
