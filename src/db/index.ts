import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const globalForDb = globalThis as unknown as {
  pool?: pg.Pool;
  db?: ReturnType<typeof drizzle<typeof schema>>;
};

const pool =
  globalForDb.pool ??
  new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://umans:umans@localhost:5432/umanschat",
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.pool = pool;
}

export const db = globalForDb.db ?? drizzle(pool, { schema });
if (process.env.NODE_ENV !== "production") {
  globalForDb.db = db;
}
