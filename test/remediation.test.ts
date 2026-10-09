import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContract } from "../src/contract.js";
import {
  listenPortFromContract,
  remediationEnv,
  runRemediation,
} from "../src/remediation.js";
import { tmpConfig } from "./helpers.js";

const PORT_KEYS = ["PORT", "SERVICE_PORT", "WATCHDOG_PORT"] as const;

function withPortEnv<T>(
  values: Partial<Record<(typeof PORT_KEYS)[number], string | undefined>>,
  fn: () => T,
): T {
  const prev: Record<string, string | undefined> = {};
  for (const key of PORT_KEYS) prev[key] = process.env[key];
  for (const key of PORT_KEYS) {
    const v = values[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  try {
    return fn();
  } finally {
    for (const key of PORT_KEYS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

test("listenPortFromContract reads the catalog port from probeTarget", () => {
  const svc = buildContract(
    {
      serviceId: "organization",
      probeTarget: "http://127.0.0.1:4244/health",
    },
    tmpConfig(),
  );
  assert.equal(listenPortFromContract(svc), 4244);
});

test("listenPortFromContract is null for command probes", () => {
  const svc = buildContract(
    {
      serviceId: "acp-upgrader",
      probeType: "command",
      probeTarget: "bash scripts/upgrader-status.sh",
    },
    tmpConfig(),
  );
  assert.equal(listenPortFromContract(svc), null);
});

test("remediationEnv forwards contract port and strips watchdog PORT", () => {
  const svc = buildContract(
    {
      serviceId: "organization",
      probeTarget: "http://127.0.0.1:4244/health",
      runtimeDir: "/tmp/org-runtime",
    },
    tmpConfig(),
  );
  withPortEnv(
    { PORT: "4235", SERVICE_PORT: "4235", WATCHDOG_PORT: "4235" },
    () => {
      const env = remediationEnv(svc);
      assert.equal(env.PORT, "4244");
      assert.equal(env.SERVICE_PORT, "4244");
      assert.equal(env.WATCHDOG_PORT, undefined);
      assert.equal(env.WATCHDOG_SERVICE_ID, "organization");
      assert.equal(env.RUNTIME_DIR, "/tmp/org-runtime");
    },
  );
});

test("remediationEnv does not invent a port for command-probed services", () => {
  const svc = buildContract(
    {
      serviceId: "acp-upgrader",
      probeType: "command",
      probeTarget: "bash scripts/upgrader-status.sh",
    },
    tmpConfig(),
  );
  withPortEnv(
    { PORT: "4235", SERVICE_PORT: "4235", WATCHDOG_PORT: "4235" },
    () => {
      const env = remediationEnv(svc);
      assert.equal(env.PORT, undefined);
      assert.equal(env.SERVICE_PORT, undefined);
      assert.equal(env.WATCHDOG_PORT, undefined);
    },
  );
});

test("runRemediation child sees contract PORT not watchdog PORT", async () => {
  const svc = buildContract(
    {
      serviceId: "organization",
      probeTarget: "http://127.0.0.1:4244/health",
      startCmd:
        'printf "PORT=%s SERVICE_PORT=%s WATCHDOG_PORT=%s" "$PORT" "$SERVICE_PORT" "${WATCHDOG_PORT-}"',
    },
    tmpConfig(),
  );
  const result = await withPortEnv(
    { PORT: "4235", SERVICE_PORT: "4235", WATCHDOG_PORT: "4235" },
    () => runRemediation(svc, "start", { timeoutSec: 5 }),
  );
  assert.equal(result.ok, true);
  assert.match(result.output, /PORT=4244/);
  assert.match(result.output, /SERVICE_PORT=4244/);
  assert.match(result.output, /WATCHDOG_PORT=$/);
});
