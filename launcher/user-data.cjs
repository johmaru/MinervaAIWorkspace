const { existsSync, cpSync, renameSync } = require("fs");
const { join } = require("path");

const USER_DATA_DIRNAME = ".minerva_ai_workspace";
const LEGACY_USER_DATA_DIRNAME = ".umans_chat_unofficial";
const DB_FILENAME = "minerva.db";
const LEGACY_DB_FILENAME = "umanschat.db";

/**
 * Resolve the user data root directory from USERPROFILE or HOME.
 * Returns ~/.minerva_ai_workspace (migrates from ~/.umans_chat_unofficial once).
 */
function resolveUserDataRoot() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) throw new Error("Cannot determine user home directory");
  const root = join(home, USER_DATA_DIRNAME);
  const legacyRoot = join(home, LEGACY_USER_DATA_DIRNAME);
  // One-shot: move old product user-data folder if the new one is absent.
  if (!existsSync(root) && existsSync(legacyRoot)) {
    try {
      renameSync(legacyRoot, root);
    } catch {
      // Cross-device rename can fail — fall back to recursive copy.
      cpSync(legacyRoot, root, { recursive: true, force: true });
    }
  }
  return root;
}

/**
 * If minerva.db is missing but umanschat.db exists in the same data dir, copy it.
 */
function migrateLegacyDbFile(dataDir) {
  const targetDb = join(dataDir, DB_FILENAME);
  const legacyDb = join(dataDir, LEGACY_DB_FILENAME);
  if (!existsSync(targetDb) && existsSync(legacyDb)) {
    cpSync(legacyDb, targetDb, { force: true });
  }
}

/**
 * Migrate legacy appRoot/.env and appRoot/data to userDataRoot.
 * - .env: copied only if target absent
 * - data/: copied only if legacy DB exists and target minerva.db absent
 *   (also accepts legacy umanschat.db as the source/target sentinel)
 * appRoot is left intact as a backup.
 */
function migrateLegacyData(appRoot, userDataRoot) {
  const legacyEnv = join(appRoot, ".env");
  const targetEnv = join(userDataRoot, ".env");
  if (existsSync(legacyEnv) && !existsSync(targetEnv)) {
    cpSync(legacyEnv, targetEnv, { force: true });
  }

  const legacyDataDir = join(appRoot, "data");
  const targetDataDir = join(userDataRoot, "data");
  const legacyHasDb =
    existsSync(join(legacyDataDir, DB_FILENAME)) ||
    existsSync(join(legacyDataDir, LEGACY_DB_FILENAME));
  const targetHasDb =
    existsSync(join(targetDataDir, DB_FILENAME)) ||
    existsSync(join(targetDataDir, LEGACY_DB_FILENAME));

  if (legacyHasDb && !targetHasDb) {
    cpSync(legacyDataDir, targetDataDir, {
      recursive: true,
      force: true,
    });
  }

  migrateLegacyDbFile(targetDataDir);
}

/**
 * Resolve all data paths under userDataRoot.
 */
function resolveDataPaths(userDataRoot) {
  const dataDir = join(userDataRoot, "data");
  migrateLegacyDbFile(dataDir);
  return {
    envPath: join(userDataRoot, ".env"),
    dataDir,
    dbPath: join(dataDir, DB_FILENAME),
    cloudflaredDir: join(dataDir, "cloudflared"),
    updatesDir: join(dataDir, "updates"),
    markerPath: join(dataDir, ".update-pending"),
  };
}

module.exports = {
  resolveUserDataRoot,
  migrateLegacyData,
  resolveDataPaths,
  migrateLegacyDbFile,
  USER_DATA_DIRNAME,
  LEGACY_USER_DATA_DIRNAME,
  DB_FILENAME,
  LEGACY_DB_FILENAME,
};
