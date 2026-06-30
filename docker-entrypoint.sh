#!/bin/sh
set -e

# Sync .env with .env.example: append any new keys from example to .env.
# .env is volume-mounted, so this updates the host's .env too.
echo "[entrypoint] Syncing .env with .env.example..."
node --experimental-strip-types /app/scripts/sync-env.ts || {
  echo "[entrypoint] WARNING: env sync failed. Continuing with existing .env."
}

# Run database migrations (creates all tables + indexes).
# drizzle-kit migrate reads drizzle.config.ts which uses DATABASE_URL from env.
# The SQLite migration (0000_dusty_invaders.sql) creates all tables.
echo "[entrypoint] Running database migrations..."
npx drizzle-kit migrate || {
  echo "[entrypoint] WARNING: Migration failed. The app will start anyway."
  echo "[entrypoint] If this is a fresh database, tables may be missing."
}
echo "[entrypoint] Migrations complete."

exec "$@"
