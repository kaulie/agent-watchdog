/**
 * Domain types for the independent watchdog service.
 *
 * Everything is registry-driven: a service contract fully describes how to
 * PROBE it and how to MAINTAIN (remediate) it. Adding a new monitored service
 * is a data change (one contract row), never a code change.
 */

export type ProbeType = "http" | "command";

/** What the watchdog is allowed to do when a service is down. */
export type RemediationAction = "start" | "restart" | "stop" | "none";

/** Health state of a monitored service. */
export type ServiceState = "unknown" | "up" | "down";

export type EventType =
  | "system"
  | "service_upsert"
  | "service_delete"
  | "probe"
  | "state_change"
  | "remediation"
  | "pause";

export type EventLevel = "info" | "warn" | "error";

/**
 * A monitored service. This is the single source of truth for both probing and
 * remediation behaviour.
 */
export interface ServiceContract {
  serviceId: string;
  name: string;
  /** When false the engine will not probe or remediate this service. */
  enabled: boolean;
  /** Free-form grouping / tag used for filtering and future policy hooks. */
  group: string;

  // ---- probing -----------------------------------------------------------
  probeType: ProbeType;
  /** HTTP URL when probeType=http; shell command when probeType=command. */
  probeTarget: string;
  probeTimeoutMs: number;
  /** Probe cadence in seconds. */
  intervalSec: number;
  /** Expected HTTP status for http probes (null = any 2xx/3xx is healthy). */
  expectStatus: number | null;
  /** Optional substring that must appear in the HTTP response body. */
  expectBodyContains: string | null;

  // ---- remediation -------------------------------------------------------
  remediation: RemediationAction;
  /** Working directory for remediation commands (usually the runtime dir). */
  runtimeDir: string | null;
  startCmd: string | null;
  restartCmd: string | null;
  stopCmd: string | null;

  // ---- policy ------------------------------------------------------------
  /** Consecutive failed probes before the service is declared DOWN. */
  failureThreshold: number;
  /** Consecutive successful probes before a DOWN service is declared UP. */
  successThreshold: number;
  /** Minimum seconds between two remediation actions for this service. */
  cooldownSec: number;
  /** Hard cap on remediation actions per rolling hour (backoff safety net). */
  maxRemediationsPerHour: number;

  createdAt: string;
  updatedAt: string;
}

/** Everything the engine knows at runtime about one service. */
export interface ServiceStatus {
  serviceId: string;
  state: ServiceState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastProbeAt: string | null;
  lastProbeOk: boolean | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  lastStateChangeAt: string | null;
  lastRemediationAt: string | null;
  remediationsLastHour: number;
  paused: boolean;
  pauseReason: string | null;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
  checkedAt: string;
}

export interface RemediationRecord {
  id: number;
  serviceId: string;
  action: RemediationAction;
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  /** Why the action ran: "threshold" | "manual" | "api". */
  trigger: string;
  output: string;
  createdAt: string;
}

export interface EventRecord {
  id: number;
  serviceId: string | null;
  type: EventType;
  level: EventLevel;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}
