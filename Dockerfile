FROM node:22-slim

WORKDIR /app

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies with npm (not pnpm) to build native modules
RUN npm install

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

# Run the bot
CMD ["node", "dist/index.js"]
