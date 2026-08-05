import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import type {Address} from "viem";

/**
 * Where the agent files a payee-approval request for the owner.
 *
 * A plain JSON file shared with the dashboard. It carries no authority — the allowlist
 * lives on chain, and nothing in this file grants anything until the owner signs a
 * `setPayee` transaction. Losing it loses a request, not a control.
 */

const STORE = resolve(process.cwd(), "..", ".tollgate", "approvals.json");

export interface ApprovalRequest {
  id: string;
  serviceId: string;
  serviceName: string;
  payee: Address;
  amount: string;
  why: string;
  requestedAt: number;
}

export async function fileRequest(request: Omit<ApprovalRequest, "id" | "requestedAt">): Promise<void> {
  let all: ApprovalRequest[] = [];
  try {
    all = JSON.parse(await readFile(STORE, "utf8")) as ApprovalRequest[];
  } catch {
    all = [];
  }
  // An agent that asks twice should not queue twice.
  if (all.some((r) => r.payee.toLowerCase() === request.payee.toLowerCase())) return;
  all.push({...request, id: `${Date.now()}-${request.payee}`, requestedAt: Date.now()});
  await mkdir(dirname(STORE), {recursive: true});
  await writeFile(STORE, JSON.stringify(all, null, 2));
}
