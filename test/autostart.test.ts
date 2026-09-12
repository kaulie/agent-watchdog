import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { test } from "node:test";
import path from "node:path";
import {
  DEFAULT_LAUNCHD_LABEL,
  DEFAULT_SYSTEMD_UNIT,
  autostartInfo,
  buildPath,
  detectPlatform,
  launchAgentPlistPath,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderUnit,
  serviceEnvironment,
  systemdUserUnitPath,
  unitPathFor,
  xmlEscape,
  type AutostartOptions,
} from "../src/autostart.js";

const HOME_DIR = "/tmp/fake-home";
const INSTALL_DIR = "/Users/tester/runtime/agent-watchdog";

function options(overrides: Partial<AutostartOptions> = {}): AutostartOptions {
  return {
    platform: "darwin",
    home: INSTALL_DIR,
    host: "127.0.0.1",
    port: 4230,
    label: DEFAULT_LAUNCHD_LABEL,
    logDir: path.join(INSTALL_DIR, "logs"),
    nodePath: "/usr/local/bin/node",
    jitterSec: 3,
    version: "0.2.0",
    ...overrides,
  };
}

test("detectPlatform maps only darwin/linux", () => {
  assert.equal(detectPlatform("darwin"), "darwin");
  assert.equal(detectPlatform("linux"), "linux");
  assert.equal(detectPlatform("win32"), null);
});

test("unit paths follow the OS conventions", () => {
  assert.equal(
    launchAgentPlistPath("ai.hermes.agent-watchdog", HOME_DIR),
    path.join(HOME_DIR, "Library/LaunchAgents/ai.hermes.agent-watchdog.plist"),
  );
  assert.equal(
    systemdUserUnitPath(DEFAULT_SYSTEMD_UNIT, HOME_DIR),
    path.join(HOME_DIR, ".config/systemd/user/agent-watchdog.service"),
  );
  assert.equal(
    unitPathFor(options(), HOME_DIR),
    path.join(HOME_DIR, "Library/LaunchAgents/ai.hermes.agent-watchdog.plist"),
  );
  assert.equal(
    unitPathFor(options({ platform: "linux", label: "agent-watchdog" }), HOME_DIR),
    path.join(HOME_DIR, ".config/systemd/user/agent-watchdog.service"),
  );
  // A linux label that already carries the .service suffix is not doubled up.
  assert.equal(
    unitPathFor(options({ platform: "linux", label: DEFAULT_SYSTEMD_UNIT }), HOME_DIR),
    path.join(HOME_DIR, ".config/systemd/user/agent-watchdog.service"),
  );
});

test("autostartInfo exposes the paths the shell scripts consume", () => {
  const info = autostartInfo(options(), HOME_DIR);
  assert.equal(info.runEntry, path.join(INSTALL_DIR, "scripts/run-service.sh"));
  assert.equal(info.stdoutLog, path.join(INSTALL_DIR, "logs/service.log"));
  assert.equal(info.stderrLog, path.join(INSTALL_DIR, "logs/service.error.log"));
  assert.equal(info.unitName, "ai.hermes.agent-watchdog.plist");
  assert.equal(info.label, DEFAULT_LAUNCHD_LABEL);
});

test("serviceEnvironment carries home/host/port/jitter/path", () => {
  const env = new Map(serviceEnvironment(options({ jitterSec: 5 })));
  assert.equal(env.get("WATCHDOG_HOME"), INSTALL_DIR);
  assert.equal(env.get("WATCHDOG_HOST"), "127.0.0.1");
  assert.equal(env.get("WATCHDOG_PORT"), "4230");
  assert.equal(env.get("WATCHDOG_START_JITTER_SEC"), "5");
  assert.equal(env.get("WATCHDOG_VERSION"), "0.2.0");
  assert.match(env.get("PATH") ?? "", /^\/usr\/local\/bin:/);
  // jitter never goes negative
  assert.equal(new Map(serviceEnvironment(options({ jitterSec: -1 }))).get("WATCHDOG_START_JITTER_SEC"), "0");
  // version is optional
  assert.equal(new Map(serviceEnvironment(options({ version: null }))).has("WATCHDOG_VERSION"), false);
});

test("buildPath keeps the node dir first and drops duplicates", () => {
  assert.equal(buildPath("/usr/local/bin"), "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(buildPath("/opt/node/bin", "/opt/homebrew/bin:/bin"), "/opt/node/bin:/opt/homebrew/bin:/bin");
  assert.equal(buildPath("/bin"), "/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/usr/sbin:/sbin");
});

test("launchd plist starts with the machine and stays alive", () => {
  const plist = renderLaunchdPlist(options(), HOME_DIR);
  assert.match(plist, /<key>Label<\/key>\n\s*<string>ai\.hermes\.agent-watchdog<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\n\s*<integer>10<\/integer>/);
  assert.match(plist, new RegExp(`<string>${INSTALL_DIR}/scripts/run-service\\.sh</string>`));
  assert.match(plist, /<string>\/bin\/bash<\/string>/);
  assert.match(plist, new RegExp(`<string>${INSTALL_DIR}/logs/service\\.error\\.log</string>`));
  assert.match(plist, /<key>WATCHDOG_PORT<\/key>\n\s*<string>4230<\/string>/);
  assert.equal(plist.includes("&amp;"), false, "no escaping needed for plain paths");
});

test("plist escapes XML-hostile values", () => {
  assert.equal(xmlEscape('a&b<c>"d"'), "a&amp;b&lt;c&gt;&quot;d&quot;");
  const plist = renderLaunchdPlist(options({ home: "/tmp/a&b<c" }), HOME_DIR);
  assert.match(plist, /<string>\/tmp\/a&amp;b&lt;c<\/string>/);
  assert.equal(plist.includes("/tmp/a&b<c"), false);
});

test("systemd unit restarts always and writes the same env", () => {
  const unit = renderSystemdUnit(options({ platform: "linux", label: "agent-watchdog" }), HOME_DIR);
  assert.match(unit, /^\[Unit\]/m);
  assert.match(unit, /^ExecStart=\/bin\/bash \/Users\/tester\/runtime\/agent-watchdog\/scripts\/run-service\.sh$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.match(unit, /^Environment="WATCHDOG_PORT=4230"$/m);
  assert.match(unit, /^StandardOutput=append:\/Users\/tester\/runtime\/agent-watchdog\/logs\/service\.log$/m);
});

test("renderUnit dispatches on platform", () => {
  assert.match(renderUnit(options(), HOME_DIR), /<plist version="1.0">/);
  assert.match(renderUnit(options({ platform: "linux" }), HOME_DIR), /\[Service\]/);
});

test("autostart-cli renders a unit the OS can parse", () => {
  const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-autostart-"));
  const outPath = path.join(workDir, "unit.plist");
  const env = { ...process.env, WATCHDOG_HOME: path.join(workDir, "install") };

  const info = spawnSync(
    tsx,
    ["src/autostart-cli.ts", "info", "--field", "unitPath", "--platform", "darwin"],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );
  assert.equal(info.status, 0, info.stderr);
  assert.equal(
    info.stdout.trim(),
    path.join(os.homedir(), "Library/LaunchAgents", `${DEFAULT_LAUNCHD_LABEL}.plist`),
  );

  const render = spawnSync(
    tsx,
    [
      "src/autostart-cli.ts",
      "render",
      "--platform",
      "darwin",
      "--home",
      path.join(workDir, "install"),
      "--port",
      "4239",
      "--out",
      outPath,
    ],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );
  assert.equal(render.status, 0, render.stderr);
  const rendered = fs.readFileSync(outPath, "utf8");
  assert.match(rendered, /<string>4239<\/string>/);

  if (process.platform === "darwin") {
    const lint = spawnSync("plutil", ["-lint", outPath], { encoding: "utf8" });
    assert.equal(lint.status, 0, `${lint.stdout}${lint.stderr}`);
  }
});

