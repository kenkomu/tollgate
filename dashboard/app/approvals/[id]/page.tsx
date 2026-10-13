import Link from "next/link";
import {ApprovalCard} from "../../../components/ApprovalCard.tsx";
import {NotConfigured, PageHead} from "../../../components/PageHead.tsx";
import {getRequest} from "../../../lib/approvals.ts";
import {ENGINE, abi, isConfigured, publicClient} from "../../../lib/chain.ts";
import {owner, tryFleet} from "../../../lib/data.ts";

export const dynamic = "force-dynamic";

/**
 * One request, on its own page.
 *
 * Where a push notification or a shared link lands: the decision and nothing else, so the
 * owner can answer from a phone browser in two taps. The same card as the queue.
 *
 * Whether it is already settled is decided by the chain first. A payee that is on the
 * allowlist is approved however the request was closed; one that is not was, in effect,
 * declined, even if an older record says otherwise.
 */
export default async function ApprovalPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  const lede = "Your agent wants to pay someone it has not paid before.";

  if (!isConfigured()) {
    return (
      <>
        <PageHead title="Approval" lede={lede} />
        <NotConfigured />
      </>
    );
  }

  const request = await getRequest(id);
  if (!request) {
    return (
      <>
        <PageHead title="Approval" lede={lede} />
        <section className="card empty">
          No request with this id. It may have been cleared, or filed while the service was not
          running. <Link href="/payees">See every open request</Link>.
        </section>
      </>
    );
  }

  const fleetRead = await tryFleet(owner);
  const agents = fleetRead.ok ? fleetRead.value.policies.map((p) => p.id) : [];
  // The agent it is for: the one the request names, or the only one there is.
  const policyId = request.policyId ? BigInt(request.policyId) : agents.length === 1 ? agents[0]! : null;

  let allowed: boolean | null = null;
  if (policyId !== null) {
    try {
      allowed = (await publicClient.readContract({
        address: ENGINE,
        abi,
        functionName: "isAllowedPayee",
        args: [policyId, request.payee],
      })) as boolean;
    } catch {
      // Unreadable chain: fall back to the record rather than guessing.
    }
  }

  const settled =
    allowed === null ? request.outcome : allowed ? "approved" : request.outcome ? "declined" : null;

  return (
    <>
      <PageHead title="Approval" lede={lede} />
      <div className="approval-page">
        <ApprovalCard
          settled={settled}
          agents={agents}
          request={{
            requestId: request.id,
            policyId: request.policyId ?? null,
            payee: request.payee,
            amount: request.amount,
            why: request.why,
            serviceName: request.serviceName,
            requestedAt: request.requestedAt,
          }}
        />
        <p className="hint">
          <Link href="/payees">All payees and requests</Link>
        </p>
      </div>
    </>
  );
}
