import os from "node:os";
import path from "node:path";

/**
 * OS-level autostart for the watchdog itself.
 *
 * Design intent: the watchdog must not depend on *anybody else* to be running —
 * not on the monitored app, not on the deployment control plane. Once installed,
 * the OS service manager (launchd on macOS, systemd --user on Linux) owns the
 * process: it starts it with the machine and keeps it alive if it dies.
 *
 * That makes launchd/systemd, not `scripts/start.sh`, the single owner of the
 * process lifetime. `scripts/start.sh` / `stop.sh` detect the registration and
 * delegate instead of spawning a second, unsupervised copy.
 *
 * Paths, labels and environment live here (and are unit-tested in
 * test/autostart.test.ts) so the shell scripts never duplicate that knowledge.
 */

export type AutostartPlatform = "darwin" | "linux";

/** launchd Label — mirrors the machine's `ai.hermes.*` namespace. */
export const DEFAULT_LAUNCHD_LABEL = "ai.hermes.agent-watchdog";
/** systemd --user unit file name. */
export const DEFAULT_SYSTEMD_UNIT = "agent-watchdog.service";
/** Foreground entrypoint the OS service manager executes. */
export const RUN_SERVICE_ENTRY = path.join("scripts", "run-service.sh");
/** launchd/systemd get a minimal PATH; keep it explicit and absolute. */
export const FALLBACK_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export interface AutostartOptions {
  platform: AutostartPlatform;
  /** Install root, e.g. /Users/gaolei/runtime/agent-watchdog */
  home: string;
  host: string;
  port: number;
  /** launchd Label (also used as the identifier inside the systemd unit). */
  label: string;
  /** Where launchd/systemd redirect the service's stdout/stderr. */
  logDir: string;
  /** Absolute node binary used to run dist/index.js. */
  nodePath: string;
  /** Cap of the randomized startup delay in seconds (0 = start immediately). */
  jitterSec: number;
  /** Optional version recorded in the unit for traceability. */
  version?: string | null;
}

export interface AutostartInfo {
  platform: AutostartPlatform;
  label: string;
  unitName: string;
  unitPath: string;
  runEntry: string;
  home: string;
  logDir: string;
  stdoutLog: string;
  stderrLog: string;
}

export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
): AutostartPlatform | null {
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  return null;
}

export function launchAgentPlistPath(label: string, homeDir: string = os.homedir()): string {
  return path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
}

export function systemdUserUnitPath(
  unitName: string = DEFAULT_SYSTEMD_UNIT,
  homeDir: string = os.homedir(),
): string {
  return path.join(homeDir, ".config", "systemd", "user", unitName);
}

function normalizeUnitName(platform: AutostartPlatform, label: string): string {
  if (platform === "darwin") return `${label}.plist`;
  return label.endsWith(".service") ? label : `${label}.service`;
}

export function unitPathFor(options: AutostartOptions, homeDir: string = os.homedir()): string {
  const unitName = normalizeUnitName(options.platform, options.label);
  return options.platform === "darwin"
    ? launchAgentPlistPath(options.label, homeDir)
    : systemdUserUnitPath(unitName, homeDir);
}

export function autostartInfo(options: AutostartOptions, homeDir?: string): AutostartInfo {
  return {
    platform: options.platform,
    label: options.label,
    unitName: normalizeUnitName(options.platform, options.label),
    unitPath: unitPathFor(options, homeDir),
    runEntry: path.join(options.home, RUN_SERVICE_ENTRY),
    home: options.home,
    logDir: options.logDir,
    stdoutLog: path.join(options.logDir, "service.log"),
    stderrLog: path.join(options.logDir, "service.error.log"),
  };
}

/** PATH for the OS-owned process: keep order, drop duplicates. */
export function buildPath(prepend: string, fallback: string = FALLBACK_PATH): string {
  const parts: string[] = [];
  for (const dir of `${prepend}:${fallback}`.split(":")) {
    if (dir.length > 0 && !parts.includes(dir)) parts.push(dir);
  }
  return parts.join(":");
}

/** Environment the OS-owned process needs; the single place it is defined. */
export function serviceEnvironment(options: AutostartOptions): Array<[string, string]> {
  const pairs: Array<[string, string]> = [
    ["WATCHDOG_HOME", options.home],
    ["WATCHDOG_HOST", options.host],
    ["WATCHDOG_PORT", String(options.port)],
    ["WATCHDOG_START_JITTER_SEC", String(Math.max(0, options.jitterSec))],
    ["PATH", buildPath(path.dirname(options.nodePath))],
  ];
  if (options.version) pairs.push(["WATCHDOG_VERSION", options.version]);
  return pairs;
}

export function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Quote a value for a systemd `Environment=` / `ExecStart=` assignment. */
export function systemdEscape(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderLaunchdPlist(options: AutostartOptions, homeDir?: string): string {
  const info = autostartInfo(options, homeDir);
  const env = serviceEnvironment(options)
    .map(
      ([key, value]) => `        <key>${xmlEscape(key)}</key>
        <string>${xmlEscape(value)}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by agent-watchdog src/autostart.ts — edit that file, not this one. -->
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(options.label)}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${xmlEscape(info.runEntry)}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${xmlEscape(options.home)}</string>

    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>

    <!-- RunAtLoad = 随开机/登录即启动；KeepAlive = 进程退出即被拉起（谁来看门狗） -->
    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <!-- 崩溃循环保护：两次拉起间隔至少 10s -->
    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>ProcessType</key>
    <string>Background</string>

    <key>StandardOutPath</key>
    <string>${xmlEscape(info.stdoutLog)}</string>

    <key>StandardErrorPath</key>
    <string>${xmlEscape(info.stderrLog)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(options: AutostartOptions, homeDir?: string): string {
  const info = autostartInfo(options, homeDir);
  const env = serviceEnvironment(options)
    .map(([key, value]) => `Environment=${systemdEscape(`${key}=${value}`)}`)
    .join("\n");
  return `# Generated by agent-watchdog src/autostart.ts — edit that file, not this one.
[Unit]
Description=agent-watchdog — independent supervision control plane (HTTP :${options.port})
Documentation=file://${info.home}/README.md
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${info.home}
${env}
ExecStart=/bin/bash ${info.runEntry}
# 随开机启动 + 退出即被拉起
Restart=always
RestartSec=5
TimeoutStopSec=30
KillMode=mixed
StandardOutput=append:${info.stdoutLog}
StandardError=append:${info.stderrLog}

[Install]
WantedBy=default.target
`;
}

export function renderUnit(options: AutostartOptions, homeDir?: string): string {
  return options.platform === "darwin"
    ? renderLaunchdPlist(options, homeDir)
    : renderSystemdUnit(options, homeDir);
}
