import { spawn } from "node:child_process";
import type { RemediationAction, ServiceContract } from "./types.js";

export interface RemediationResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

/** Watchdog's own listen-port identity. Must not leak into a child service. */
const SUPERVISOR_PORT_KEYS = ["PORT", "SERVICE_PORT", "WATCHDOG_PORT"] as const;

/**
 * Listen port from the deployment contract already stored on the service.
 * HTTP `probeTarget` is composed at sync/bootstrap as
 * `http://127.0.0.1:${catalog.port}${path}` — watchdog never invents a port.
 */
export function listenPortFromContract(svc: ServiceContract): number | null {
  if (svc.probeType !== "http") return null;
  try {
    const port = new URL(svc.probeTarget).port;
    if (!port) return null;
    const n = Number(port);
    if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
  } catch {
    /* not a URL */
  }
  return null;
}

/**
 * Child env for start/restart/stop. Inherit the supervisor process for PATH
 * and similar, but replace listen-port identity with the contract port.
 */
export function remediationEnv(
  svc: ServiceContract,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of SUPERVISOR_PORT_KEYS) {
    delete env[key];
  }
  const port = listenPortFromContract(svc);
  if (port != null) {
    const value = String(port);
    env.PORT = value;
    env.SERVICE_PORT = value;
  }
  env.WATCHDOG_SERVICE_ID = svc.serviceId;
  if (svc.runtimeDir) env.RUNTIME_DIR = svc.runtimeDir;
  return env;
}

/** Resolve the shell command that implements an action for a contract. */
export function commandFor(
  svc: ServiceContract,
  action: RemediationAction,
): string | null {
  switch (action) {
    case "start":
      return svc.startCmd;
    case "restart":
      return svc.restartCmd ?? svc.startCmd;
    case "stop":
      return svc.stopCmd;
    case "none":
      return null;
  }
}

/**
 * Run a remediation command detached in its own process group so a timeout can
 * kill the whole tree (start.sh spawns a supervisor + node). Always resolves.
 */
export function runRemediation(
  svc: ServiceContract,
  action: RemediationAction,
  opts: { timeoutSec?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RemediationResult> {
  const command = commandFor(svc, action);
  const timeoutSec = opts.timeoutSec ?? 120;
  if (!command) {
    return Promise.resolve({
      ok: false,
      command: "",
      exitCode: null,
      durationMs: 0,
      output: `no command configured for action "${action}"`,
    });
  }

  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: svc.runtimeDir ?? process.cwd(),
      env: remediationEnv(svc, opts.env ?? {}),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let output = "";
    const append = (b: Buffer) => {
      output += b.toString("utf8");
      if (output.length > 20000) output = output.slice(-20000);
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

    const finish = (ok: boolean, exitCode: number | null, note?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok,
        command,
        exitCode,
        durationMs: Date.now() - started,
        output: note ? `${output}\n${note}`.trim() : output,
      });
    };

    const timer = setTimeout(() => {
      killTree();
      finish(false, 124, `timeout after ${timeoutSec}s`);
    }, timeoutSec * 1000);

    child.on("error", (err) => finish(false, 1, err.message));
    child.on("close", (code) => finish(code === 0, code ?? 1));
  });
}
