FROM node:22-slim

WORKDIR /app

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies with npm (not pnpm) to build native modules
RUN npm install

# Install Playwright Chromium browser + system deps (for web browsing MCP server)
# Skipped when INSTALL_PLAYWRIGHT=false to keep the image smaller
ARG INSTALL_PLAYWRIGHT=true
RUN if [ "$INSTALL_PLAYWRIGHT" = "true" ]; then npx playwright install --with-deps chromium; fi

# Install MCP server dependencies
COPY mcp-servers/packages/kan/package.json mcp-servers/packages/kan/
RUN cd mcp-servers/packages/kan && npm install

COPY mcp-servers/packages/outline/package.json mcp-servers/packages/outline/
RUN cd mcp-servers/packages/outline && npm install

COPY mcp-servers/packages/radicale/package.json mcp-servers/packages/radicale/
RUN cd mcp-servers/packages/radicale && npm install

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Create data directory for SQLite
RUN mkdir -p /app/data

# Set environment defaults
ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/kan-bot.db

# Install curl for health checks
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Health check — verifies the app is actually working, not just running
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

EXPOSE 8080

# Run the bot
CMD ["node", "dist/index.js"]
