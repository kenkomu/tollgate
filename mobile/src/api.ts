import Constants from "expo-constants";
import type {Activity} from "@tollgate/shared";

/**
 * Talking to the service.
 *
 * One rule governs this whole file, from ADR 0007:
 *
 *   **A phone that cannot reach the chain must say so, loudly.**
 *
 * It is the worst failure available to this product. Every number the app shows is a claim
 * about what an agent is allowed to spend *right now*; showing a cached one during an outage
 * tells an owner their agent is bounded when the app has no idea whether it is. So there is no
 * silent cache here, no stale-while-revalidate, and no default that hides a failure. A read
 * either succeeds and carries its own age, or it fails and says so.
 */

/**
 * Where the service lives.
 *
 * Resolved from the Metro host rather than configured, because a hardcoded LAN address is
 * wrong the moment DHCP hands out a different one — which it did, silently, and the app
 * correctly reported that it could not reach anything while looking like it had no data.
 *
 * `hostUri` is whatever the phone used to reach the dev server, so by construction it is an
 * address this device can route to. An explicit `extra.apiUrl` still wins, for a deployed
 * backend that is not on the dev machine.
 */
const SERVICE_PORT = 8080;

function resolveApiUrl(): string {
  const configured = Constants.expoConfig?.extra?.apiUrl as string | undefined;
  if (configured) return configured;

  // e.g. "192.168.100.41:8081" — the host serving this bundle.
  const host = Constants.expoConfig?.hostUri?.split(":")[0];
  if (host) return `http://${host}:${SERVICE_PORT}`;

  return `http://localhost:${SERVICE_PORT}`;
}

const API_URL = resolveApiUrl();

/** Never let a dead network hang a screen. A phone on a bad connection needs an answer. */
const TIMEOUT_MS = 8_000;

export class OfflineError extends Error {
  constructor(cause?: unknown) {
    super(
      "Cannot reach Tollgate. Nothing shown here can be trusted until this clears — " +
        "and no policy has changed, because reading is all the app was doing.",
    );
    this.name = "OfflineError";
    this.cause = cause;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {"content-type": "application/json", ...init?.headers},
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return (await response.json()) as T;
  } catch (error) {
    // A timeout, a refused connection and a DNS failure are all the same thing to the owner:
    // we do not know the current state. Collapsing them is honest, not lazy.
    throw new OfflineError(error);
  } finally {
    clearTimeout(timer);
  }
}

/** Amounts cross the wire as decimal strings, because JSON has no bigint. */
function toBigint(value: unknown): bigint | undefined {
  return value === null || value === undefined ? undefined : BigInt(String(value));
}

export interface Health {
  ok: boolean;
  engine: string;
  owner: string;
  /** The last block the service has indexed, or null before its first pass. */
  indexedThrough: string | null;
  chainHead: string | null;
  events: number;
}

export interface Freshness {
  /** How many blocks the projection is behind the chain. */
  behind: number | null;
  /** Roughly how long ago that is, at Arc's ~2 blocks per second. */
  secondsBehind: number | null;
  /** True when the data is recent enough to act on without a caveat. */
  current: boolean;
}

/**
 * How stale is what we are looking at?
 *
 * Computed rather than assumed, and surfaced on every screen that shows policy state. A client
 * that cannot tell how old its data is has to treat it as current, and treating a stale spend
 * limit as current is precisely the failure this app must not have.
 */
export function freshnessOf(health: Health): Freshness {
  if (!health.indexedThrough || !health.chainHead) {
    return {behind: null, secondsBehind: null, current: false};
  }
  const behind = Number(BigInt(health.chainHead) - BigInt(health.indexedThrough));
  const secondsBehind = Math.round(behind / 2);
  // 128 blocks is about a minute on Arc, and the indexer deliberately stops 64 behind the tip
  // so it never stores anything a reorg could invalidate. Anything inside that is expected.
  return {behind, secondsBehind, current: behind <= 128};
}

export async function getHealth(): Promise<Health> {
  return request<Health>("/health");
}

export interface ActivityPage {
  indexedThrough: string | null;
  entries: Activity[];
}

export async function getActivity(limit = 50): Promise<ActivityPage> {
  const raw = await request<{indexedThrough: string | null; entries: Record<string, unknown>[]}>(
    `/activity?limit=${limit}`,
  );
  return {
    indexedThrough: raw.indexedThrough,
    entries: raw.entries.map((entry) => ({
      ...(entry as unknown as Activity),
      blockNumber: BigInt(String(entry.blockNumber)),
      amount: toBigint(entry.amount),
      spentTotal: toBigint(entry.spentTotal),
      detail: entry.detail
        ? {
            label: String((entry.detail as {label: string}).label),
            values: (entry.detail as {values: string[]}).values.map((v) => BigInt(v)),
          }
        : undefined,
    })),
  };
}

export interface Approval {
  id: string;
  owner: string;
  serviceId: string;
  serviceName: string;
  payee: string;
  amount: string;
  why: string;
  requestedAt: number;
  resolvedAt: number | null;
  outcome: "approved" | "declined" | null;
}

export async function getApprovals(): Promise<Approval[]> {
  return (await request<{approvals: Approval[]}>("/approvals")).approvals;
}

export async function getApproval(id: string): Promise<Approval> {
  return request<Approval>(`/approvals/${encodeURIComponent(id)}`);
}

/**
 * Record a decision on an approval request.
 *
 * Worth saying plainly, because the name invites the wrong assumption: **this grants nothing.**
 * Allowlisting a payee is `setPayee` signed by the owner's key. This closes the request so it
 * stops appearing here and on any other device. Until the owner signs, the agent stays refused.
 */
export async function resolveApproval(id: string, outcome: "approved" | "declined"): Promise<void> {
  await request(`/approvals/${encodeURIComponent(id)}/resolve`, {
    method: "POST",
    body: JSON.stringify({outcome}),
  });
}

export async function registerDevice(token: string): Promise<void> {
  await request("/devices", {method: "POST", body: JSON.stringify({token, platform: "android"})});
}

export {API_URL};
