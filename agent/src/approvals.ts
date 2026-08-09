import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import type {Address} from "viem";

/**
 * Where the agent files a payee-approval request for the owner.
 *
 * Posted to the service, which is what the phone and the dashboard read. Falls back to a
 * local JSON file when the service is not running, so a developer with only the agent and
 * the dashboard still sees escalations.
 *
 * This carries no authority in either form. The allowlist lives on chain, and nothing here
 * grants anything until the owner signs a `setPayee` transaction. Losing a request loses an
 * ask, not a control.
 *
 * The two-store arrangement was a real bug, not a design: the agent wrote only to the file
 * while the phone read only the service, so an escalation the agent believed it had raised
 * reached nobody. A blocked agent that cannot reach its owner is the failure that makes
 * people widen policies "just to be safe" — the exact outcome this product exists to avoid.
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

export type FiledWhere = "service" | "file";

async function fileToService(request: Omit<ApprovalRequest, "id" | "requestedAt">): Promise<boolean> {
  try {
    const response = await fetch(`${SERVICE_URL}/approvals`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(request),
      // The agent must not stall on an unreachable service. Escalating is important; blocking
      // the whole run on it is not.
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function fileToDisk(request: Omit<ApprovalRequest, "id" | "requestedAt">): Promise<void> {
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

/** Returns where the request landed, so the agent can tell the owner how to find it. */
export async function fileRequest(
  request: Omit<ApprovalRequest, "id" | "requestedAt">,
): Promise<FiledWhere> {
  if (await fileToService(request)) return "service";
  await fileToDisk(request);
  return "file";
}
