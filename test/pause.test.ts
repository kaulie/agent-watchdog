import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PauseController } from "../src/pause.js";
import { tmpConfig } from "./helpers.js";

test("global pause suppresses everything and expires", () => {
  const config = tmpConfig();
  const pause = new PauseController(config);
  assert.equal(pause.isPaused(), false);

  pause.pause({ seconds: 60, reason: "maintenance" });
  assert.equal(pause.isPaused(), true);
  assert.equal(pause.isPaused("web-cursor"), true);
  assert.equal(pause.info().source, "global");

  pause.resume();
  assert.equal(pause.isPaused(), false);
});

test("per-service pause is independent of other services", () => {
  const config = tmpConfig();
  const pause = new PauseController(config);
  pause.pause({ seconds: 60, serviceId: "web-cursor", reason: "deploy" });

  assert.equal(pause.info("web-cursor").paused, true);
  assert.equal(pause.info("web-cursor").source, "service-memory");
  assert.equal(pause.isPaused("other"), false);

  pause.resume("web-cursor");
  assert.equal(pause.isPaused("web-cursor"), false);
});

test("legacy deployment marker is honoured (deploy-safe)", () => {
  const config = tmpConfig();
  const pause = new PauseController(config);
  const file = path.join(
    config.legacyDeployDir,
    "web-cursor",
    "ops",
    "watchdog-pause-until",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const future = Math.floor(Date.now() / 1000) + 120;
  fs.writeFileSync(file, `${future}\n`);
  const info = pause.info("web-cursor");
  assert.equal(info.paused, true);
  assert.equal(info.source, "legacy-deploy");

  // expired marker is ignored
  fs.writeFileSync(file, `${Math.floor(Date.now() / 1000) - 1}\n`);
  assert.equal(pause.info("web-cursor").paused, false);
});

test("on-disk per-service marker survives a fresh controller", () => {
  const config = tmpConfig();
  const first = new PauseController(config);
  first.pause({ seconds: 300, serviceId: "api", reason: "deploy" });

  const second = new PauseController(config); // simulates a restart
  const info = second.info("api");
  assert.equal(info.paused, true);
  assert.equal(info.source, "service-file");
});
