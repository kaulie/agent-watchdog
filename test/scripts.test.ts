import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { test } from "node:test";
import path from "node:path";

const REPO = process.cwd();
const LIB = path.join(REPO, "scripts", "lib-autostart.sh");

function bash(script: string, env: NodeJS.ProcessEnv = {}, cwd?: string) {
  return spawnSync("/bin/bash", ["-c", `source "${LIB}"; ${script}`], {
    env: { ...process.env, ...env },
    cwd,
    encoding: "utf8",
  });
}

test("lib-autostart.sh resolves the port from WATCHDOG_PORT only", () => {
  const withAmbient = bash("printf '%s' \"${WD_PORT}\"", {
    PORT: "4211",
    WATCHDOG_PORT: "",
  });
  assert.equal(withAmbient.status, 0, withAmbient.stderr);
  assert.equal(withAmbient.stdout, "4230");

  const withExplicit = bash("printf '%s' \"${WD_PORT}\"", {
    PORT: "4211",
    WATCHDOG_PORT: "4239",
  });
  assert.equal(withExplicit.stdout, "4239");
});

test("wd_pid_is_ours recognises our instance by working directory, not cmdline", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-ours-"));
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-foreign-"));

  // The test shell itself plays the role of the service process: `node dist/index.js`
  // style cmdline, cwd inside the install dir.
  const mine = bash("wd_pid_is_ours $$ && echo ours || echo foreign", {
    WATCHDOG_HOME: home,
  }, home);
  assert.equal(mine.stdout.trim(), "ours");

  const notMine = bash("wd_pid_is_ours $$ && echo ours || echo foreign", {
    WATCHDOG_HOME: foreign,
  }, home);
  assert.equal(notMine.stdout.trim(), "foreign");

  const bogus = bash("wd_pid_is_ours '' && echo ours || echo foreign", {
    WATCHDOG_HOME: home,
  }, home);
  assert.equal(bogus.stdout.trim(), "foreign");
});
