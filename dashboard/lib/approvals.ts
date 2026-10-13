import {readFile, writeFile, mkdir} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import type {Address} from "viem";

/**
 * Pending payee-approval requests.
 *
 * A strict allowlist (ADR 0003) means an agent that discovers a new supplier has exactly one
 * route forward: ask the owner. This is where those asks queue up.
 *
 * Read from the service when it is running, and from the local JSON file when it is not. The
 * agent writes to the same pair with the same preference, so both surfaces show the same queue
 * — they previously did not, and an escalation the agent believed it had raised reached the
 * dashboard but never the phone.
 *
 * Neither store carries authority. The allowlist itself is on chain, and approving here does
 * nothing until the owner signs a `setPayee` transaction. Losing either store loses a request,
 * not a control.
 */

const STORE = resolve(process.cwd(), "..", ".tollgate", "approvals.json");
const SERVICE_URL = process.env.TOLLGATE_SERVICE_URL ?? "http://localhost:8080";

export interface ApprovalRequest {
  id: string;
  serviceId: string;
  serviceName: string;
  payee: Address;
  amount: string;
  why: string;
  requestedAt: number;
}

interface ServiceApproval {
  id: string;
  serviceId: string;
  serviceName: string;
  payee: Address;
  amount: string;
  why: string;
  requestedAt: number;
}

async function fromService(): Promise<ApprovalRequest[] | null> {
  try {
    const response = await fetch(`${SERVICE_URL}/approvals`, {
      signal: AbortSignal.timeout(3_000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {approvals: ServiceApproval[]};
    return body.approvals;
  } catch {
    // Not running. The local file is the fallback, not an error.
    return null;
  }
}

async function fromDisk(): Promise<ApprovalRequest[]> {
  try {
    return JSON.parse(await readFile(STORE, "utf8")) as ApprovalRequest[];
  } catch {
    return [];
  }
}

async function writeAll(requests: ApprovalRequest[]): Promise<void> {
  await mkdir(dirname(STORE), {recursive: true});
  await writeFile(STORE, JSON.stringify(requests, null, 2));
}

/** A request and, once the owner has answered it, how. */
export interface ApprovalRecord extends ApprovalRequest {
  resolvedAt: number | null;
  outcome: "approved" | "declined" | null;
}

/**
 * One request by id, open or answered. What a notification links to: the owner may tap it
 * after deciding somewhere else, and should see that rather than a missing page.
 */
export async function getRequest(id: string): Promise<ApprovalRecord | null> {
  try {
    const response = await fetch(`${SERVICE_URL}/approvals/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(3_000),
      cache: "no-store",
    });
    if (response.ok) return (await response.json()) as ApprovalRecord;
    if (response.status === 404) return null;
  } catch {
    // Not running; the local file may still have it.
  }
  const local = (await fromDisk()).find((r) => r.id === id);
  return local ? {...local, resolvedAt: null, outcome: null} : null;
}

export async function listPending(): Promise<ApprovalRequest[]> {
  return (await fromService()) ?? (await fromDisk());
}

export async function addRequest(request: Omit<ApprovalRequest, "id" | "requestedAt">): Promise<void> {
  const all = await fromDisk();
  // One pending request per payee — an agent that asks twice should not queue twice.
  if (all.some((r) => r.payee.toLowerCase() === request.payee.toLowerCase())) return;
  all.push({...request, id: `${Date.now()}-${request.payee}`, requestedAt: Date.now()});
  await writeAll(all);
}

/**
 * Close a request in whichever store holds it.
 *
 * Both are attempted rather than one, because a request filed while the service was down
 * lives on disk while later ones live in the service. Resolving only the preferred store
 * would leave the other one showing an ask the owner has already dealt with.
 */
export async function removeRequest(payee: Address, outcome: "approved" | "declined"): Promise<void> {
  const pending = await fromService();
  if (pending) {
    const match = pending.find((r) => r.payee.toLowerCase() === payee.toLowerCase());
    if (match) {
      await fetch(`${SERVICE_URL}/approvals/${encodeURIComponent(match.id)}/resolve`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        // The outcome matters: an agent waiting on this request reads "declined" from here and
        // stops waiting. Reporting a decline as approved left it waiting until it timed out.
        body: JSON.stringify({outcome}),
        signal: AbortSignal.timeout(3_000),
      }).catch(() => undefined);
    }
  }

  const all = await fromDisk();
  await writeAll(all.filter((r) => r.payee.toLowerCase() !== payee.toLowerCase()));
}
