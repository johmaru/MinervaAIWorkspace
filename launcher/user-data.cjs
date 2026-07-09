const { existsSync, cpSync } = require("fs");
const { join } = require("path");

/**
 * Resolve the user data root directory from USERPROFILE or HOME.
 * Returns ~/.umans_chat_unofficial.
 */
function resolveUserDataRoot() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) throw new Error("Cannot determine user home directory");
  return join(home, ".umans_chat_unofficial");
}

/**
 * Migrate legacy appRoot/.env and appRoot/data to userDataRoot.
 * - .env: copied only if target absent
 * - data/: copied only if legacy umanschat.db exists and target umanschat.db absent
 * appRoot is left intact as a backup.
 */
function migrateLegacyData(appRoot, userDataRoot) {
  const legacyEnv = join(appRoot, ".env");
  const targetEnv = join(userDataRoot, ".env");
  if (existsSync(legacyEnv) && !existsSync(targetEnv)) {
    cpSync(legacyEnv, targetEnv, { force: true });
  }

  const legacyDb = join(appRoot, "data", "umanschat.db");
  const targetDb = join(userDataRoot, "data", "umanschat.db");
  if (existsSync(legacyDb) && !existsSync(targetDb)) {
    cpSync(join(appRoot, "data"), join(userDataRoot, "data"), {
      recursive: true,
      force: true,
    });
  }
}

/**
 * Resolve all data paths under userDataRoot.
 */
function resolveDataPaths(userDataRoot) {
  return {
    envPath: join(userDataRoot, ".env"),
    dataDir: join(userDataRoot, "data"),
    dbPath: join(userDataRoot, "data", "umanschat.db"),
    cloudflaredDir: join(userDataRoot, "data", "cloudflared"),
    updatesDir: join(userDataRoot, "data", "updates"),
    markerPath: join(userDataRoot, "data", ".update-pending"),
  };
}

module.exports = { resolveUserDataRoot, migrateLegacyData, resolveDataPaths };
