import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

/**
 * アプリ全体で共有する Drizzle DB インスタンスの型。
 * `ReturnType<typeof drizzle<typeof schema>>` を広げず、明示的な名前で公開する。
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const globalForDb = globalThis as unknown as {
  pool?: pg.Pool;
  db?: Db;
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

export const db: Db = globalForDb.db ?? drizzle(pool, { schema });
if (process.env.NODE_ENV !== "production") {
  globalForDb.db = db;
}
