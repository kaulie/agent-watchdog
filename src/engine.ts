import type { Config } from "./config.js";
import type { Store } from "./db.js";
import { runProbe } from "./health.js";
import { log } from "./logger.js";
import type { PauseController } from "./pause.js";
import {
  commandFor,
  runRemediation,
  type RemediationResult,
} from "./remediation.js";
import type {
  ProbeResult,
  RemediationAction,
  ServiceContract,
  ServiceStatus,
  ServiceState,
} from "./types.js";

export interface EngineDeps {
  probe?: (svc: ServiceContract) => Promise<ProbeResult>;
  remediate?: (
    svc: ServiceContract,
    action: RemediationAction,
    ctx: { timeoutSec: number },
  ) => Promise<RemediationResult>;
  now?: () => number;
}

const HOUR_MS = 60 * 60 * 1000;

function emptyStatus(serviceId: string): ServiceStatus {
  return {
    serviceId,
    state: "unknown",
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastProbeAt: null,
    lastProbeOk: null,
    lastLatencyMs: null,
    lastError: null,
    lastStateChangeAt: null,
    lastRemediationAt: null,
    remediationsLastHour: 0,
    paused: false,
    pauseReason: null,
  };
}

/**
 * The monitor engine.
 *
 * For every enabled service it (1) probes on a fixed cadence, (2) drives a
 * small per-service state machine (unknown → up/down with hysteresis through
 * consecutive success/failure thresholds) and (3) remediates DOWN services
 * through their contract commands, guarded by pause windows, cooldown and an
 * hourly rate limit so a broken service can never be restart-hammered.
 *
 * The engine is pure orchestration over injected `probe` / `remediate` fns, so
 * it is fully unit-testable without spawning real processes.
 */
export class MonitorEngine {
  private statuses = new Map<string, ServiceStatus>();
  private nextProbeAt = new Map<string, number>();
  private inFlight = new Set<string>();
  private pendingRemediation = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private tickCount = 0;

  constructor(
    private store: Store,
    private config: Config,
    private pause: PauseController,
    private deps: EngineDeps = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) =>
        log.error("tick failed", err instanceof Error ? err.message : err),
      );
    }, this.config.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Probe on cadence and remediate as needed. Never throws. */
  async tick(): Promise<void> {
    const now = this.now();
    const services = this.store.listServices();
    const seen = new Set<string>();

    for (const svc of services) {
      seen.add(svc.serviceId);
      if (!svc.enabled) continue;
      if ((this.nextProbeAt.get(svc.serviceId) ?? 0) > now) continue;
      if (this.inFlight.has(svc.serviceId)) continue;
      this.nextProbeAt.set(svc.serviceId, now + svc.intervalSec * 1000);
      this.inFlight.add(svc.serviceId);
      try {
        await this.probeAndEvaluate(svc, true);
      } finally {
        this.inFlight.delete(svc.serviceId);
      }
    }

    // Drop runtime state for deleted services.
    for (const id of [...this.statuses.keys()]) {
      if (!seen.has(id)) {
        this.statuses.delete(id);
        this.nextProbeAt.delete(id);
      }
    }

    if (++this.tickCount % 300 === 0) {
      try {
        this.store.pruneEvents(5000);
      } catch {
        /* ignore */
      }
    }
  }

  /** Run one probe now and update state; used by tick() and manual triggers. */
  async probeAndEvaluate(
    svc: ServiceContract,
    allowRemediation: boolean,
  ): Promise<ServiceStatus> {
    const status = this.ensureStatus(svc.serviceId);
    const probe = this.deps.probe ?? ((s: ServiceContract) => runProbe(s));
    const result = await probe(svc);

    status.lastProbeAt = result.checkedAt;
    status.lastProbeOk = result.ok;
    status.lastLatencyMs = result.latencyMs;
    status.lastError = result.ok ? null : result.error ?? "probe failed";

    if (result.ok) {
      status.consecutiveSuccesses += 1;
      status.consecutiveFailures = 0;
      if (
        status.state !== "up" &&
        status.consecutiveSuccesses >= svc.successThreshold
      ) {
        await this.transition(svc, status, "up", "probe recovered");
      }
    } else {
      status.consecutiveFailures += 1;
      status.consecutiveSuccesses = 0;
      if (
        status.state !== "down" &&
        status.consecutiveFailures >= svc.failureThreshold
      ) {
        await this.transition(svc, status, "down", result.error ?? "probe failed");
        if (allowRemediation) {
          await this.maybeRemediate(svc, status, "threshold");
        }
      }
    }

    if (this.config.recordAllProbes) {
      this.store.appendEvent({
        serviceId: svc.serviceId,
        type: "probe",
        level: result.ok ? "info" : "warn",
        message: `${svc.serviceId} probe ${result.ok ? "ok" : "failed"} (${result.latencyMs}ms)`,
        data: {
          ok: result.ok,
          status: result.status ?? null,
          error: result.error ?? null,
          latencyMs: result.latencyMs,
        },
      });
    }

    return this.refreshPause(svc, status);
  }

  private async transition(
    svc: ServiceContract,
    status: ServiceStatus,
    to: ServiceState,
    reason: string,
  ): Promise<void> {
    const from = status.state;
    status.state = to;
    status.lastStateChangeAt = new Date(this.now()).toISOString();
    log.warn(`state ${svc.serviceId}: ${from} → ${to} (${reason})`);
    this.store.appendEvent({
      serviceId: svc.serviceId,
      type: "state_change",
      level: to === "down" ? "error" : "info",
      message: `${svc.serviceId} ${from} → ${to}`,
      data: { from, to, reason, latencyMs: status.lastLatencyMs },
    });
  }

  async maybeRemediate(
    svc: ServiceContract,
    status: ServiceStatus,
    trigger: string,
  ): Promise<RemediationResult | null> {
    if (svc.remediation === "none") return null;

    const paused = this.pause.info(svc.serviceId);
    if (paused.paused) {
      this.store.appendEvent({
        serviceId: svc.serviceId,
        type: "pause",
        level: "info",
        message: `${svc.serviceId} DOWN but paused (${paused.source}) — skip remediation`,
        data: { ...paused },
      });
      return null;
    }

    const now = this.now();
    const lastAt = status.lastRemediationAt
      ? Date.parse(status.lastRemediationAt)
      : 0;
    if (svc.cooldownSec > 0 && now - lastAt < svc.cooldownSec * 1000) {
      const wait = Math.ceil(
        (svc.cooldownSec * 1000 - (now - lastAt)) / 1000,
      );
      this.store.appendEvent({
        serviceId: svc.serviceId,
        type: "remediation",
        level: "warn",
        message: `${svc.serviceId} DOWN — cooldown active, retry in ${wait}s`,
        data: { cooldownSec: svc.cooldownSec, remainingSec: wait },
      });
      return null;
    }

    const used = this.store.countRemediationsSince(
      svc.serviceId,
      new Date(now - HOUR_MS).toISOString(),
    );
    if (used >= svc.maxRemediationsPerHour) {
      this.store.appendEvent({
        serviceId: svc.serviceId,
        type: "remediation",
        level: "error",
        message: `${svc.serviceId} remediation rate limit hit (${used}/${svc.maxRemediationsPerHour} per hour) — backing off`,
        data: { used, limit: svc.maxRemediationsPerHour },
      });
      return null;
    }

    return this.runRemediationFor(svc, svc.remediation, trigger);
  }

  async runRemediationFor(
    svc: ServiceContract,
    action: RemediationAction,
    trigger: string,
  ): Promise<RemediationResult | null> {
    const status = this.ensureStatus(svc.serviceId);
    const command = commandFor(svc, action);
    if (!command) {
      log.warn(`${svc.serviceId}: no ${action} command configured`);
      return null;
    }

    const guardKey = `${svc.serviceId}:${action}`;
    if (this.pendingRemediation.has(guardKey)) return null;
    this.pendingRemediation.add(guardKey);

    this.store.appendEvent({
      serviceId: svc.serviceId,
      type: "remediation",
      level: "warn",
      message: `${svc.serviceId} running ${action} (${trigger})`,
      data: { action, command, trigger },
    });

    const doRemediate =
      this.deps.remediate ??
      ((s: ServiceContract, a: RemediationAction, c: { timeoutSec: number }) =>
        runRemediation(s, a, { timeoutSec: c.timeoutSec }));

    let result: RemediationResult;
    try {
      result = await doRemediate(svc, action, {
        timeoutSec: this.config.remediationTimeoutSec,
      });
    } catch (err) {
      result = {
        ok: false,
        command,
        exitCode: null,
        durationMs: 0,
        output: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.pendingRemediation.delete(guardKey);
    }

    const record = this.store.addRemediation({
      serviceId: svc.serviceId,
      action,
      command: result.command || command,
      ok: result.ok,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      trigger,
      output: result.output.slice(-8000),
    });
    status.lastRemediationAt = record.createdAt;
    status.remediationsLastHour = this.store.countRemediationsSince(
      svc.serviceId,
      new Date(this.now() - HOUR_MS).toISOString(),
    );

    this.store.appendEvent({
      serviceId: svc.serviceId,
      type: "remediation",
      level: result.ok ? "info" : "error",
      message: `${svc.serviceId} ${action} ${result.ok ? "ok" : "FAILED"} (${result.durationMs}ms, exit=${result.exitCode})`,
      data: { action, ok: result.ok, exitCode: result.exitCode },
    });

    log.warn(
      `remediation ${svc.serviceId} ${action} ${result.ok ? "ok" : "failed"} exit=${result.exitCode}`,
    );
    return result;
  }

  // ---- read API ----------------------------------------------------------

  ensureStatus(serviceId: string): ServiceStatus {
    let status = this.statuses.get(serviceId);
    if (!status) {
      status = emptyStatus(serviceId);
      this.statuses.set(serviceId, status);
    }
    return status;
  }

  private refreshPause(
    svc: ServiceContract,
    status: ServiceStatus,
  ): ServiceStatus {
    const info = this.pause.info(svc.serviceId);
    status.paused = info.paused;
    status.pauseReason = info.reason;
    status.remediationsLastHour = this.store.countRemediationsSince(
      svc.serviceId,
      new Date(this.now() - HOUR_MS).toISOString(),
    );
    return status;
  }

  getStatus(serviceId: string): ServiceStatus | undefined {
    const svc = this.store.getService(serviceId);
    if (!svc) return undefined;
    return this.refreshPause(svc, this.ensureStatus(serviceId));
  }

  getStatuses(): ServiceStatus[] {
    return this.store
      .listServices()
      .map((svc) => this.refreshPause(svc, this.ensureStatus(svc.serviceId)));
  }

  /** Force an immediate probe (optionally remediating) outside the cadence. */
  async probeNow(
    serviceId: string,
    allowRemediation = false,
  ): Promise<ServiceStatus | undefined> {
    const svc = this.store.getService(serviceId);
    if (!svc) return undefined;
    return this.probeAndEvaluate(svc, allowRemediation);
  }

  /** Manual remediation (API/CLI). Runs regardless of current health state. */
  async remediateNow(
    serviceId: string,
    action?: RemediationAction,
  ): Promise<
    { status: ServiceStatus; remediation: RemediationResult | null } | undefined
  > {
    const svc = this.store.getService(serviceId);
    if (!svc) return undefined;
    const chosen = action ?? (svc.remediation === "none" ? "restart" : svc.remediation);
    const remediation = await this.runRemediationFor(svc, chosen, "manual");
    const status = this.ensureStatus(serviceId);
    return { status: this.refreshPause(svc, status), remediation };
  }
}
