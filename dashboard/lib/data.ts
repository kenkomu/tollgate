import {cache} from "react";
import type {Address} from "viem";
import type {Policy} from "@tollgate/shared";
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

export const policyFor = cache(async (owner: Address): Promise<Policy> => {
  const raw = await publicClient.readContract({
    address: ENGINE,
    abi,
    functionName: "getPolicy",
    args: [owner],
  });
  return raw as unknown as Policy;
});

/** The owner this deployment is configured for. One policy per owner, per ADR 0004. */
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

export function tryPolicy(who: Address): Promise<Read<Policy>> {
  return attempt(() => policyFor(who));
}

export function tryAudit(who: Address): Promise<Read<Awaited<ReturnType<typeof auditFor>>>> {
  return attempt(() => auditFor(who));
}
