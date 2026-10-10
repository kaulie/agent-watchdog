import type { Config } from "./config.js";
import { buildContract } from "./contract.js";
import type { Store } from "./db.js";
import {
  fetchDeployCatalog,
  selectDesired,
  type CatalogFetchResult,
  type DesiredContract,
  type SkippedService,
} from "./deploy.js";
import { log } from "./logger.js";
import type { ServiceContract, SyncState } from "./types.js";

export type SyncTrigger = "startup" | "timer" | "api";

export type CatalogFetcher = (opts: {
  deployUrl: string;
  timeoutMs: number;
}) => Promise<CatalogFetchResult>;

export interface SyncReport extends SyncState {
  skipped: SkippedService[];
}

/**
 * Pull desired contracts from the deploy control plane and upsert them.
 *
 * Policy fields (interval / thresholds / cooldown) on an existing row are
 * kept. Catalog fields (probe, cmds, runtimeDir, enabled) are overwritten
 * unless the row is pinned.
 */
export class SyncReconciler {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<SyncReport> | null = null;

  constructor(
    private store: Store,
    private config: Config,
    private fetchCatalog: CatalogFetcher = fetchDeployCatalog,
  ) {}

  start(): void {
    if (this.timer) return;
    if (!this.config.syncEnabled) {
      log.info("deploy sync disabled (WATCHDOG_SYNC)");
      return;
    }
    void this.reconcile("startup");
    const everyMs = this.config.syncIntervalSec * 1000;
    this.timer = setInterval(() => {
      void this.reconcile("timer").catch((err) =>
        log.error("sync tick failed", err instanceof Error ? err.message : err),
      );
    }, everyMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  status(): SyncReport {
    return { ...this.store.getSyncState(), skipped: [] };
  }

  async reconcile(trigger: SyncTrigger): Promise<SyncReport> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run(trigger).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(trigger: SyncTrigger): Promise<SyncReport> {
    const attemptAt = new Date().toISOString();
    const prev = this.store.getSyncState();
    if (!this.config.syncEnabled) {
      const report: SyncReport = {
        ...prev,
        lastAttemptAt: attemptAt,
        lastError: "sync disabled",
        upstreamOk: false,
        skipped: [],
      };
      this.store.putSyncState(report);
      return report;
    }

    const fetched = await this.fetchCatalog({
      deployUrl: this.config.deployUrl,
      timeoutMs: this.config.syncTimeoutMs,
    });
    if (!fetched.ok) {
      const report: SyncReport = {
        ...prev,
        lastAttemptAt: attemptAt,
        lastError: fetched.error,
        upstreamOk: false,
        stale: true,
        skipped: [],
      };
      this.store.putSyncState(report);
      this.store.appendEvent({
        type: "sync",
        level: "warn",
        message: `deploy sync failed (${trigger}): ${fetched.error}`,
        data: { trigger, error: fetched.error },
      });
      log.warn(`deploy sync failed (${trigger})`, fetched.error);
      return report;
    }

    const { desired, skipped } = selectDesired(fetched.catalog, {
      allow: this.config.syncAllow,
      exclude: this.config.syncExclude,
    });
    const desiredIds = new Set(desired.map((d) => d.serviceId));
    let applied = 0;
    let skippedPinned = 0;
    let disabled = 0;

    for (const item of desired) {
      const existing = this.store.getService(item.serviceId);
      if (existing?.pinned) {
        skippedPinned += 1;
        continue;
      }
      const next = mergeDesired(item, existing, this.config);
      this.store.upsertService(next);
      applied += 1;
    }

    for (const svc of this.store.listServices()) {
      if (svc.pinned) continue;
      if (svc.source !== "deploy-sync" && svc.source !== "bootstrap") continue;
      if (desiredIds.has(svc.serviceId)) continue;
      if (!svc.enabled) continue;
      this.store.upsertService({ ...svc, enabled: false });
      disabled += 1;
      this.store.appendEvent({
        serviceId: svc.serviceId,
        type: "sync",
        level: "info",
        message: `disabled ${svc.serviceId}: no longer in deploy desired set`,
      });
    }

    const report: SyncReport = {
      lastAttemptAt: attemptAt,
      lastSuccessAt: attemptAt,
      lastError: null,
      upstreamOk: true,
      stale: false,
      desired: desired.length,
      applied,
      disabled,
      skippedPinned,
      skipped,
    };
    this.store.putSyncState(report);
    this.store.appendEvent({
      type: "sync",
      level: "info",
      message: `deploy sync ok (${trigger}): desired=${desired.length} applied=${applied} disabled=${disabled}`,
      data: {
        trigger,
        desired: desired.map((d) => d.serviceId),
        skippedPinned,
        disabled,
      },
    });
    log.info(
      `deploy sync ok (${trigger}) desired=${desired.length} applied=${applied} disabled=${disabled}`,
    );
    return report;
  }
}

export function mergeDesired(
  desired: DesiredContract,
  existing: ServiceContract | undefined,
  config: Config,
): ServiceContract {
  return buildContract(
    {
      serviceId: desired.serviceId,
      name: desired.name,
      group: existing?.group ?? "apps",
      probeType: "http",
      probeTarget: desired.probeTarget,
      expectStatus: existing ? undefined : 200,
      remediation: existing ? undefined : "start",
      runtimeDir: desired.runtimeDir,
      startCmd: desired.startCmd,
      restartCmd: desired.restartCmd,
      stopCmd: desired.stopCmd,
      enabled: true,
      source: "deploy-sync",
      pinned: false,
      ...(desired.intervalSec !== undefined ? { intervalSec: desired.intervalSec } : {}),
    },
    config,
    existing,
  );
}
