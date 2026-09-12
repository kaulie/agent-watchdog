import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config.js";
import { buildContract, type ContractInput } from "./contract.js";
import type { Store } from "./db.js";
import { log } from "./logger.js";

/**
 * Seed the service registry.
 *
 * The task scope is "start with web-cursor only, but architect for many", so
 * exactly one contract is seeded by default. Additional services can be seeded
 * declaratively via WATCHDOG_SEED_FILE (a JSON array of partial contracts) —
 * no code change required.
 */
export function seedDefaults(store: Store, config: Config): void {
  if (!store.getService("web-cursor")) {
    const runtimeDir = path.join(os.homedir(), "runtime", "web-cursor");
    const contract = buildContract(
      {
        serviceId: "web-cursor",
        name: "Web Cursor Agent Gateway",
        group: "apps",
        probeType: "http",
        probeTarget: "http://127.0.0.1:4211/health",
        probeTimeoutMs: 3000,
        intervalSec: 10,
        expectStatus: 200,
        remediation: "start",
        runtimeDir,
        startCmd: `bash "${path.join(runtimeDir, "scripts", "start.sh")}"`,
        restartCmd: `bash "${path.join(runtimeDir, "scripts", "restart.sh")}"`,
        stopCmd: `bash "${path.join(runtimeDir, "scripts", "stop.sh")}"`,
        failureThreshold: 3,
        successThreshold: 1,
        cooldownSec: 60,
        maxRemediationsPerHour: 6,
      },
      config,
    );
    store.upsertService(contract);
    store.appendEvent({
      serviceId: contract.serviceId,
      type: "service_upsert",
      message: `seeded service ${contract.serviceId}`,
      data: { probeTarget: contract.probeTarget, intervalSec: contract.intervalSec },
    });
    log.info(`seeded service web-cursor → ${contract.probeTarget}`);
  }

  if (config.extraSeedFile) {
    seedFromFile(store, config, config.extraSeedFile);
  }
}

function seedFromFile(store: Store, config: Config, file: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    log.warn(`seed file not readable: ${file}`, err instanceof Error ? err.message : err);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(`seed file is not valid JSON: ${file}`, err instanceof Error ? err.message : err);
    return;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of list) {
    try {
      const input = item as ContractInput;
      const existing = input.serviceId
        ? store.getService(input.serviceId)
        : undefined;
      const contract = buildContract(input, config, existing);
      store.upsertService(contract);
      store.appendEvent({
        serviceId: contract.serviceId,
        type: "service_upsert",
        message: `seeded service ${contract.serviceId} from file`,
      });
      log.info(`seeded service ${contract.serviceId} from ${file}`);
    } catch (err) {
      log.warn(
        `skipping invalid seed entry in ${file}`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
