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
# Install runtime dependencies + Docker CLI (official, not Debian's docker.io).
# Debian's docker.io is Docker 20.10 (API 1.41), which is rejected by recent
# Docker Desktop (API 1.44+). The official docker-ce-cli tracks the latest
# stable release and negotiates API version correctly with the host daemon.
# Only the CLI is needed — the app talks to the host daemon via the socket.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg sqlite3 && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc && \
    chmod a+r /etc/apt/keyrings/docker.asc && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends docker-ce-cli && \
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
