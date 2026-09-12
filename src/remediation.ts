import { spawn } from "node:child_process";
import type { RemediationAction, ServiceContract } from "./types.js";

export interface RemediationResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
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
      env: {
        ...process.env,
        ...(opts.env ?? {}),
        WATCHDOG_SERVICE_ID: svc.serviceId,
        ...(svc.runtimeDir ? { RUNTIME_DIR: svc.runtimeDir } : {}),
      },
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
