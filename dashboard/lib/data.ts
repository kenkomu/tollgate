import {cache} from "react";
import type {Address} from "viem";
import {auditFromActivity, type AuditLog, type PolicyWithId} from "@tollgate/shared";
import {readAuditLog} from "./activity.ts";
import {listPending} from "./approvals.ts";
import {ENGINE, OWNER, abi, publicClient} from "./chain.ts";

/**
 * Shared loaders.
 *
 * Every page needs some overlapping slice of the same three reads. `cache` collapses
 * them per request, so navigating between pages never means walking the same log twice
 * inside one render, and a page that needs only the policy never pays for the log at all.
 *
 * These are per-request only. Nothing here survives into the next request, because the
 * policy has to be read fresh every time — a cached view of a spend limit is a wrong view
 * of a spend limit. The settled-history memoisation in `activity.ts` is a different thing:
 * that caches immutable blocks, not current state.
 */

export const auditFor = cache(readAuditLog);

export const pendingApprovals = cache(listPending);

/** Everything one owner runs: a policy per agent, and the switch that stops them all. */
export interface Fleet {
  /** In creation order, so "Agent 1" is the same agent on every page. */
  policies: PolicyWithId[];
  /** The owner-wide pause (ADR 0010). While set, every agent is refused. */
  fleetPaused: boolean;
}

export const fleetFor = cache(async (owner: Address): Promise<Fleet> => {
  const [ids, fleetPaused] = await Promise.all([
    publicClient.readContract({address: ENGINE, abi, functionName: "policiesOf", args: [owner]}),
    publicClient.readContract({address: ENGINE, abi, functionName: "ownerPaused", args: [owner]}),
  ]);
  const sorted = [...(ids as readonly bigint[])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const policies = await Promise.all(
    sorted.map(async (id) => {
      const raw = await publicClient.readContract({address: ENGINE, abi, functionName: "getPolicy", args: [id]});
      return {...(raw as unknown as Omit<PolicyWithId, "id">), id};
    }),
  );
  return {policies, fleetPaused: fleetPaused as boolean};
});

/**
 * The agent a page is about: the one named in `?agent=`, or the first.
 *
 * An id that is not this owner's (mistyped, revoked, someone else's) falls back to the first
 * rather than erroring, and the switcher shows which one is on screen, so nobody edits an
 * agent they did not mean to.
 */
export function pickPolicy(fleet: Fleet, agent: string | string[] | undefined): PolicyWithId | null {
  const wanted = typeof agent === "string" && /^\d+$/.test(agent) ? BigInt(agent) : null;
  return fleet.policies.find((p) => p.id === wanted) ?? fleet.policies[0] ?? null;
}

/** One agent's slice of the owner's history: its own events plus owner-wide ones. */
export function scopeAudit(audit: AuditLog, policyId: bigint): AuditLog {
  return {...auditFromActivity(audit.entries, policyId), partialFrom: audit.partialFrom};
}

/** What the agents can still spend, all together: what the shared allowance needs to cover. */
export function fleetRemaining(fleet: Fleet): bigint {
  return fleet.policies.reduce((sum, p) => sum + (p.budgetCap > p.spent ? p.budgetCap - p.spent : 0n), 0n);
}

/** The owner this deployment is configured for. They may run many agents (ADR 0010). */
export const owner = OWNER;

/**
 * Reads that are allowed to fail.
 *
 * Arc's public endpoint rate-limits and, under load, times out. Letting that propagate turns
 * "the chain is briefly slow" into a 500 and tells the owner nothing — worst of all during a
 * demo, where it reads as the product being broken rather than the endpoint being busy.
 *
 * The result type is deliberate: callers cannot forget to handle the failure, because there
 * is no policy to read until they check. Showing stale numbers instead would be the more
 * dangerous choice — every figure on these pages is a claim about what an agent may spend
 * right now, and a stale one is a false claim.
 */
export type Read<T> = {ok: true; value: T} | {ok: false; error: string};

async function attempt<T>(work: () => Promise<T>): Promise<Read<T>> {
  try {
    return {ok: true, value: await work()};
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    return {ok: false, error: raw.split("\n")[0] ?? raw};
  }
}

export function tryFleet(who: Address): Promise<Read<Fleet>> {
  return attempt(() => fleetFor(who));
}

export function tryAudit(who: Address): Promise<Read<Awaited<ReturnType<typeof auditFor>>>> {
  return attempt(() => auditFor(who));
}
