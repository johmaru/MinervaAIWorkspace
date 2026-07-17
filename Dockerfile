FROM oven/bun:1.3 AS deps
WORKDIR /app
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
RUN rm -rf node_modules/@xenova/transformers/node_modules/sharp

FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Rebuild better-sqlite3 native binary for Node (the deps stage installed it with Bun)
RUN npm rebuild better-sqlite3
# Override version from APP_VERSION build arg (for display only; Docker does not auto-update)
ARG APP_VERSION=0.0.0
RUN node -e "const fs=require('fs'); const p=require('./package.json'); p.version=process.env.APP_VERSION || '0.0.0'; fs.writeFileSync('package.json', JSON.stringify(p,null,2));"
RUN DATABASE_URL=":memory:" NODE_OPTIONS="--max-old-space-size=3072" npx next build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# Install runtime dependencies + Docker CLI.
# Docker CLI is needed for the sandbox_run tool: the app spawns sibling
# containers via the host Docker socket (mounted in docker-compose.yml).
# Without it, sandbox_run is auto-off in Docker (no docker binary inside).
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl sqlite3 docker.io && \
    rm -rf /var/lib/apt/lists/*
COPY --from=build /app/.next ./.next
# Next.js standalone server.js serves static files (CSS/JS/fonts) from
# __dirname/.next/static and __dirname/public. The standalone output does not
# include these, so copy them explicitly (official steps: cp -r .next/static .next/standalone/.next/)
COPY --from=build /app/.next/static ./.next/standalone/.next/static
COPY --from=build /app/public ./.next/standalone/public
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/.env.example ./.env.example
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", ".next/standalone/server.js"]
