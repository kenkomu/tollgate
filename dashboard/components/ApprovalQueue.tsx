import type {ApprovalRequest} from "../lib/approvals.ts";
import {ApprovalCard} from "./ApprovalCard.tsx";
import {HandIcon} from "./Icon.tsx";

/**
 * Payee approvals — the human in the loop.
 *
 * A strict allowlist (ADR 0003) is the strongest guarantee available, and it costs the
 * agent its ability to pay anyone new. This is where that cost gets paid: the agent asks,
 * the owner decides, and the leash lengthens one link at a time.
 *
 * Each request is an `ApprovalCard`, the same one a notification opens and a chat host
 * renders, with its own signing state, so approving one request never greys out another.
 */
export function ApprovalQueue({requests}: {requests: ApprovalRequest[]}) {
  return (
    <section className="card">
      <h2 className="card-title">
        Approvals
        {requests.length > 0 ? (
          <span className="chip accent" style={{marginLeft: 10, verticalAlign: 3}}>
            <HandIcon size={11} /> {requests.length} waiting
          </span>
        ) : null}
      </h2>
      <p className="card-note">
        Payments the agent wants to make to someone you have not approved. It cannot proceed
        without you.
      </p>

      {requests.length === 0 ? (
        <div className="empty">Nothing waiting on you.</div>
      ) : (
        <div className="approval-list">
          {requests.map((request) => (
            <ApprovalCard
              key={request.id}
              request={{
                requestId: request.id,
                payee: request.payee,
                amount: request.amount,
                why: request.why,
                serviceName: request.serviceName,
                requestedAt: request.requestedAt,
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
