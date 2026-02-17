FROM node:22-slim

WORKDIR /app

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies with npm (not pnpm) to build native modules
RUN npm install

# Install MCP server dependencies
COPY mcp-servers/kan/package.json mcp-servers/kan/
RUN cd mcp-servers/kan && npm install

COPY mcp-servers/outline/package.json mcp-servers/outline/
RUN cd mcp-servers/outline && npm install

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
