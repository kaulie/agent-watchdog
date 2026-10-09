import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composeProbeTarget,
  hasLocalInstance,
  selectDesired,
  type DeployCatalog,
} from "../src/deploy.js";

test("composeProbeTarget joins relative healthUrl with loopback port", () => {
  assert.equal(
    composeProbeTarget(9527, "/health"),
    "http://127.0.0.1:9527/health",
  );
  assert.equal(
    composeProbeTarget(4211, ""),
    "http://127.0.0.1:4211/health",
  );
});

test("composeProbeTarget rewrites absolute URLs onto 127.0.0.1", () => {
  assert.equal(
    composeProbeTarget(9527, "http://49.234.45.173:9527/health"),
    "http://127.0.0.1:9527/health",
  );
});

test("hasLocalInstance is true when inventory is missing or lists local", () => {
  assert.equal(hasLocalInstance("brain", null), true);
  assert.equal(
    hasLocalInstance("brain", { services: [{ serviceId: "brain" }] }),
    true,
  );
  assert.equal(
    hasLocalInstance("brain", {
      services: [
        {
          serviceId: "brain",
          machines: [{ machineId: "49.234.45.173" }, { machineId: "local" }],
        },
      ],
    }),
    true,
  );
  assert.equal(
    hasLocalInstance("brain", {
      services: [
        { serviceId: "brain", machines: [{ machineId: "49.234.45.173" }] },
      ],
    }),
    false,
  );
});

function catalog(extra: DeployCatalog["services"] = []): DeployCatalog {
  return {
    services: [
      {
        serviceId: "agent-control-plane",
        name: "agent 交互界面",
        runtimeDir: "/Users/gaolei/runtime/web-cursor",
        healthUrl: "/health",
        port: 4211,
        startCmd: "bash scripts/start.sh",
        restartCmd: "bash scripts/restart.sh",
        stopCmd: "bash scripts/stop.sh",
        configured: true,
      },
      {
        serviceId: "watchdog",
        name: "watchdog",
        runtimeDir: "/Users/gaolei/runtime/agent-watchdog",
        healthUrl: "/health",
        port: 4235,
        startCmd: "bash scripts/start.sh",
        configured: true,
      },
      {
        serviceId: "agent-benchmark-tool",
        name: "bench",
        runtimeDir: "/tmp/bench",
        healthUrl: "/health",
        port: 4231,
        startCmd: "bash scripts/start.sh",
        configured: true,
      },
      ...extra,
    ],
    inventory: {
      services: [
        { serviceId: "agent-control-plane", machines: [{ machineId: "local" }] },
        { serviceId: "watchdog", machines: [{ machineId: "local" }] },
        { serviceId: "agent-benchmark-tool", machines: [{ machineId: "local" }] },
      ],
    },
  };
}

test("selectDesired keep allowlisted local services and drops self", () => {
  const { desired, skipped } = selectDesired(catalog(), {
    allow: ["agent-control-plane", "home-agent-brain"],
    exclude: ["watchdog", "agent-watchdog"],
  });
  assert.deepEqual(
    desired.map((d) => d.serviceId),
    ["agent-control-plane"],
  );
  assert.equal(
    desired[0]!.probeTarget,
    "http://127.0.0.1:4211/health",
  );
  assert.ok(skipped.some((s) => s.serviceId === "watchdog"));
  assert.ok(skipped.some((s) => s.serviceId === "agent-benchmark-tool"));
});

test("selectDesired * still excludes watchdog", () => {
  const { desired } = selectDesired(catalog(), {
    allow: "*",
    exclude: ["watchdog", "agent-watchdog"],
  });
  assert.ok(desired.some((d) => d.serviceId === "agent-control-plane"));
  assert.ok(desired.some((d) => d.serviceId === "agent-benchmark-tool"));
  assert.ok(!desired.some((d) => d.serviceId === "watchdog"));
});

test("selectDesired honors explicit supervise over the allowlist", () => {
  const cat: DeployCatalog = {
    services: [
      {
        serviceId: "event-center",
        runtimeDir: "/tmp/ec",
        healthUrl: "/health",
        port: 4438,
        startCmd: "bash scripts/start.sh",
        configured: true,
        supervise: true,
      },
      {
        serviceId: "agent-control-plane",
        runtimeDir: "/tmp/acp",
        healthUrl: "/health",
        port: 4211,
        startCmd: "bash scripts/start.sh",
        configured: true,
        supervise: false,
      },
    ],
    inventory: null,
  };
  const { desired, skipped } = selectDesired(cat, {
    allow: ["agent-control-plane"],
    exclude: ["watchdog"],
  });
  assert.deepEqual(
    desired.map((d) => d.serviceId),
    ["event-center"],
  );
  assert.ok(skipped.some((s) => s.reason === "supervise disabled"));
});

test("selectDesired skips remote-only and incomplete rows", () => {
  const { desired, skipped } = selectDesired(
    {
      services: [
        {
          serviceId: "cloud-only",
          runtimeDir: "/tmp/x",
          healthUrl: "/health",
          port: 9,
          startCmd: "bash start.sh",
          configured: true,
        },
        {
          serviceId: "no-cmd",
          runtimeDir: "/tmp/y",
          healthUrl: "/health",
          port: 8,
          configured: true,
        },
      ],
      inventory: {
        services: [
          { serviceId: "cloud-only", machines: [{ machineId: "1.2.3.4" }] },
        ],
      },
    },
    { allow: "*", exclude: [] },
  );
  assert.equal(desired.length, 0);
  assert.ok(skipped.some((s) => s.reason === "no local instance"));
  assert.ok(skipped.some((s) => s.reason === "missing startCmd"));
});
