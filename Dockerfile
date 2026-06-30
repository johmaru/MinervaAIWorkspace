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
# better-sqlite3 のネイティブバイナリを Node 用にリビルド（deps ステージは Bun でインストールしたため）
RUN npm rebuild better-sqlite3
RUN DATABASE_URL=":memory:" NODE_OPTIONS="--max-old-space-size=3072" npx next build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# Docker CLI + Compose v2（Tor コンテナの起動/停止用。ホストの docker.sock をマウントして使用）
# node:22-slim (Debian Bookworm) は docker-cli を公式リポジトリに持たないため、
# Docker の apt ソースを追加してインストールする。
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc && \
    chmod a+r /etc/apt/keyrings/docker.asc && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends docker-ce-cli && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /usr/local/lib/docker/cli-plugins && \
    curl -fsSL https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64 \
      -o /usr/local/lib/docker/cli-plugins/docker-compose && \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
COPY --from=build /app/.next ./.next
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
