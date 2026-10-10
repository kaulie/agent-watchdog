/**
 * Deployment-platform catalog (:4220) — fetch + map to watchdog contracts.
 *
 * Watchdog does not talk to :4240. The deploy control plane is already the
 * merged view (registry identity + local runtimeDir / startCmd / health).
 */

export interface DeployService {
  serviceId?: string;
  name?: string;
  runtimeDir?: string;
  healthUrl?: string;
  port?: number;
  startCmd?: string;
  stopCmd?: string;
  restartCmd?: string;
  configured?: boolean;
  /** When set, overrides the watchdog allowlist: true=supervise, false=skip. */
  supervise?: boolean;
  /** Probe cadence in seconds. Watchdog applies this on sync when present. */
  intervalSec?: number;
}

export interface InventoryMachine {
  machineId?: string;
  host?: string;
}

export interface DeployInventory {
  services?: Array<{
    serviceId?: string;
    machines?: InventoryMachine[];
  }>;
}

export interface DeployCatalog {
  services: DeployService[];
  inventory: DeployInventory | null;
}

export interface DesiredContract {
  serviceId: string;
  name: string;
  probeTarget: string;
  runtimeDir: string;
  startCmd: string;
  restartCmd: string | null;
  stopCmd: string | null;
  intervalSec?: number;
}

export interface SkippedService {
  serviceId: string;
  reason: string;
}

export type CatalogFetchResult =
  | { ok: true; catalog: DeployCatalog }
  | { ok: false; error: string };

export async function fetchDeployCatalog(opts: {
  deployUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<CatalogFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.deployUrl.replace(/\/$/, "");
  try {
    const servicesRaw = await getJson(
      fetchImpl,
      `${base}/api/services`,
      opts.timeoutMs,
    );
    const services = extractServices(servicesRaw);
    let inventory: DeployInventory | null = null;
    try {
      const invRaw = await getJson(
        fetchImpl,
        `${base}/api/deployment-inventory`,
        opts.timeoutMs,
      );
      inventory = extractInventory(invRaw);
    } catch {
      inventory = null;
    }
    return { ok: true, catalog: { services, inventory } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`${url} returned HTTP ${res.status}`);
  }
  return res.json();
}

function extractServices(raw: unknown): DeployService[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(obj.services)
      ? obj.services
      : [];
  return list.filter(
    (item): item is DeployService =>
      !!item && typeof item === "object" && !Array.isArray(item),
  );
}

function extractInventory(raw: unknown): DeployInventory {
  if (!raw || typeof raw !== "object") return { services: [] };
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj.services) ? obj.services : [];
  return {
    services: list.filter(
      (item): item is NonNullable<DeployInventory["services"]>[number] =>
        !!item && typeof item === "object",
    ),
  };
}

/** Rewrite a deploy healthUrl into a loopback probe target. */
export function composeProbeTarget(
  port: number,
  healthUrl: string,
  bindHost = "127.0.0.1",
): string {
  const raw = (healthUrl || "").trim();
  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    u.hostname = bindHost;
    u.port = String(port);
    return u.toString();
  }
  const path = raw ? (raw.startsWith("/") ? raw : `/${raw}`) : "/health";
  return `http://${bindHost}:${port}${path}`;
}

export function hasLocalInstance(
  serviceId: string,
  inventory: DeployInventory | null,
): boolean {
  if (!inventory) return true;
  const svc = (inventory.services ?? []).find((s) => s.serviceId === serviceId);
  if (!svc) return true;
  const machines = svc.machines ?? [];
  if (machines.length === 0) return true;
  return machines.some(
    (m) =>
      m.machineId === "local" ||
      m.machineId === "127.0.0.1" ||
      m.host === "127.0.0.1" ||
      m.host === "localhost",
  );
}

function catalogIntervalSec(raw: unknown): number | undefined {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 2 || n > 86_400) return undefined;
  return n;
}

function isComplete(svc: DeployService): string | null {
  const id = (svc.serviceId ?? "").trim();
  if (!id) return "missing serviceId";
  if (svc.configured === false) return "not configured";
  const port = Number(svc.port);
  if (!Number.isFinite(port) || port <= 0) return "missing port";
  if (!(svc.runtimeDir ?? "").trim()) return "missing runtimeDir";
  if (!(svc.startCmd ?? "").trim()) return "missing startCmd";
  return null;
}

export function selectDesired(
  catalog: DeployCatalog,
  opts: { allow: string[] | "*"; exclude: readonly string[] },
): { desired: DesiredContract[]; skipped: SkippedService[] } {
  const exclude = new Set(opts.exclude);
  const allowAll = opts.allow === "*";
  const allow = allowAll ? null : new Set(opts.allow);
  const desired: DesiredContract[] = [];
  const skipped: SkippedService[] = [];

  for (const svc of catalog.services) {
    const id = (svc.serviceId ?? "").trim();
    if (!id) {
      skipped.push({ serviceId: "(missing)", reason: "missing serviceId" });
      continue;
    }
    if (exclude.has(id)) {
      skipped.push({ serviceId: id, reason: "excluded (self or denylist)" });
      continue;
    }
    if (svc.supervise === false) {
      skipped.push({ serviceId: id, reason: "supervise disabled" });
      continue;
    }
    if (svc.supervise !== true && allow && !allow.has(id)) {
      skipped.push({ serviceId: id, reason: "not on allowlist" });
      continue;
    }
    const incomplete = isComplete(svc);
    if (incomplete) {
      skipped.push({ serviceId: id, reason: incomplete });
      continue;
    }
    if (!hasLocalInstance(id, catalog.inventory)) {
      skipped.push({ serviceId: id, reason: "no local instance" });
      continue;
    }
    desired.push({
      serviceId: id,
      name: (svc.name ?? "").trim() || id,
      probeTarget: composeProbeTarget(Number(svc.port), svc.healthUrl ?? ""),
      runtimeDir: (svc.runtimeDir ?? "").trim(),
      startCmd: (svc.startCmd ?? "").trim(),
      restartCmd: (svc.restartCmd ?? "").trim() || null,
      stopCmd: (svc.stopCmd ?? "").trim() || null,
      intervalSec: catalogIntervalSec(svc.intervalSec),
    });
  }
  return { desired, skipped };
}
