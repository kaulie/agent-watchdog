import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContract } from "../src/contract.js";
import {
  migrateLegacyWebCursor,
  seedBootstrapIfEmpty,
  seedDefaults,
} from "../src/seed.js";
import { tmpConfig, tmpStore } from "./helpers.js";

test("empty store gets the bootstrap control-plane set", () => {
  const config = tmpConfig();
  const store = tmpStore(config);
  seedBootstrapIfEmpty(store, config);
  const ids = store.listServices().map((s) => s.serviceId).sort();
  assert.deepEqual(ids, [
    "agent-control-plane",
    "agent-control-plane-deployment",
    "service_registry",
  ]);
  const acp = store.getService("agent-control-plane")!;
  assert.equal(acp.source, "bootstrap");
  assert.equal(acp.probeTarget, "http://127.0.0.1:4211/health");
  assert.match(acp.runtimeDir ?? "", /web-cursor$/);
});

test("bootstrap is a no-op when the store already has rows", () => {
  const config = tmpConfig();
  const store = tmpStore(config);
  store.upsertService(
    buildContract(
      { serviceId: "already", probeTarget: "http://127.0.0.1:1/health" },
      config,
    ),
  );
  seedBootstrapIfEmpty(store, config);
  assert.equal(store.listServices().length, 1);
  assert.equal(store.getService("agent-control-plane"), undefined);
});

test("legacy web-cursor row is renamed and disabled", () => {
  const config = tmpConfig();
  const store = tmpStore(config);
  store.upsertService(
    buildContract(
      {
        serviceId: "web-cursor",
        name: "Web Cursor Agent Gateway",
        probeTarget: "http://127.0.0.1:4211/health",
        intervalSec: 15,
        startCmd: "bash start.sh",
      },
      config,
    ),
  );
  migrateLegacyWebCursor(store, config);
  const acp = store.getService("agent-control-plane")!;
  assert.equal(acp.enabled, true);
  assert.equal(acp.intervalSec, 15);
  assert.equal(acp.source, "bootstrap");
  assert.equal(store.getService("web-cursor")!.enabled, false);
});

test("seedDefaults migrates then skips bootstrap because store is not empty", () => {
  const config = tmpConfig();
  const store = tmpStore(config);
  store.upsertService(
    buildContract(
      {
        serviceId: "web-cursor",
        probeTarget: "http://127.0.0.1:4211/health",
      },
      config,
    ),
  );
  seedDefaults(store, config);
  assert.ok(store.getService("agent-control-plane"));
  assert.equal(store.getService("service_registry"), undefined);
});
