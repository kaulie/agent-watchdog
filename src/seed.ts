import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome, type Config } from "./config.js";
import { buildContract, type ContractInput } from "./contract.js";
import type { Store } from "./db.js";
import { composeProbeTarget } from "./deploy.js";
import { log } from "./logger.js";

/**
 * Well-known control-plane services used only when the store is empty
 * (fresh install or wiped DB) so watchdog can start :4220 / :4240
 * before the first successful deploy sync.
 *
 * `agent-control-plane` lives in ~/runtime/web-cursor (historical path).
 */
export const BOOTSTRAP_CATALOG: Record<
  string,
  {
    name: string;
    port: number;
    healthUrl: string;
    runtimeDir: string;
  }
> = {
  "agent-control-plane-deployment": {
    name: "Agent Control Plane Deployment",
    port: 4220,
    healthUrl: "/health",
    runtimeDir: path.join(os.homedir(), "runtime", "agent-control-plane-deployment"),
  },
  service_registry: {
    name: "Service Registry",
    port: 4240,
    healthUrl: "/health",
    runtimeDir: path.join(os.homedir(), "runtime", "service-registry"),
  },
  "agent-control-plane": {
    name: "agent 交互界面",
    port: 4211,
    healthUrl: "/health",
    runtimeDir: path.join(os.homedir(), "runtime", "web-cursor"),
  },
};

const LEGACY_WEB_CURSOR_ID = "web-cursor";
const CANONICAL_CONTROL_PLANE_ID = "agent-control-plane";

/**
 * Migrate the old hardcoded `web-cursor` row, seed a minimal bootstrap
 * set when the store is empty, then optionally import WATCHDOG_SEED_FILE.
 */
export function seedDefaults(store: Store, config: Config): void {
  migrateLegacyWebCursor(store, config);
  seedBootstrapIfEmpty(store, config);
  if (config.extraSeedFile) {
    seedFromFile(store, config, config.extraSeedFile);
  }
}

export function migrateLegacyWebCursor(store: Store, config: Config): void {
  const legacy = store.getService(LEGACY_WEB_CURSOR_ID);
  if (!legacy) return;

  if (!store.getService(CANONICAL_CONTROL_PLANE_ID)) {
    const moved = buildContract(
      {
        serviceId: CANONICAL_CONTROL_PLANE_ID,
        name:
          legacy.name === "Web Cursor Agent Gateway"
            ? BOOTSTRAP_CATALOG[CANONICAL_CONTROL_PLANE_ID]!.name
            : legacy.name,
        source: "bootstrap",
        pinned: false,
        enabled: legacy.enabled,
      },
      config,
      { ...legacy, serviceId: CANONICAL_CONTROL_PLANE_ID },
    );
    store.upsertService(moved);
    store.appendEvent({
      serviceId: CANONICAL_CONTROL_PLANE_ID,
      type: "service_upsert",
      message: `migrated ${LEGACY_WEB_CURSOR_ID} → ${CANONICAL_CONTROL_PLANE_ID}`,
    });
    log.info(`migrated ${LEGACY_WEB_CURSOR_ID} → ${CANONICAL_CONTROL_PLANE_ID}`);
  }

  if (legacy.enabled) {
    store.upsertService({ ...legacy, enabled: false });
    store.appendEvent({
      serviceId: LEGACY_WEB_CURSOR_ID,
      type: "service_upsert",
      level: "warn",
      message: `disabled legacy ${LEGACY_WEB_CURSOR_ID} after id migration`,
    });
  }
}

export function seedBootstrapIfEmpty(store: Store, config: Config): void {
  if (store.listServices().length > 0) return;
  for (const id of config.syncBootstrap) {
    const def = BOOTSTRAP_CATALOG[id];
    if (!def) {
      log.warn(`bootstrap skipped unknown service ${id}`);
      continue;
    }
    const runtimeDir = expandHome(def.runtimeDir);
    const contract = buildContract(
      {
        serviceId: id,
        name: def.name,
        group: "apps",
        probeType: "http",
        probeTarget: composeProbeTarget(def.port, def.healthUrl),
        expectStatus: 200,
        remediation: "start",
        runtimeDir,
        startCmd: "bash scripts/start.sh",
        restartCmd: "bash scripts/restart.sh",
        stopCmd: "bash scripts/stop.sh",
        enabled: true,
        source: "bootstrap",
        pinned: false,
      },
      config,
    );
    store.upsertService(contract);
    store.appendEvent({
      serviceId: id,
      type: "service_upsert",
      message: `bootstrapped service ${id}`,
      data: { probeTarget: contract.probeTarget },
    });
    log.info(`bootstrapped service ${id} → ${contract.probeTarget}`);
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
      const contract = buildContract(
        { ...input, source: input.source ?? "manual" },
        config,
        existing,
      );
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
