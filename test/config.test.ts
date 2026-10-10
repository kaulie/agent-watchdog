import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { tmpConfig } from "./helpers.js";

function withEnv(
  patch: Record<string, string | undefined>,
  fn: () => void,
): void {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    prev[key] = process.env[key];
    const v = patch[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  try {
    fn();
  } finally {
    for (const [key, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  }
}

test("port defaults to 4230 when SERVICE_PORT and WATCHDOG_PORT unset", () => {
  tmpConfig();
  withEnv({ SERVICE_PORT: undefined, WATCHDOG_PORT: undefined, PORT: "4211" }, () => {
    assert.equal(loadConfig().port, 4230);
  });
});

test("port reads SERVICE_PORT over WATCHDOG_PORT", () => {
  tmpConfig();
  withEnv({ SERVICE_PORT: "4242", WATCHDOG_PORT: "4239" }, () => {
    assert.equal(loadConfig().port, 4242);
  });
});

test("port falls back to WATCHDOG_PORT when SERVICE_PORT unset", () => {
  tmpConfig();
  withEnv({ SERVICE_PORT: undefined, WATCHDOG_PORT: "4238" }, () => {
    assert.equal(loadConfig().port, 4238);
  });
});

test("probe interval defaults to 30 seconds", () => {
  tmpConfig();
  withEnv({ WATCHDOG_DEFAULT_INTERVAL_SEC: undefined }, () => {
    assert.equal(loadConfig().defaultIntervalSec, 30);
  });
  withEnv({ WATCHDOG_DEFAULT_INTERVAL_SEC: "15" }, () => {
    assert.equal(loadConfig().defaultIntervalSec, 15);
  });
});

test("sync allow defaults to the first-wave control-plane set", () => {
  tmpConfig();
  const cfg = loadConfig();
  assert.equal(cfg.deployUrl, "http://127.0.0.1:4220");
  assert.equal(cfg.syncEnabled, true);
  assert.ok(Array.isArray(cfg.syncAllow));
  assert.ok((cfg.syncAllow as string[]).includes("agent-control-plane"));
  assert.ok(cfg.syncExclude.includes("watchdog"));
  assert.ok(cfg.syncExclude.includes("acp-upgrader"));
});

test("WATCHDOG_SYNC_ALLOW=* means every eligible service", () => {
  tmpConfig();
  withEnv({ WATCHDOG_SYNC_ALLOW: "*" }, () => {
    assert.equal(loadConfig().syncAllow, "*");
  });
});

test("WATCHDOG_SYNC_ALLOW empty disables the allowlist", () => {
  tmpConfig();
  withEnv({ WATCHDOG_SYNC_ALLOW: "" }, () => {
    assert.deepEqual(loadConfig().syncAllow, []);
  });
});
