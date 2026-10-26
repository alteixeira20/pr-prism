import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Returns the repository/package root directory by resolving three levels
 * up from this file's directory (src/cli/shared or dist/cli/shared).
 */
export function getPackageRoot(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return resolve(dir, "../../..");
}

/**
 * Returns the data directory in the current working directory.
 */
export function getDataDir(): string {
  return resolve(process.cwd(), "data");
}

/**
 * Returns the primary SQLite database path in data/prism.db.
 */
export function getDatabasePath(): string {
  return resolve(getDataDir(), "prism.db");
}
