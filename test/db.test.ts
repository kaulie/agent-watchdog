import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { buildContract } from "../src/contract.js";
import { Store } from "../src/db.js";
import { tmpConfig, tmpStore } from "./helpers.js";

test("services round-trip through the store", () => {
  const config = tmpConfig();
  const store = tmpStore(config);
  const c = buildContract(
    {
      serviceId: "web",
      name: "Web",
      group: "apps",
      probeTarget: "http://127.0.0.1:4211/health",
      expectBodyContains: '"ok":true',
      runtimeDir: "/tmp/web",
      startCmd: "bash start.sh",
      failureThreshold: 4,
    },
    config,
  );
  store.upsertService(c);

  const got = store.getService("web");
  assert.ok(got);
  assert.equal(got!.name, "Web");
  assert.equal(got!.group, "apps");
  assert.equal(got!.expectBodyContains, '"ok":true');
  assert.equal(got!.failureThreshold, 4);
  assert.equal(got!.source, "manual");
  assert.equal(got!.pinned, false);
  assert.equal(got!.intervalSec, 30);
  assert.equal(store.listServices().length, 1);

  // update keeps createdAt but bumps updatedAt
  const again = store.upsertService({ ...got!, name: "Web2" });
  assert.equal(again.createdAt, got!.createdAt);
  assert.equal(store.getService("web")!.name, "Web2");

  assert.equal(store.deleteService("web"), true);
  assert.equal(store.getService("web"), undefined);
  assert.equal(store.deleteService("web"), false);
});

test("events are appended, filtered and pruned", () => {
  const config = tmpConfig();
  const store = tmpStore(config);
  for (let i = 0; i < 5; i++) {
    store.appendEvent({
      serviceId: i % 2 === 0 ? "a" : "b",
      type: "state_change",
      level: "info",
      message: `e${i}`,
      data: { i },
    });
  }
  store.appendEvent({ type: "system", message: "boot" });

  assert.equal(store.listEvents().length, 6);
  assert.equal(store.listEvents({ serviceId: "a" }).length, 3);
  assert.equal(store.listEvents({ type: "system" }).length, 1);
  assert.deepEqual(store.listEvents({ limit: 1 })[0]!.data, null);

  const pruned = store.pruneEvents(2);
  assert.ok(pruned >= 4);
  assert.equal(store.listEvents().length, 2);
});

test("remediation accounting supports cooldown and rate limiting", () => {
  const config = tmpConfig();
  const store = tmpStore(config);
  const rec = store.addRemediation({
    serviceId: "svc",
    action: "start",
    command: "echo start",
    ok: true,
    exitCode: 0,
    durationMs: 12,
    trigger: "threshold",
    output: "done",
  });
  assert.equal(rec.id > 0, true);
  assert.ok(store.lastRemediationAt("svc"));

  const sinceHourAgo = new Date(Date.now() - 3600_000).toISOString();
  assert.equal(store.countRemediationsSince("svc", sinceHourAgo), 1);
  const sinceNow = new Date(Date.now() + 1000).toISOString();
  assert.equal(store.countRemediationsSince("svc", sinceNow), 0);

  const list = store.listRemediations({ serviceId: "svc" });
  assert.equal(list.length, 1);
  assert.equal(list[0]!.ok, true);

  const stats = store.stats();
  assert.equal(stats.services, 0);
  assert.equal(stats.remediations, 1);
});

test("opening an old store bumps the 10s factory default to 30s once", () => {
  const config = tmpConfig();
  let store = tmpStore(config);
  store.upsertService(
    buildContract(
      {
        serviceId: "legacy",
        probeTarget: "http://127.0.0.1:1/health",
        intervalSec: 10,
      },
      config,
    ),
  );
  store.upsertService(
    buildContract(
      {
        serviceId: "custom",
        probeTarget: "http://127.0.0.1:2/health",
        intervalSec: 45,
      },
      config,
    ),
  );
  store.close();

  const raw = new DatabaseSync(config.dbPath);
  raw.exec("PRAGMA user_version = 0");
  raw.close();

  store = new Store(config.dbPath);
  try {
    assert.equal(store.getService("legacy")!.intervalSec, 30);
    assert.equal(store.getService("custom")!.intervalSec, 45);
    store.close();
    store = new Store(config.dbPath);
    store.upsertService({ ...store.getService("legacy")!, intervalSec: 10 });
    store.close();
    store = new Store(config.dbPath);
    assert.equal(store.getService("legacy")!.intervalSec, 10);
  } finally {
    store.close();
  }
});
