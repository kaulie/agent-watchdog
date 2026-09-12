#!/usr/bin/env node
/**
 * CLI around src/autostart.ts, so the shell scripts don't re-derive paths,
 * labels or unit contents.
 *
 *   node dist/autostart-cli.js info [--field unitPath]
 *   node dist/autostart-cli.js render [--out /path/to/unit]
 *   node dist/autostart-cli.js detect
 *
 * Flags: --platform --home --host --port --label --log-dir --node --jitter-sec --version
 */
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_LAUNCHD_LABEL,
  DEFAULT_SYSTEMD_UNIT,
  autostartInfo,
  detectPlatform,
  renderUnit,
  type AutostartOptions,
  type AutostartPlatform,
} from "./autostart.js";
import { loadConfig } from "./config.js";

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq > 0) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(token.slice(2), next);
      i += 1;
    } else {
      flags.set(token.slice(2), "true");
    }
  }
  return flags;
}

function readVersion(home: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(home, "VERSION"), "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function buildOptions(flags: Map<string, string>): AutostartOptions {
  const config = loadConfig();
  const requested = flags.get("platform");
  const platform: AutostartPlatform | null =
    requested === "darwin" || requested === "linux"
      ? requested
      : requested && requested !== "auto"
        ? null
        : detectPlatform();
  if (!platform) {
    throw new Error(
      `unsupported platform "${requested ?? process.platform}" (darwin and linux only)`,
    );
  }
  const home = flags.get("home") ?? config.home;
  return {
    platform,
    home,
    host: flags.get("host") ?? config.host,
    port: Number(flags.get("port") ?? config.port),
    label:
      flags.get("label") ??
      process.env.WATCHDOG_AUTOSTART_NAME?.trim() ??
      (platform === "darwin" ? DEFAULT_LAUNCHD_LABEL : DEFAULT_SYSTEMD_UNIT),
    logDir: flags.get("log-dir") ?? config.logDir,
    nodePath: flags.get("node") ?? process.execPath,
    jitterSec: Number(flags.get("jitter-sec") ?? process.env.WATCHDOG_START_JITTER_SEC ?? 0),
    version: flags.get("version") ?? process.env.WATCHDOG_VERSION ?? readVersion(home),
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "info";
  const flags = parseFlags(argv);

  if (command === "help" || flags.has("help")) {
    process.stdout.write(
      [
        "usage: autostart-cli <info|render|detect> [flags]",
        "  info    print autostart paths as JSON (--field <name> for a single value)",
        "  render  print the launchd plist / systemd unit (--out <path> to write it)",
        "  detect  print the detected platform",
        "",
      ].join("\n"),
    );
    return;
  }

  if (command === "detect") {
    const platform = flags.get("platform");
    const resolved =
      platform === "darwin" || platform === "linux" ? platform : detectPlatform();
    process.stdout.write(`${resolved ?? "unsupported"}\n`);
    return;
  }

  const options = buildOptions(flags);

  if (command === "info") {
    const info = autostartInfo(options);
    const field = flags.get("field");
    if (field) {
      const value = (info as unknown as Record<string, unknown>)[field];
      if (value === undefined) throw new Error(`unknown field "${field}"`);
      process.stdout.write(`${String(value)}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return;
  }

  if (command === "render") {
    const unit = renderUnit(options);
    const out = flags.get("out");
    if (!out || out === "-") {
      process.stdout.write(unit);
      return;
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, unit, { mode: 0o644 });
    process.stdout.write(`${out}\n`);
    return;
  }

  throw new Error(`unknown command "${command}"`);
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `[autostart-cli][错误] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
