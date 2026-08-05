import {readFile, writeFile, mkdir} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import type {Address} from "viem";

/**
 * Pending payee-approval requests.
 *
 * A strict allowlist (ADR 0003) means an agent that discovers a new supplier has exactly
 * one route forward: ask the owner. This is where those asks queue up.
 *
 * Storage is a JSON file on disk, shared between the agent process and the dashboard.
 * That is deliberately unglamorous. It carries no trust — the allowlist itself lives on
 * chain, and approving here does nothing until the owner signs a `setPayee` transaction.
 * Losing this file loses a request, not a control.
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

async function readAll(): Promise<ApprovalRequest[]> {
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

export async function listPending(): Promise<ApprovalRequest[]> {
  return readAll();
}

export async function addRequest(request: Omit<ApprovalRequest, "id" | "requestedAt">): Promise<void> {
  const all = await readAll();
  // One pending request per payee — an agent that asks twice should not queue twice.
  if (all.some((r) => r.payee.toLowerCase() === request.payee.toLowerCase())) return;
  all.push({...request, id: `${Date.now()}-${request.payee}`, requestedAt: Date.now()});
  await writeAll(all);
}

export async function removeRequest(payee: Address): Promise<void> {
  const all = await readAll();
  await writeAll(all.filter((r) => r.payee.toLowerCase() !== payee.toLowerCase()));
}
