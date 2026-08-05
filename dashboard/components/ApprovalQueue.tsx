"use client";

import {useState, useTransition} from "react";
import type {Address} from "viem";
import type {ApprovalRequest} from "../lib/approvals.ts";
import {approvePayee, declineRequest} from "../lib/owner.ts";
import {shortAddress, txUrl} from "../lib/chain.ts";

/**
 * Payee approvals — the human in the loop.
 *
 * A strict allowlist (ADR 0003) is the strongest guarantee available, and it costs the
 * agent its ability to pay anyone new. This is where that cost gets paid: the agent asks,
 * the owner decides, and the leash lengthens one link at a time.
 *
 * Approving writes `setPayee` on chain. Until that transaction lands, the agent stays
 * refused — nothing in this queue grants anything by itself.
 */
export function ApprovalQueue({requests}: {requests: ApprovalRequest[]}) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function approve(payee: Address) {
    setError(null);
    setHash(null);
    setBusy(payee);
    startTransition(async () => {
      const result = await approvePayee(payee);
      if (result.ok) setHash(result.hash ?? null);
      else setError(result.error ?? "Failed");
      setBusy(null);
    });
  }

  function decline(payee: Address) {
    setBusy(payee);
    startTransition(async () => {
      await declineRequest(payee);
      setBusy(null);
    });
  }

  return (
    <section className="card">
      <h2 className="card-title">Approvals</h2>
      <p className="card-note">
        Payments the agent wants to make to someone you have not approved. It cannot proceed
        without you.
      </p>

      {requests.length === 0 ? (
        <div className="empty">Nothing waiting on you.</div>
      ) : (
        requests.map((request) => (
          <div className="approval" key={request.id}>
            <div className="feed-top">
              <span className="feed-what">{request.serviceName}</span>
              <span className="feed-amount">{request.amount}</span>
            </div>
            <div className="feed-sub">
              <span className="mono-addr">{shortAddress(request.payee)}</span>
              <span>·</span>
              <span>{new Date(request.requestedAt).toLocaleString()}</span>
            </div>
            <p className="approval-why">{request.why}</p>
            <div className="actions">
              <button
                type="button"
                className="primary"
                onClick={() => approve(request.payee)}
                disabled={pending && busy === request.payee}
              >
                {pending && busy === request.payee ? "Signing…" : "Approve payee"}
              </button>
              <button type="button" onClick={() => decline(request.payee)} disabled={pending}>
                Decline
              </button>
            </div>
          </div>
        ))
      )}

      {hash ? (
        <div style={{marginTop: 12, fontSize: 12.5}}>
          <a href={txUrl(hash)} target="_blank" rel="noreferrer" style={{color: "var(--muted)"}}>
            Payee added on chain ↗
          </a>
        </div>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
    </section>
  );
}
