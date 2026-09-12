import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContract, ContractError } from "../src/contract.js";
import { tmpConfig } from "./helpers.js";

test("buildContract applies defaults for a minimal http service", () => {
  const config = tmpConfig();
  const c = buildContract(
    { serviceId: "svc-a", probeTarget: "http://127.0.0.1:1/health" },
    config,
  );
  assert.equal(c.serviceId, "svc-a");
  assert.equal(c.enabled, true);
  assert.equal(c.group, "default");
  assert.equal(c.probeType, "http");
  assert.equal(c.expectStatus, 200);
  assert.equal(c.remediation, "start");
  assert.equal(c.intervalSec, config.defaultIntervalSec);
  assert.equal(c.failureThreshold, config.defaultFailureThreshold);
});

test("buildContract rejects missing target and bad serviceId", () => {
  const config = tmpConfig();
  assert.throws(
    () => buildContract({ serviceId: "x" }, config),
    ContractError,
  );
  assert.throws(
    () =>
      buildContract({ serviceId: "bad id!", probeTarget: "http://x" }, config),
    ContractError,
  );
});

test("buildContract merges partial updates over an existing contract", () => {
  const config = tmpConfig();
  const base = buildContract(
    {
      serviceId: "svc-b",
      probeTarget: "http://127.0.0.1:9/health",
      intervalSec: 30,
      expectBodyContains: "ok",
    },
    config,
  );
  const updated = buildContract({ intervalSec: 5 }, config, base);
  assert.equal(updated.intervalSec, 5);
  assert.equal(updated.expectBodyContains, "ok");
  assert.equal(updated.probeTarget, base.probeTarget);
  assert.equal(updated.createdAt, base.createdAt);
});

test("buildContract clamps numeric policy fields", () => {
  const config = tmpConfig();
  const c = buildContract(
    {
      serviceId: "svc-c",
      probeTarget: "http://127.0.0.1:9/health",
      intervalSec: -10,
      failureThreshold: 0,
    },
    config,
  );
  assert.ok(c.intervalSec >= 2);
  assert.ok(c.failureThreshold >= 1);
});
