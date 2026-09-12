import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";

export interface PauseInfo {
  paused: boolean;
  reason: string | null;
  until: string | null;
  source: string | null;
}

interface Window {
  untilMs: number;
  reason: string;
}

/**
 * Central pause authority.
 *
 * Remediation must never race a deploy (rsync + restart) — that race is exactly
 * what produced EADDRINUSE / flapping in the old embedded watchdog. Pause
 * sources, in priority order:
 *
 *   1. in-memory global pause          (POST /api/pause)
 *   2. in-memory + on-disk per-service (POST /api/pause {serviceId})
 *   3. legacy deploy marker            (<legacyDeployDir>/<id>/ops/watchdog-pause-until)
 *
 * The legacy marker keeps us compatible with the existing deployment control
 * plane, which writes it for `web-cursor` during deploys.
 */
export class PauseController {
  private global: Window | null = null;
  private perService = new Map<string, Window>();

  constructor(private config: Config) {}

  private nowMs(): number {
    return Date.now();
  }

  pause(opts: { seconds: number; reason?: string; serviceId?: string }): PauseInfo {
    const seconds = Math.max(1, Math.floor(opts.seconds));
    const window: Window = {
      untilMs: this.nowMs() + seconds * 1000,
      reason: opts.reason?.trim() || "manual",
    };
    if (opts.serviceId) {
      this.perService.set(opts.serviceId, window);
      this.writeServiceFile(opts.serviceId, window);
    } else {
      this.global = window;
    }
    return this.info(opts.serviceId);
  }

  resume(serviceId?: string): void {
    if (serviceId) {
      this.perService.delete(serviceId);
      this.clearServiceFile(serviceId);
    } else {
      this.global = null;
      this.perService.clear();
      for (const id of this.serviceFileIds()) this.clearServiceFile(id);
    }
  }

  /** Is remediation currently suppressed for this service? */
  info(serviceId?: string): PauseInfo {
    const now = this.nowMs();

    if (serviceId) {
      const mem = this.perService.get(serviceId);
      if (mem) {
        if (mem.untilMs > now) return this.toInfo(mem, "service-memory");
        this.perService.delete(serviceId);
      }
      const file = this.readServiceFile(serviceId);
      if (file) return this.toInfo(file, "service-file");
      const legacy = this.readLegacyFile(serviceId);
      if (legacy) return this.toInfo(legacy, "legacy-deploy");
    }

    if (this.global && this.global.untilMs > now) {
      return this.toInfo(this.global, "global");
    }
    if (this.global && this.global.untilMs <= now) this.global = null;

    return { paused: false, reason: null, until: null, source: null };
  }

  isPaused(serviceId?: string): boolean {
    return this.info(serviceId).paused;
  }

  snapshot(): { global: PauseInfo; services: Record<string, PauseInfo> } {
    const services: Record<string, PauseInfo> = {};
    for (const id of this.serviceFileIds()) services[id] = this.info(id);
    for (const id of this.perService.keys()) services[id] = this.info(id);
    return { global: this.info(), services };
  }

  private toInfo(w: Window, source: string): PauseInfo {
    return {
      paused: true,
      reason: w.reason,
      until: new Date(w.untilMs).toISOString(),
      source,
    };
  }

  // ---- per-service pause files (<pauseDir>/<id>.until) --------------------

  private serviceFilePath(serviceId: string): string {
    return path.join(this.config.pauseDir, `${serviceId}.until`);
  }

  private writeServiceFile(serviceId: string, w: Window): void {
    try {
      fs.mkdirSync(this.config.pauseDir, { recursive: true });
      fs.writeFileSync(this.serviceFilePath(serviceId), `${Math.ceil(w.untilMs / 1000)}\n`);
    } catch {
      /* best effort */
    }
  }

  private clearServiceFile(serviceId: string): void {
    try {
      fs.unlinkSync(this.serviceFilePath(serviceId));
    } catch {
      /* ignore */
    }
  }

  private readServiceFile(serviceId: string): Window | null {
    return this.readUntilFile(this.serviceFilePath(serviceId), "external pause marker");
  }

  private serviceFileIds(): string[] {
    try {
      return fs
        .readdirSync(this.config.pauseDir)
        .filter((f) => f.endsWith(".until"))
        .map((f) => f.slice(0, -".until".length));
    } catch {
      return [];
    }
  }

  // ---- legacy deployment marker ------------------------------------------

  private legacyFilePath(serviceId: string): string {
    return path.join(
      this.config.legacyDeployDir,
      path.basename(serviceId),
      "ops",
      "watchdog-pause-until",
    );
  }

  private readLegacyFile(serviceId: string): Window | null {
    return this.readUntilFile(this.legacyFilePath(serviceId), "deploy window");
  }

  private readUntilFile(file: string, reason: string): Window | null {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8").trim();
    } catch {
      return null;
    }
    const secs = Number(raw);
    if (!Number.isFinite(secs) || secs <= 0) return null;
    const untilMs = secs * 1000;
    if (untilMs <= this.nowMs()) return null;
    return { untilMs, reason };
  }
}
