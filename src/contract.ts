import type { Config } from "./config.js";
import type {
  ProbeType,
  RemediationAction,
  ServiceContract,
} from "./types.js";

/** Partial contract accepted from the API / seed files. */
export interface ContractInput {
  serviceId?: string;
  name?: string;
  enabled?: boolean;
  group?: string;
  probeType?: ProbeType;
  probeTarget?: string;
  probeTimeoutMs?: number;
  intervalSec?: number;
  expectStatus?: number | null;
  expectBodyContains?: string | null;
  remediation?: RemediationAction;
  runtimeDir?: string | null;
  startCmd?: string | null;
  restartCmd?: string | null;
  stopCmd?: string | null;
  failureThreshold?: number;
  successThreshold?: number;
  cooldownSec?: number;
  maxRemediationsPerHour?: number;
}

export class ContractError extends Error {}

function pick<T>(value: T | undefined, fallback: T | undefined, def: T): T {
  if (value !== undefined) return value;
  if (fallback !== undefined) return fallback;
  return def;
}

/**
 * Merge a partial input over an existing contract (for PUT) or the configured
 * defaults (for create), producing a complete, validated ServiceContract.
 */
export function buildContract(
  input: ContractInput,
  config: Config,
  existing?: ServiceContract,
): ServiceContract {
  const serviceId = (input.serviceId ?? existing?.serviceId ?? "").trim();
  if (!serviceId) throw new ContractError("serviceId is required");
  if (!/^[a-zA-Z0-9._-]+$/.test(serviceId)) {
    throw new ContractError("serviceId may only contain [a-zA-Z0-9._-]");
  }

  const probeType: ProbeType = pick(
    input.probeType,
    existing?.probeType,
    "http",
  );
  if (probeType !== "http" && probeType !== "command") {
    throw new ContractError(`unsupported probeType: ${probeType}`);
  }
  const probeTarget = (pick(input.probeTarget, existing?.probeTarget, "")).trim();
  if (!probeTarget) throw new ContractError("probeTarget is required");

  const remediation: RemediationAction = pick(
    input.remediation,
    existing?.remediation,
    "start",
  );
  if (!["start", "restart", "stop", "none"].includes(remediation)) {
    throw new ContractError(`unsupported remediation: ${remediation}`);
  }

  return {
    serviceId,
    name: pick(input.name, existing?.name, serviceId),
    enabled: pick(input.enabled, existing?.enabled, true),
    group: pick(input.group, existing?.group, "default"),

    probeType,
    probeTarget,
    probeTimeoutMs: clampInt(
      pick(input.probeTimeoutMs, existing?.probeTimeoutMs, config.defaultTimeoutMs),
      100,
      600_000,
    ),
    intervalSec: clampInt(
      pick(input.intervalSec, existing?.intervalSec, config.defaultIntervalSec),
      2,
      86_400,
    ),
    expectStatus:
      input.expectStatus !== undefined
        ? input.expectStatus
        : (existing?.expectStatus ?? (probeType === "http" ? 200 : null)),
    expectBodyContains:
      input.expectBodyContains !== undefined
        ? input.expectBodyContains
        : (existing?.expectBodyContains ?? null),

    remediation,
    runtimeDir:
      input.runtimeDir !== undefined
        ? input.runtimeDir
        : (existing?.runtimeDir ?? null),
    startCmd:
      input.startCmd !== undefined ? input.startCmd : (existing?.startCmd ?? null),
    restartCmd:
      input.restartCmd !== undefined
        ? input.restartCmd
        : (existing?.restartCmd ?? null),
    stopCmd:
      input.stopCmd !== undefined ? input.stopCmd : (existing?.stopCmd ?? null),

    failureThreshold: clampInt(
      pick(
        input.failureThreshold,
        existing?.failureThreshold,
        config.defaultFailureThreshold,
      ),
      1,
      100,
    ),
    successThreshold: clampInt(
      pick(
        input.successThreshold,
        existing?.successThreshold,
        config.defaultSuccessThreshold,
      ),
      1,
      100,
    ),
    cooldownSec: clampInt(
      pick(input.cooldownSec, existing?.cooldownSec, config.defaultCooldownSec),
      0,
      86_400,
    ),
    maxRemediationsPerHour: clampInt(
      pick(
        input.maxRemediationsPerHour,
        existing?.maxRemediationsPerHour,
        config.defaultMaxRemediationsPerHour,
      ),
      1,
      1000,
    ),

    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
