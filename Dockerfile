FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
RUN rm -rf node_modules/@xenova/transformers/node_modules/sharp

FROM oven/bun:1.3 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN NODE_OPTIONS="--max-old-space-size=3072" bun run build

FROM oven/bun:1.3 AS runner
WORKDIR /app
ENV NODE_ENV=production
# Docker CLI + Compose v2（Tor コンテナの起動/停止用。ホストの docker.sock をマウントして使用）
RUN apt-get update && \
    apt-get install -y --no-install-recommends docker-cli curl ca-certificates && \
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
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
EXPOSE 3000
RUN chmod +x /app/docker-entrypoint.sh
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["bun", "run", "start"]
