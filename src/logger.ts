type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.WATCHDOG_LOG_LEVEL || "info").toLowerCase() as Level;
  return ORDER[raw] ?? ORDER.info;
}

function emit(level: Level, message: string, extra?: unknown): void {
  if (ORDER[level] < threshold()) return;
  const line = `[watchdog] ${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  if (extra === undefined) stream.write(`${line}\n`);
  else stream.write(`${line} ${safe(extra)}\n`);
}

function safe(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (m: string, e?: unknown) => emit("debug", m, e),
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};
