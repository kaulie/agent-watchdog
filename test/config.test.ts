import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import { test } from "node:test";
import path from "node:path";
import { loadConfig } from "../src/config.js";

/**
 * Regression guard: the deployment/app environment often carries PORT=4211
 * (web-cursor). The watchdog must never inherit it — an earlier build rendered
 * the launchd unit with PORT=4211 and shadowed the app it is supposed to watch.
 */
test("ambient PORT never becomes the watchdog port", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-config-"));
  const saved = {
    home: process.env.WATCHDOG_HOME,
    wdHost: process.env.WATCHDOG_HOST,
    wdPort: process.env.WATCHDOG_PORT,
    host: process.env.HOST,
    port: process.env.PORT,
  };
  try {
    process.env.WATCHDOG_HOME = dir;
    process.env.PORT = "4211";
    process.env.HOST = "0.0.0.0";
    delete process.env.WATCHDOG_PORT;
    delete process.env.WATCHDOG_HOST;
    const fallback = loadConfig();
    assert.equal(fallback.port, 4230);
    assert.equal(fallback.host, "127.0.0.1", "must not inherit HOST=0.0.0.0");

    process.env.WATCHDOG_PORT = "4239";
    process.env.WATCHDOG_HOST = "127.0.0.2";
    const explicit = loadConfig();
    assert.equal(explicit.port, 4239);
    assert.equal(explicit.host, "127.0.0.2");
  } finally {
    for (const [key, value] of Object.entries({
      WATCHDOG_HOME: saved.home,
      WATCHDOG_HOST: saved.wdHost,
      WATCHDOG_PORT: saved.wdPort,
      HOST: saved.host,
      PORT: saved.port,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

