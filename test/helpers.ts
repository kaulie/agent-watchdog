import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import { Store } from "../src/db.js";

/**
 * Create an isolated config rooted in a fresh temp dir and point the env at it
 * so loadConfig() (and anything reading env) stays self-contained per test.
 */
export function tmpConfig(prefix = "watchdog-test-"): Config {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.WATCHDOG_HOME = dir;
  process.env.WATCHDOG_LEGACY_DEPLOY_DIR = path.join(dir, "deployment");
  delete process.env.WATCHDOG_SEED_FILE;
  return loadConfig();
}

export function tmpStore(config: Config): Store {
  return new Store(config.dbPath);
}
