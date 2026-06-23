#!/bin/sh
set -e

# Run database migrations (creates pgvector extension + all tables + indexes).
# drizzle-kit migrate reads drizzle.config.ts which uses DATABASE_URL from env.
# The first migration (0000_colossal_moondragon.sql) includes CREATE EXTENSION IF NOT EXISTS vector.
echo "[entrypoint] Running database migrations..."
bunx drizzle-kit migrate || {
  echo "[entrypoint] WARNING: Migration failed. The app will start anyway."
  echo "[entrypoint] If this is a fresh database, tables may be missing."
}
echo "[entrypoint] Migrations complete."

exec "$@"
