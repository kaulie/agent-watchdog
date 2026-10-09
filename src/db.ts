import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type {
  ContractSource,
  EventLevel,
  EventRecord,
  EventType,
  RemediationRecord,
  ServiceContract,
  SyncState,
  ProbeResult,
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function bool(v: unknown): boolean {
  return Number(v) === 1;
}

export class Store {
  private db: DatabaseSync;

  close(): void {
    this.db.close();
  }

  recordProbe(serviceId: string, result: ProbeResult): void {
    this.db.prepare(`INSERT INTO health_checks
      (service_id, checked_at, ok, latency_ms, status, error) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(serviceId, Date.parse(result.checkedAt), result.ok ? 1 : 0,
        result.latencyMs, result.status ?? null, result.error ?? null);
  }

  pruneProbes(now = Date.now()): void {
    this.db.prepare('DELETE FROM health_checks WHERE checked_at < ?')
      .run(now - 30 * 86400000);
  }

  probeHistory(serviceId: string, from: number, to: number, before?: number) {
    const latest = this.db.prepare(`SELECT checked_at AS checkedAt, ok FROM health_checks
      WHERE service_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1`).get(serviceId) as
      {checkedAt: number; ok: number} | undefined;
    const width = (to - from) / 24;
    const groups = this.db.prepare(`SELECT CAST((checked_at - ?) / ? AS INTEGER) AS bucket,
      COUNT(*) AS total, SUM(ok) AS successful FROM health_checks
      WHERE service_id = ? AND checked_at >= ? AND checked_at < ? GROUP BY bucket`)
      .all(from, width, serviceId, from, to) as Array<{bucket: number; total: number; successful: number}>;
    const buckets = Array.from({length: 24}, (_, i) => {
      const group = groups.find(g => g.bucket === i);
      const total = Number(group?.total ?? 0), successful = Number(group?.successful ?? 0);
      return {from: from + i * width, to: from + (i + 1) * width, total, successful,
        availability: total ? successful / total * 100 : null};
    });
    const total = buckets.reduce((n, b) => n + b.total, 0);
    const successful = buckets.reduce((n, b) => n + b.successful, 0);
    const rows = this.db.prepare(`SELECT id, checked_at AS checkedAt, ok,
      latency_ms AS latencyMs, status, error FROM health_checks
      WHERE service_id = ? AND checked_at >= ? AND checked_at < ? AND id < ?
      ORDER BY id DESC LIMIT 101`).all(serviceId, from, to, before ?? Number.MAX_SAFE_INTEGER) as
      Array<{id: number; checkedAt: number; ok: number; latencyMs: number; status: number | null; error: string | null}>;
    const events = rows.slice(0, 100).map(r => ({...r, ok: r.ok === 1}));
    return {serviceId, from, to, latest: latest ? {...latest, ok: latest.ok === 1} : null,
      total, successful, availability: total ? successful / total * 100 : null,
      buckets, events, nextCursor: rows.length > 100 ? events.at(-1)!.id : null};
  }

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
    this.db.exec(`CREATE TABLE IF NOT EXISTS health_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, service_id TEXT NOT NULL,
      checked_at INTEGER NOT NULL, ok INTEGER NOT NULL, latency_ms INTEGER NOT NULL,
      status INTEGER, error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_checks_service_time ON health_checks(service_id, checked_at);
    CREATE INDEX IF NOT EXISTS idx_checks_time ON health_checks(checked_at);`);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS services (
        service_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        group_name TEXT NOT NULL DEFAULT 'default',

        probe_type TEXT NOT NULL DEFAULT 'http',
        probe_target TEXT NOT NULL,
        probe_timeout_ms INTEGER NOT NULL DEFAULT 3000,
        interval_sec INTEGER NOT NULL DEFAULT 10,
        expect_status INTEGER,
        expect_body_contains TEXT,

        remediation TEXT NOT NULL DEFAULT 'start',
        runtime_dir TEXT,
        start_cmd TEXT,
        restart_cmd TEXT,
        stop_cmd TEXT,

        failure_threshold INTEGER NOT NULL DEFAULT 3,
        success_threshold INTEGER NOT NULL DEFAULT 1,
        cooldown_sec INTEGER NOT NULL DEFAULT 60,
        max_remediations_per_hour INTEGER NOT NULL DEFAULT 6,

        source TEXT NOT NULL DEFAULT 'manual',
        pinned INTEGER NOT NULL DEFAULT 0,

        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_attempt_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        upstream_ok INTEGER NOT NULL DEFAULT 0,
        stale INTEGER NOT NULL DEFAULT 0,
        desired INTEGER NOT NULL DEFAULT 0,
        applied INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        skipped_pinned INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id TEXT,
        type TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
      CREATE INDEX IF NOT EXISTS idx_events_service ON events(service_id);

      CREATE TABLE IF NOT EXISTS remediations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id TEXT NOT NULL,
        action TEXT NOT NULL,
        command TEXT NOT NULL,
        ok INTEGER NOT NULL,
        exit_code INTEGER,
        duration_ms INTEGER NOT NULL,
        trigger TEXT NOT NULL,
        output TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_remediations_service ON remediations(service_id, created_at);
    `);
    this.addColumnIfMissing(
      "services",
      "source",
      "TEXT NOT NULL DEFAULT 'manual'",
    );
    this.addColumnIfMissing(
      "services",
      "pinned",
      "INTEGER NOT NULL DEFAULT 0",
    );
  }

  private addColumnIfMissing(
    table: string,
    column: string,
    decl: string,
  ): void {
    const rows = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (rows.some((r) => r.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  // ---- services ----------------------------------------------------------

  listServices(): ServiceContract[] {
    const rows = this.db
      .prepare(`SELECT * FROM services ORDER BY group_name, service_id`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapService);
  }

  getService(serviceId: string): ServiceContract | undefined {
    const row = this.db
      .prepare(`SELECT * FROM services WHERE service_id = ?`)
      .get(serviceId) as Record<string, unknown> | undefined;
    return row ? mapService(row) : undefined;
  }

  upsertService(input: ServiceContract): ServiceContract {
    const existing = this.getService(input.serviceId);
    const ts = nowIso();
    const row: ServiceContract = {
      ...input,
      createdAt: existing?.createdAt ?? input.createdAt ?? ts,
      updatedAt: ts,
    };
    this.db
      .prepare(
        `INSERT INTO services (
           service_id, name, enabled, group_name,
           probe_type, probe_target, probe_timeout_ms, interval_sec,
           expect_status, expect_body_contains,
           remediation, runtime_dir, start_cmd, restart_cmd, stop_cmd,
           failure_threshold, success_threshold, cooldown_sec,
           max_remediations_per_hour, source, pinned, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(service_id) DO UPDATE SET
           name = excluded.name,
           enabled = excluded.enabled,
           group_name = excluded.group_name,
           probe_type = excluded.probe_type,
           probe_target = excluded.probe_target,
           probe_timeout_ms = excluded.probe_timeout_ms,
           interval_sec = excluded.interval_sec,
           expect_status = excluded.expect_status,
           expect_body_contains = excluded.expect_body_contains,
           remediation = excluded.remediation,
           runtime_dir = excluded.runtime_dir,
           start_cmd = excluded.start_cmd,
           restart_cmd = excluded.restart_cmd,
           stop_cmd = excluded.stop_cmd,
           failure_threshold = excluded.failure_threshold,
           success_threshold = excluded.success_threshold,
           cooldown_sec = excluded.cooldown_sec,
           max_remediations_per_hour = excluded.max_remediations_per_hour,
           source = excluded.source,
           pinned = excluded.pinned,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.serviceId,
        row.name,
        row.enabled ? 1 : 0,
        row.group,
        row.probeType,
        row.probeTarget,
        row.probeTimeoutMs,
        row.intervalSec,
        row.expectStatus ?? null,
        row.expectBodyContains ?? null,
        row.remediation,
        row.runtimeDir ?? null,
        row.startCmd ?? null,
        row.restartCmd ?? null,
        row.stopCmd ?? null,
        row.failureThreshold,
        row.successThreshold,
        row.cooldownSec,
        row.maxRemediationsPerHour,
        row.source,
        row.pinned ? 1 : 0,
        row.createdAt,
        row.updatedAt,
      );
    return row;
  }

  deleteService(serviceId: string): boolean {
    const res = this.db
      .prepare(`DELETE FROM services WHERE service_id = ?`)
      .run(serviceId);
    return Number(res.changes) > 0;
  }

  // ---- events ------------------------------------------------------------

  appendEvent(input: {
    serviceId?: string | null;
    type: EventType;
    level?: EventLevel;
    message: string;
    data?: Record<string, unknown> | null;
  }): EventRecord {
    const ts = nowIso();
    const res = this.db
      .prepare(
        `INSERT INTO events (service_id, type, level, message, data_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.serviceId ?? null,
        input.type,
        input.level ?? "info",
        input.message,
        input.data ? JSON.stringify(input.data) : null,
        ts,
      );
    return {
      id: Number(res.lastInsertRowid),
      serviceId: input.serviceId ?? null,
      type: input.type,
      level: input.level ?? "info",
      message: input.message,
      data: input.data ?? null,
      createdAt: ts,
    };
  }

  listEvents(
    opts: { limit?: number; serviceId?: string; type?: string } = {},
  ): EventRecord[] {
    const limit = Math.min(1000, Math.max(1, opts.limit ?? 100));
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts.serviceId) {
      clauses.push("service_id = ?");
      params.push(opts.serviceId);
    }
    if (opts.type) {
      clauses.push("type = ?");
      params.push(opts.type);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      serviceId: r.service_id ? String(r.service_id) : null,
      type: String(r.type) as EventType,
      level: String(r.level) as EventLevel,
      message: String(r.message),
      data: r.data_json
        ? (JSON.parse(String(r.data_json)) as Record<string, unknown>)
        : null,
      createdAt: String(r.created_at),
    }));
  }

  pruneEvents(keep = 5000): number {
    const res = this.db
      .prepare(
        `DELETE FROM events WHERE id NOT IN (
           SELECT id FROM events ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(keep);
    return Number(res.changes);
  }

  // ---- remediations ------------------------------------------------------

  addRemediation(
    input: Omit<RemediationRecord, "id" | "createdAt">,
  ): RemediationRecord {
    const ts = nowIso();
    const res = this.db
      .prepare(
        `INSERT INTO remediations (
           service_id, action, command, ok, exit_code, duration_ms,
           trigger, output, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.serviceId,
        input.action,
        input.command,
        input.ok ? 1 : 0,
        input.exitCode ?? null,
        input.durationMs,
        input.trigger,
        input.output ?? null,
        ts,
      );
    return { ...input, id: Number(res.lastInsertRowid), createdAt: ts };
  }

  listRemediations(
    opts: { limit?: number; serviceId?: string } = {},
  ): RemediationRecord[] {
    const limit = Math.min(500, Math.max(1, opts.limit ?? 50));
    const where = opts.serviceId ? "WHERE service_id = ?" : "";
    const params = opts.serviceId ? [opts.serviceId] : [];
    const rows = this.db
      .prepare(`SELECT * FROM remediations ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      serviceId: String(r.service_id),
      action: String(r.action) as RemediationRecord["action"],
      command: String(r.command),
      ok: bool(r.ok),
      exitCode:
        r.exit_code === null || r.exit_code === undefined
          ? null
          : Number(r.exit_code),
      durationMs: Number(r.duration_ms),
      trigger: String(r.trigger),
      output: r.output ? String(r.output) : "",
      createdAt: String(r.created_at),
    }));
  }

  countRemediationsSince(serviceId: string, sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM remediations
          WHERE service_id = ? AND created_at >= ?`,
      )
      .get(serviceId, sinceIso) as { n: number } | undefined;
    return row ? Number(row.n) : 0;
  }

  lastRemediationAt(serviceId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT created_at FROM remediations
          WHERE service_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(serviceId) as { created_at: string } | undefined;
    return row ? String(row.created_at) : null;
  }

  stats(): {
    services: number;
    enabledServices: number;
    events: number;
    remediations: number;
  } {
    const one = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { n: number } | undefined;
      return row ? Number(row.n) : 0;
    };
    return {
      services: one("SELECT COUNT(*) AS n FROM services"),
      enabledServices: one("SELECT COUNT(*) AS n FROM services WHERE enabled = 1"),
      events: one("SELECT COUNT(*) AS n FROM events"),
      remediations: one("SELECT COUNT(*) AS n FROM remediations"),
    };
  }

  getSyncState(): SyncState {
    const row = this.db
      .prepare(`SELECT * FROM sync_state WHERE id = 1`)
      .get() as Record<string, unknown> | undefined;
    if (!row) {
      return {
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
        upstreamOk: false,
        stale: false,
        desired: 0,
        applied: 0,
        disabled: 0,
        skippedPinned: 0,
      };
    }
    return {
      lastAttemptAt: row.last_attempt_at ? String(row.last_attempt_at) : null,
      lastSuccessAt: row.last_success_at ? String(row.last_success_at) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      upstreamOk: bool(row.upstream_ok),
      stale: bool(row.stale),
      desired: Number(row.desired),
      applied: Number(row.applied),
      disabled: Number(row.disabled),
      skippedPinned: Number(row.skipped_pinned),
    };
  }

  putSyncState(state: SyncState): SyncState {
    this.db
      .prepare(
        `INSERT INTO sync_state (
           id, last_attempt_at, last_success_at, last_error,
           upstream_ok, stale, desired, applied, disabled, skipped_pinned
         ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           last_attempt_at = excluded.last_attempt_at,
           last_success_at = excluded.last_success_at,
           last_error = excluded.last_error,
           upstream_ok = excluded.upstream_ok,
           stale = excluded.stale,
           desired = excluded.desired,
           applied = excluded.applied,
           disabled = excluded.disabled,
           skipped_pinned = excluded.skipped_pinned`,
      )
      .run(
        state.lastAttemptAt,
        state.lastSuccessAt,
        state.lastError,
        state.upstreamOk ? 1 : 0,
        state.stale ? 1 : 0,
        state.desired,
        state.applied,
        state.disabled,
        state.skippedPinned,
      );
    return state;
  }
}

function mapService(r: Record<string, unknown>): ServiceContract {
  return {
    serviceId: String(r.service_id),
    name: String(r.name),
    enabled: bool(r.enabled),
    group: String(r.group_name),
    probeType: String(r.probe_type) as ServiceContract["probeType"],
    probeTarget: String(r.probe_target),
    probeTimeoutMs: Number(r.probe_timeout_ms),
    intervalSec: Number(r.interval_sec),
    expectStatus:
      r.expect_status === null || r.expect_status === undefined
        ? null
        : Number(r.expect_status),
    expectBodyContains: r.expect_body_contains
      ? String(r.expect_body_contains)
      : null,
    remediation: String(r.remediation) as ServiceContract["remediation"],
    runtimeDir: r.runtime_dir ? String(r.runtime_dir) : null,
    startCmd: r.start_cmd ? String(r.start_cmd) : null,
    restartCmd: r.restart_cmd ? String(r.restart_cmd) : null,
    stopCmd: r.stop_cmd ? String(r.stop_cmd) : null,
    failureThreshold: Number(r.failure_threshold),
    successThreshold: Number(r.success_threshold),
    cooldownSec: Number(r.cooldown_sec),
    maxRemediationsPerHour: Number(r.max_remediations_per_hour),
    source: (r.source ? String(r.source) : "manual") as ContractSource,
    pinned: bool(r.pinned),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
