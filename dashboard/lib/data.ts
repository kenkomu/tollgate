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
