import path from "node:path";
import fs from "node:fs";
import os from "node:os";

export interface Config {
  /** Install / data root: ~/runtime/agent-watchdog */
  home: string;
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  logDir: string;
  /** Directory holding the per-service pause markers (<serviceId>.until). */
  pauseDir: string;

  /** Engine tick granularity in ms. */
  tickMs: number;

  // Defaults applied to freshly registered contracts.
  defaultIntervalSec: number;
  defaultTimeoutMs: number;
  defaultFailureThreshold: number;
  defaultSuccessThreshold: number;
  defaultCooldownSec: number;
  defaultMaxRemediationsPerHour: number;

  /** Max wall time for a remediation command (seconds). */
  remediationTimeoutSec: number;
  /** Persist every probe result as an event (noisy; default off). */
  recordAllProbes: boolean;

  /**
   * Legacy deploy-home root (default ~/deployment). The deployment control
   * plane writes <root>/<service>/ops/watchdog-pause-until during a deploy;
   * we honour it so watchdog never races rsync/restart.
   */
  legacyDeployDir: string;

  /** Extra services (JSON array of contracts) seeded on first boot. */
  extraSeedFile: string | null;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function loadConfig(): Config {
  const home = expandHome(
    process.env.WATCHDOG_HOME?.trim() ||
      path.join(os.homedir(), "runtime", "agent-watchdog"),
  );
  const dataDir = path.join(home, "data");
  const logDir = path.join(home, "logs");
  const pauseDir = path.join(dataDir, "pause");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(pauseDir, { recursive: true });

  return {
    home,
    // 只认 WATCHDOG_HOST/WATCHDOG_PORT：不回落到通用 HOST/PORT，避免继承宿主环境
    // （本机 env 里就有 HOST=0.0.0.0 / PORT=4211）而把无鉴权 API 暴露出去、
    // 或去抢被监控应用的端口。自启动 unit 里也显式写死了这两个值。
    host: process.env.WATCHDOG_HOST?.trim() || "127.0.0.1",
    port: envInt("WATCHDOG_PORT", 4230),
    dataDir,
    dbPath: path.join(dataDir, "watchdog.sqlite"),
    logDir,
    pauseDir,
    tickMs: Math.max(250, envInt("WATCHDOG_TICK_MS", 1000)),
    defaultIntervalSec: Math.max(2, envInt("WATCHDOG_DEFAULT_INTERVAL_SEC", 10)),
    defaultTimeoutMs: Math.max(500, envInt("WATCHDOG_DEFAULT_TIMEOUT_MS", 3000)),
    defaultFailureThreshold: Math.max(
      1,
      envInt("WATCHDOG_DEFAULT_FAILURE_THRESHOLD", 3),
    ),
    defaultSuccessThreshold: Math.max(
      1,
      envInt("WATCHDOG_DEFAULT_SUCCESS_THRESHOLD", 1),
    ),
    defaultCooldownSec: Math.max(0, envInt("WATCHDOG_DEFAULT_COOLDOWN_SEC", 60)),
    defaultMaxRemediationsPerHour: Math.max(
      1,
      envInt("WATCHDOG_DEFAULT_MAX_REMEDIATIONS_PER_HOUR", 6),
    ),
    remediationTimeoutSec: Math.max(
      5,
      envInt("WATCHDOG_REMEDIATION_TIMEOUT_SEC", 120),
    ),
    recordAllProbes: envBool("WATCHDOG_RECORD_PROBES", false),
    legacyDeployDir: expandHome(
      process.env.WATCHDOG_LEGACY_DEPLOY_DIR?.trim() ||
        path.join(os.homedir(), "deployment"),
    ),
    extraSeedFile: process.env.WATCHDOG_SEED_FILE?.trim() || null,
  };
}
