import { spawn } from "node:child_process";
import type { ProbeResult, ServiceContract } from "./types.js";

/**
 * Probe adapters. Each probe answers one question: "is this service healthy
 * right now?" and always resolves (never throws) so the engine can rely on it.
 */

export interface ProbeContext {
  /** Overridable clock, mainly for tests. */
  now?: () => Date;
  /** Overridable fetch, mainly for tests. */
  fetchImpl?: typeof fetch;
}

function iso(ctx: ProbeContext): string {
  return (ctx.now?.() ?? new Date()).toISOString();
}

export async function runProbe(
  svc: ServiceContract,
  ctx: ProbeContext = {},
): Promise<ProbeResult> {
  if (svc.probeType === "command") {
    return commandProbe(svc, ctx);
  }
  return httpProbe(svc, ctx);
}

async function httpProbe(
  svc: ServiceContract,
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const checkedAt = iso(ctx);
  const started = Date.now();
  const doFetch = ctx.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), svc.probeTimeoutMs);
  try {
    const res = await doFetch(svc.probeTarget, {
      signal: controller.signal,
      cache: "no-store",
      redirect: "manual",
    });
    const latencyMs = Date.now() - started;
    const expected = svc.expectStatus;
    const statusOk = expected == null ? res.status < 400 : res.status === expected;
    let bodyOk = true;
    let bodyText = "";
    if (statusOk && svc.expectBodyContains) {
      bodyText = await res.text().catch(() => "");
      bodyOk = bodyText.includes(svc.expectBodyContains);
    }
    if (!statusOk) {
      return {
        ok: false,
        latencyMs,
        status: res.status,
        error: `unexpected status ${res.status}${
          expected != null ? ` (expect ${expected})` : ""
        }`,
        checkedAt,
      };
    }
    if (!bodyOk) {
      return {
        ok: false,
        latencyMs,
        status: res.status,
        error: `body missing "${svc.expectBodyContains}"`,
        checkedAt,
      };
    }
    return { ok: true, latencyMs, status: res.status, checkedAt };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      checkedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

function commandProbe(
  svc: ServiceContract,
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const checkedAt = iso(ctx);
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn("/bin/bash", ["-lc", svc.probeTarget], {
      cwd: svc.runtimeDir ?? process.cwd(),
      env: { ...process.env, WATCHDOG_SERVICE_ID: svc.serviceId },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    const append = (b: Buffer) => {
      output += b.toString("utf8");
      if (output.length > 8000) output = output.slice(-8000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const killTree = () => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree();
      resolve({
        ok: false,
        latencyMs: Date.now() - started,
        error: `probe timed out after ${svc.probeTimeoutMs}ms`,
        checkedAt,
      });
    }, svc.probeTimeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        latencyMs: Date.now() - started,
        error: err.message,
        checkedAt,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      if (code === 0) {
        resolve({ ok: true, latencyMs, checkedAt });
      } else {
        resolve({
          ok: false,
          latencyMs,
          error: `command exited ${code ?? 1}: ${output.trim().slice(-300)}`,
          checkedAt,
        });
      }
    });
  });
}
