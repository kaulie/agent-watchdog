import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContract } from "../src/contract.js";
import type { DeployCatalog } from "../src/deploy.js";
import { SyncReconciler } from "../src/sync.js";
import { tmpConfig, tmpStore } from "./helpers.js";

function sampleCatalog(): DeployCatalog {
  return {
    services: [
      {
        serviceId: "agent-control-plane",
        name: "agent 交互界面",
        runtimeDir: "/tmp/web-cursor",
        healthUrl: "/health",
        port: 4211,
        startCmd: "bash scripts/start.sh",
        restartCmd: "bash scripts/restart.sh",
        stopCmd: "bash scripts/stop.sh",
        configured: true,
      },
      {
        serviceId: "home-agent-brain",
        name: "home-agent-brain",
        runtimeDir: "/tmp/brain",
        healthUrl: "/health",
        port: 9527,
        startCmd: "bash scripts/start.sh",
        configured: true,
      },
    ],
    inventory: {
      services: [
        { serviceId: "agent-control-plane", machines: [{ machineId: "local" }] },
        { serviceId: "home-agent-brain", machines: [{ machineId: "local" }] },
      ],
    },
  };
}

test("reconcile upserts allowlisted services and keeps policy fields", async () => {
  const config = tmpConfig();
  config.syncAllow = ["agent-control-plane", "home-agent-brain"];
  const store = tmpStore(config);
  store.upsertService(
    buildContract(
      {
        serviceId: "agent-control-plane",
        probeTarget: "http://127.0.0.1:9/old",
        intervalSec: 42,
        failureThreshold: 7,
        source: "manual",
      },
      config,
    ),
  );

  const sync = new SyncReconciler(store, config, async () => ({
    ok: true,
    catalog: sampleCatalog(),
  }));
  const report = await sync.reconcile("api");
  assert.equal(report.upstreamOk, true);
  assert.equal(report.desired, 2);
  assert.equal(report.stale, false);

  const acp = store.getService("agent-control-plane")!;
  assert.equal(acp.probeTarget, "http://127.0.0.1:4211/health");
  assert.equal(acp.intervalSec, 42);
  assert.equal(acp.failureThreshold, 7);
  assert.equal(acp.source, "deploy-sync");
  assert.equal(acp.enabled, true);
  assert.ok(store.getService("home-agent-brain"));
});

test("reconcile disables deploy-sync rows that left the desired set", async () => {
  const config = tmpConfig();
  config.syncAllow = ["agent-control-plane"];
  const store = tmpStore(config);
  store.upsertService(
    buildContract(
      {
        serviceId: "gone",
        probeTarget: "http://127.0.0.1:1/health",
        source: "deploy-sync",
        enabled: true,
      },
      config,
    ),
  );

  const sync = new SyncReconciler(store, config, async () => ({
    ok: true,
    catalog: sampleCatalog(),
  }));
  const report = await sync.reconcile("startup");
  assert.equal(report.disabled, 1);
  assert.equal(store.getService("gone")!.enabled, false);
});

test("reconcile does not touch pinned contracts", async () => {
  const config = tmpConfig();
  config.syncAllow = ["agent-control-plane"];
  const store = tmpStore(config);
  store.upsertService(
    buildContract(
      {
        serviceId: "agent-control-plane",
        probeTarget: "http://127.0.0.1:9/pinned",
        source: "manual",
        pinned: true,
        intervalSec: 20,
      },
      config,
    ),
  );

  const sync = new SyncReconciler(store, config, async () => ({
    ok: true,
    catalog: sampleCatalog(),
  }));
  const report = await sync.reconcile("api");
  assert.equal(report.skippedPinned, 1);
  const got = store.getService("agent-control-plane")!;
  assert.equal(got.probeTarget, "http://127.0.0.1:9/pinned");
  assert.equal(got.source, "manual");
});

test("failed catalog fetch keeps last-known contracts and marks stale", async () => {
  const config = tmpConfig();
  const store = tmpStore(config);
  store.upsertService(
    buildContract(
      {
        serviceId: "agent-control-plane",
        probeTarget: "http://127.0.0.1:4211/health",
        source: "deploy-sync",
      },
      config,
    ),
  );

  const sync = new SyncReconciler(store, config, async () => ({
    ok: false,
    error: "connection refused",
  }));
  const report = await sync.reconcile("timer");
  assert.equal(report.upstreamOk, false);
  assert.equal(report.stale, true);
  assert.match(report.lastError ?? "", /connection refused/);
  assert.equal(store.getService("agent-control-plane")!.enabled, true);
});

test("reconcile applies catalog intervalSec and keeps it when omitted", async () => {
  const config = tmpConfig();
  config.syncAllow = ["agent-control-plane"];
  const store = tmpStore(config);
  store.upsertService(
    buildContract(
      {
        serviceId: "agent-control-plane",
        probeTarget: "http://127.0.0.1:9/old",
        intervalSec: 12,
        source: "deploy-sync",
      },
      config,
    ),
  );
  const withInterval = sampleCatalog();
  withInterval.services[0] = { ...withInterval.services[0]!, intervalSec: 30 };
  const sync = new SyncReconciler(store, config, async () => ({
    ok: true,
    catalog: withInterval,
  }));
  await sync.reconcile("api");
  assert.equal(store.getService("agent-control-plane")!.intervalSec, 30);

  const withoutInterval = sampleCatalog();
  const again = new SyncReconciler(store, config, async () => ({
    ok: true,
    catalog: withoutInterval,
  }));
  await again.reconcile("api");
  assert.equal(store.getService("agent-control-plane")!.intervalSec, 30);
});

test("sync state survives a store re-read", async () => {
  const config = tmpConfig();
  const store = tmpStore(config);
  const sync = new SyncReconciler(store, config, async () => ({
    ok: true,
    catalog: sampleCatalog(),
  }));
  await sync.reconcile("api");
  const again = store.getSyncState();
  assert.equal(again.upstreamOk, true);
  assert.ok(again.lastSuccessAt);
});
