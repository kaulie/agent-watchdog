import type { FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { buildContract, ContractError, type ContractInput } from "./contract.js";
import type { Store } from "./db.js";
import type { MonitorEngine } from "./engine.js";
import type { PauseController } from "./pause.js";
import type { RemediationAction } from "./types.js";

export interface RouteDeps {
  store: Store;
  config: Config;
  engine: MonitorEngine;
  pause: PauseController;
  version: string;
  startedAt: number;
}

const ACTIONS: RemediationAction[] = ["start", "restart", "stop", "none"];

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, config, engine, pause } = deps;

  app.get("/health", async () => ({
    ok: true,
    service: "agent-watchdog",
    version: deps.version,
    home: config.home,
    uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000),
    time: new Date().toISOString(),
  }));

  app.get("/", async () => ({
    service: "agent-watchdog",
    version: deps.version,
    endpoints: {
      health: "GET /health",
      services: "GET|POST /api/services, GET|PUT|DELETE /api/services/:id",
      state: "GET /api/state, GET /api/state/:id",
      probe: "POST /api/services/:id/probe",
      remediate: "POST /api/services/:id/remediate {action?}",
      events: "GET /api/events?serviceId=&type=&limit=",
      remediations: "GET /api/remediations?serviceId=&limit=",
      pause: "GET|POST|DELETE /api/pause",
      stats: "GET /api/stats",
    },
    stats: store.stats(),
  }));

  // ---- services ----------------------------------------------------------

  app.get("/api/services", async () => ({
    services: store.listServices().map((svc) => ({
      contract: svc,
      state: engine.getStatus(svc.serviceId),
    })),
  }));

  app.get<{ Params: { serviceId: string } }>(
    "/api/services/:serviceId",
    async (req, reply) => {
      const svc = store.getService(req.params.serviceId);
      if (!svc) return reply.code(404).send({ error: "service not found" });
      return { contract: svc, state: engine.getStatus(svc.serviceId) };
    },
  );

  app.put<{ Params: { serviceId: string }; Body: ContractInput }>(
    "/api/services/:serviceId",
    async (req, reply) => {
      const existing = store.getService(req.params.serviceId);
      try {
        const contract = buildContract(
          { ...(req.body ?? {}), serviceId: req.params.serviceId },
          config,
          existing,
        );
        store.upsertService(contract);
        store.appendEvent({
          serviceId: contract.serviceId,
          type: "service_upsert",
          level: "info",
          message: `service ${contract.serviceId} ${existing ? "updated" : "created"}`,
          data: { probeTarget: contract.probeTarget },
        });
        return reply.code(existing ? 200 : 201).send({
          contract,
          state: engine.getStatus(contract.serviceId),
        });
      } catch (err) {
        if (err instanceof ContractError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { serviceId: string } }>(
    "/api/services/:serviceId",
    async (req, reply) => {
      const existed = store.deleteService(req.params.serviceId);
      if (!existed) return reply.code(404).send({ error: "service not found" });
      store.appendEvent({
        serviceId: req.params.serviceId,
        type: "service_delete",
        level: "warn",
        message: `service ${req.params.serviceId} removed`,
      });
      return { ok: true };
    },
  );

  // ---- state / actions ---------------------------------------------------

  app.get("/api/state", async () => ({ states: engine.getStatuses() }));

  app.get<{ Params: { serviceId: string } }>(
    "/api/state/:serviceId",
    async (req, reply) => {
      const status = engine.getStatus(req.params.serviceId);
      if (!status) return reply.code(404).send({ error: "service not found" });
      return status;
    },
  );

  app.post<{ Params: { serviceId: string }; Body: { remediate?: boolean } }>(
    "/api/services/:serviceId/probe",
    async (req, reply) => {
      const status = await engine.probeNow(
        req.params.serviceId,
        req.body?.remediate === true,
      );
      if (!status) return reply.code(404).send({ error: "service not found" });
      return status;
    },
  );

  app.post<{ Params: { serviceId: string }; Body: { action?: RemediationAction } }>(
    "/api/services/:serviceId/remediate",
    async (req, reply) => {
      const action = req.body?.action;
      if (action && !ACTIONS.includes(action)) {
        return reply.code(400).send({ error: `unsupported action: ${action}` });
      }
      const result = await engine.remediateNow(req.params.serviceId, action);
      if (!result) return reply.code(404).send({ error: "service not found" });
      return reply.code(202).send(result);
    },
  );

  // ---- history -----------------------------------------------------------

  app.get<{
    Querystring: { serviceId?: string; type?: string; limit?: string };
  }>("/api/events", async (req) => ({
    events: store.listEvents({
      serviceId: req.query.serviceId,
      type: req.query.type,
      limit: req.query.limit ? Number(req.query.limit) : 100,
    }),
  }));

  app.get<{
    Querystring: { serviceId?: string; limit?: string };
  }>("/api/remediations", async (req) => ({
    remediations: store.listRemediations({
      serviceId: req.query.serviceId,
      limit: req.query.limit ? Number(req.query.limit) : 50,
    }),
  }));

  // ---- pause -------------------------------------------------------------

  app.get("/api/pause", async () => pause.snapshot());

  app.post<{
    Body: { seconds?: number; reason?: string; serviceId?: string };
  }>("/api/pause", async (req, reply) => {
    const seconds = Number(req.body?.seconds ?? 0);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return reply.code(400).send({ error: "seconds must be a positive number" });
    }
    const serviceId = req.body?.serviceId?.trim() || undefined;
    const info = pause.pause({
      seconds,
      reason: req.body?.reason,
      serviceId,
    });
    store.appendEvent({
      serviceId: serviceId ?? null,
      type: "pause",
      level: "info",
      message: `paused ${serviceId ?? "all services"} for ${Math.floor(seconds)}s (${info.reason})`,
      data: { ...info, seconds: Math.floor(seconds) },
    });
    return reply.code(202).send(info);
  });

  app.delete<{ Querystring: { serviceId?: string } }>(
    "/api/pause",
    async (req) => {
      const serviceId = req.query.serviceId?.trim() || undefined;
      pause.resume(serviceId);
      store.appendEvent({
        serviceId: serviceId ?? null,
        type: "pause",
        level: "info",
        message: `resumed ${serviceId ?? "all services"}`,
      });
      return { ok: true };
    },
  );

  // ---- stats -------------------------------------------------------------

  app.get("/api/stats", async () => {
    const states = engine.getStatuses();
    const byState = { up: 0, down: 0, unknown: 0 };
    for (const s of states) byState[s.state] += 1;
    return {
      version: deps.version,
      uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000),
      registry: store.stats(),
      states: byState,
    };
  });
}
