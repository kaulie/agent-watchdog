import Fastify from "fastify";
import cors from "@fastify/cors";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { MonitorEngine } from "./engine.js";
import { log } from "./logger.js";
import { PauseController } from "./pause.js";
import { registerRoutes } from "./routes.js";
import { seedDefaults } from "./seed.js";

const config = loadConfig();

function resolveVersion(): string {
  if (process.env.WATCHDOG_VERSION?.trim()) {
    return process.env.WATCHDOG_VERSION.trim();
  }
  try {
    return fs.readFileSync(path.join(config.home, "VERSION"), "utf8").trim();
  } catch {
    return "dev";
  }
}

const version = resolveVersion();
const startedAt = Date.now();

const store = new Store(config.dbPath);
seedDefaults(store, config);

const pause = new PauseController(config);
const engine = new MonitorEngine(store, config, pause);

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });

registerRoutes(app, { store, config, engine, pause, version, startedAt });

const pidFile = path.join(config.home, "watchdog.pid");
fs.writeFileSync(pidFile, `${process.pid}\n`);

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutting down (${signal})`);
  engine.stop();
  try {
    store.appendEvent({
      type: "system",
      message: `watchdog stopped (${signal})`,
    });
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(pidFile);
  } catch {
    /* ignore */
  }
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

process.on("unhandledRejection", (err) => {
  log.error("unhandledRejection", err instanceof Error ? err.stack : err);
});
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", err.stack ?? err);
});

await app.listen({ host: config.host, port: config.port });

store.appendEvent({
  type: "system",
  message: `watchdog started v${version} on ${config.host}:${config.port}`,
  data: { home: config.home, tickMs: config.tickMs },
});

engine.start();
log.info(
  `agent-watchdog v${version} listening on http://${config.host}:${config.port} home=${config.home}`,
);
log.info(`monitoring ${store.listServices().length} service(s)`);
