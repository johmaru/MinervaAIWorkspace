#!/bin/sh
set -e

# Sync .env with .env.example: append any new keys from example to .env.
# .env is volume-mounted, so this updates the host's .env too.
echo "[entrypoint] Syncing .env with .env.example..."
node --experimental-strip-types /app/scripts/sync-env.ts || {
  echo "[entrypoint] WARNING: env sync failed. Continuing with existing .env."
}
# Resolve DATABASE_URL to an absolute path so the standalone server
# (which calls process.chdir to /app/.next/standalone/) opens the same
# file that migrations wrote to. The app runtime and migrations must
# share one SQLite file regardless of CWD.
case "$DATABASE_URL" in
  /*) ;;  # already absolute — pass through
  *)
    # :memory:, empty, or relative → resolve against /app
    if [ -z "$DATABASE_URL" ] || [ "$DATABASE_URL" = ":memory:" ]; then
      export DATABASE_URL="/app/data/umanschat.db"
    else
      export DATABASE_URL="/app/$DATABASE_URL"
    fi
    ;;
esac
mkdir -p "$(dirname "$DATABASE_URL")"
# Remove stale WAL/SHM sidecars from the old WAL-mode setup. With
# journal_mode=DELETE these are unused; a leftover -shm (especially a
# truncated 3-byte one from bind-mount mmap corruption) can confuse the
# first open. Runs on every start; a no-op after the first restart.
DB_DIR="$(dirname "$DATABASE_URL")"
rm -f "$DB_DIR"/*.db-wal "$DB_DIR"/*.db-shm 2>/dev/null || true

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
