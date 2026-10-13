"use server";

import {revalidatePath} from "next/cache";
import type {Address} from "viem";
import {removeRequest} from "./approvals.ts";

/**
 * The only thing left on the server.
 *
 * The approval queue is a JSON file shared between the agent process and this app, so
 * clearing an entry needs the filesystem. It carries no authority: the allowlist itself is
 * on chain, and dismissing a request here grants nothing and revokes nothing. Losing this
 * file loses a request, not a control.
 *
 * Everything that moves money or changes policy is signed in the owner's browser — see
 * `lib/owner.ts`. Nothing in this file can authorise a payment.
 */
export async function clearRequest(payee: Address, outcome: "approved" | "declined"): Promise<void> {
  await removeRequest(payee, outcome);
  revalidatePath("/payees");
  revalidatePath("/");
}
