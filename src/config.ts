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

  /** Deployment control plane used as the desired-state catalog. */
  deployUrl: string;
  /** Pull :4220 and reconcile contracts. */
  syncEnabled: boolean;
  /** Reconcile cadence in seconds. */
  syncIntervalSec: number;
  /** HTTP timeout for each catalog request. */
  syncTimeoutMs: number;
  /** Service IDs to supervise, or "*" for every eligible local service. */
  syncAllow: string[] | "*";
  /** Never supervise these IDs (always includes watchdog itself). */
  syncExclude: string[];
  /** Well-known control-plane IDs seeded only when the store is empty. */
  syncBootstrap: string[];
}

/** First-wave services to supervise until deploy grows a `supervise` flag. */
export const DEFAULT_SYNC_ALLOW = [
  "agent-control-plane",
  "service_registry",
  "agent-control-plane-deployment",
  "home-agent-brain",
  "home-agent-gateway",
] as const;

/** Chicken-egg set: enough to bring :4220 / :4240 back after reboot. */
export const DEFAULT_SYNC_BOOTSTRAP = [
  "agent-control-plane-deployment",
  "service_registry",
  "agent-control-plane",
] as const;

export const DEFAULT_SYNC_EXCLUDE = ["watchdog", "agent-watchdog"] as const;

export function expandHome(p: string): string {
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

/**
 * Comma-separated IDs. Unset → fallback. Empty → []. "*" → all.
 * `wildcard` enables the "*" token (used by the allowlist).
 */
export function parseIdList(
  raw: string | undefined,
  fallback: readonly string[],
  wildcard = false,
): string[] | "*" {
  if (raw === undefined) return [...fallback];
  const trimmed = raw.trim();
  if (wildcard && trimmed === "*") return "*";
  if (trimmed === "") return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
    host: process.env.WATCHDOG_HOST?.trim() || process.env.HOST || "127.0.0.1",
    // Prefer SERVICE_PORT (deploy/control-plane convention), then WATCHDOG_PORT,
    // then default 4230. Do not fall back to generic PORT — host env often has
    // PORT=4211 for web-cursor and would collide.
    port: envInt("SERVICE_PORT", envInt("WATCHDOG_PORT", 4230)),
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
    deployUrl: (
      process.env.WATCHDOG_DEPLOY_URL?.trim() || "http://127.0.0.1:4220"
    ).replace(/\/$/, ""),
    syncEnabled: envBool("WATCHDOG_SYNC", true),
    syncIntervalSec: Math.max(5, envInt("WATCHDOG_SYNC_INTERVAL_SEC", 30)),
    syncTimeoutMs: Math.max(500, envInt("WATCHDOG_SYNC_TIMEOUT_MS", 3000)),
    syncAllow: parseIdList(
      process.env.WATCHDOG_SYNC_ALLOW,
      DEFAULT_SYNC_ALLOW,
      true,
    ),
    syncExclude: [
      ...new Set([
        ...DEFAULT_SYNC_EXCLUDE,
        ...(parseIdList(process.env.WATCHDOG_SYNC_EXCLUDE, []) as string[]),
      ]),
    ],
    syncBootstrap: parseIdList(
      process.env.WATCHDOG_SYNC_BOOTSTRAP,
      DEFAULT_SYNC_BOOTSTRAP,
    ) as string[],
  };
}
