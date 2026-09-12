import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type {
  EventLevel,
  EventRecord,
  EventType,
  RemediationRecord,
  ServiceContract,
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function bool(v: unknown): boolean {
  return Number(v) === 1;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
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

        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
           max_remediations_per_hour, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

