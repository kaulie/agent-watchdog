import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContract, type ContractInput } from "../src/contract.js";
import { MonitorEngine } from "../src/engine.js";
import { PauseController } from "../src/pause.js";
import type {
  ProbeResult,
  RemediationAction,
  ServiceContract,
} from "../src/types.js";
import { tmpConfig, tmpStore } from "./helpers.js";

function okResult(): ProbeResult {
  return { ok: true, latencyMs: 1, checkedAt: new Date().toISOString() };
}
function failResult(error = "boom"): ProbeResult {
  return { ok: false, latencyMs: 1, error, checkedAt: new Date().toISOString() };
}

interface Setup {
  engine: MonitorEngine;
  store: ReturnType<typeof tmpStore>;
  pause: PauseController;
  remediations: RemediationAction[];
  get(): ServiceContract;
}

function setup(
  probe: () => Promise<ProbeResult>,
  overrides: ContractInput = {},
): Setup {
  const config = tmpConfig();
  const store = tmpStore(config);
  const pause = new PauseController(config);
  const remediations: RemediationAction[] = [];
  const engine = new MonitorEngine(store, config, pause, {
    probe: () => probe(),
    remediate: async (_svc, action) => {
      remediations.push(action);
      return { ok: true, command: "fake", exitCode: 0, durationMs: 1, output: "" };
    },
  });
  store.upsertService(
    buildContract(
      {
        serviceId: "svc",
        probeTarget: "http://127.0.0.1:1/health",
        failureThreshold: 2,
        successThreshold: 1,
        cooldownSec: 0,
        maxRemediationsPerHour: 10,
        remediation: "start",
        startCmd: "echo start",
        ...overrides,
      },
      config,
    ),
  );
  const get = (): ServiceContract => store.getService("svc")!;
  return { engine, store, pause, remediations, get };
}

test("failures drive unknown → down and remediate exactly once", async () => {
  let result = failResult("e1");
  const { engine, remediations, store, get } = setup(async () => result);

  let status = await engine.probeAndEvaluate(get(), true);
  assert.equal(status.state, "unknown");
  assert.equal(status.consecutiveFailures, 1);
  assert.equal(remediations.length, 0);

  result = failResult("e2");
  status = await engine.probeAndEvaluate(get(), true);
  assert.equal(status.state, "down");
  assert.equal(remediations.length, 1);
  assert.deepEqual(remediations, ["start"]);

  const changes = store.listEvents({ serviceId: "svc", type: "state_change" });
  assert.equal(changes.length, 1);
  assert.equal((changes[0]!.data as Record<string, unknown>).to, "down");
});

test("recovery requires successThreshold consecutive ok probes", async () => {
  let result = failResult();
  const { engine, get } = setup(async () => result, {
    failureThreshold: 1,
    successThreshold: 2,
  });
  await engine.probeAndEvaluate(get(), true);
  assert.equal(engine.getStatus("svc")!.state, "down");

  result = okResult();
  let status = await engine.probeAndEvaluate(get(), true);
  assert.equal(status.state, "down");
  assert.equal(status.consecutiveSuccesses, 1);

  status = await engine.probeAndEvaluate(get(), true);
  assert.equal(status.state, "up");
  assert.equal(status.consecutiveFailures, 0);
});

test("pause suppresses remediation", async () => {
  const { engine, pause, remediations, store, get } = setup(async () => failResult(), {
    failureThreshold: 1,
  });
  pause.pause({ seconds: 60, serviceId: "svc", reason: "deploy" });

  const status = await engine.probeAndEvaluate(get(), true);
  assert.equal(status.state, "down");
  assert.equal(status.paused, true);
  assert.equal(remediations.length, 0);

  const pauseEvents = store.listEvents({ serviceId: "svc", type: "pause" });
  assert.equal(pauseEvents.length, 1);
});

test("cooldown blocks a second remediation in real time", async () => {
  let result = failResult();
  const { engine, remediations, get } = setup(async () => result, {
    failureThreshold: 1,
    successThreshold: 1,
    cooldownSec: 3600,
  });

  await engine.probeAndEvaluate(get(), true);
  assert.equal(remediations.length, 1);

  result = okResult();
  await engine.probeAndEvaluate(get(), true); // back up

  result = failResult();
  const status = await engine.probeAndEvaluate(get(), true); // down again, but cooldown
  assert.equal(status.state, "down");
  assert.equal(remediations.length, 1);
});

test("hourly rate limit prevents remediation storms", async () => {
  let result = failResult();
  const { engine, remediations, get } = setup(async () => result, {
    failureThreshold: 1,
    successThreshold: 1,
    cooldownSec: 0,
    maxRemediationsPerHour: 1,
  });

  await engine.probeAndEvaluate(get(), true);
  assert.equal(remediations.length, 1);

  result = okResult();
  await engine.probeAndEvaluate(get(), true);

  result = failResult();
  await engine.probeAndEvaluate(get(), true);
  assert.equal(remediations.length, 1);
});

test("remediation=none never runs commands", async () => {
  const { engine, remediations, get } = setup(async () => failResult(), {
    failureThreshold: 1,
    remediation: "none",
  });
  const status = await engine.probeAndEvaluate(get(), true);
  assert.equal(status.state, "down");
  assert.equal(remediations.length, 0);
});

test("tick probes due services and remediates", async () => {
  const { engine, remediations } = setup(async () => failResult(), {
    failureThreshold: 1,
    cooldownSec: 0,
  });
  await engine.tick();
  assert.equal(remediations.length, 1);
});

test("manual remediateNow records a manual-trigger remediation", async () => {
  const { engine, store } = setup(async () => okResult(), { remediation: "restart", restartCmd: "echo restart" });
  const result = await engine.remediateNow("svc", "restart");
  assert.ok(result);
  assert.equal(result!.remediation?.ok, true);
  const records = store.listRemediations({ serviceId: "svc" });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.trigger, "manual");
});
