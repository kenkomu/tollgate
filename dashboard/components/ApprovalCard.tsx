"use client";

import {useState, useTransition} from "react";
import {useRouter} from "next/navigation";
import type {ApprovalCardData, ApprovalCardResult} from "@tollgate/sdk/glove";
import {approvePayee, declineRequest} from "../lib/owner.ts";
import {ENGINE, addressUrl, txUrl} from "../lib/chain.ts";
import {checkPayee} from "../lib/policy-form.ts";
import {CheckIcon, ExternalIcon, HandIcon} from "./Icon.tsx";

/**
 * One payee request, decided.
 *
 * The same card in three places: the queue on the payees page, the page a notification links
 * to, and any chat host running the SDK's `approve_payee_inline` tool, which pushes exactly
 * `ApprovalCardData` and waits for `ApprovalCardResult`. A Glove host passes its `resolve` as
 * `onDecide`; nothing else about the card changes.
 *
 * `onDecide` is called with "approved" only after `setPayee` has landed on chain, so a host
 * that trusts the card's answer is still trusting the chain. The SDK re-checks anyway.
 */

export type Decision = ApprovalCardResult["decision"];

export interface ApprovalCardProps {
  request: ApprovalCardData & {serviceName?: string; requestedAt?: number};
  /** Set when the request was already answered, here or on another device. */
  settled?: Decision | null;
  onDecide?: (result: ApprovalCardResult) => void;
}

export function ApprovalCard({request, settled = null, onDecide}: ApprovalCardProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [acting, setActing] = useState<Decision | null>(null);
  const [decided, setDecided] = useState<Decision | null>(settled);
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // An agent can ask for anything. The two addresses that can never be payees are refused
  // before the owner is asked to sign, rather than after the wallet simulates a revert.
  const problem = checkPayee(request.payee, ENGINE);
  const blocked = problem?.level === "error";

  function decide(decision: Decision) {
    setError(null);
    setActing(decision);
    startTransition(async () => {
      if (decision === "approved") {
        const result = await approvePayee(request.payee);
        if (!result.ok) {
          setError(result.error ?? "Failed");
          setActing(null);
          return;
        }
        setHash(result.hash ?? null);
      } else {
        await declineRequest(request.payee);
      }
      setDecided(decision);
      setActing(null);
      onDecide?.({decision});
      router.refresh();
    });
  }

  const title = request.serviceName ?? "A new payee";

  return (
    <article className={`approval approval-card${decided ? ` settled ${decided}` : ""}`} aria-busy={pending}>
      <header className="approval-head">
        <span className="approval-kicker">
          <HandIcon size={11} /> {decided ? "Answered" : "Your agent is asking"}
        </span>
        {request.amount ? <span className="approval-amount">{request.amount}</span> : null}
      </header>

      <h3 className="approval-title">{title}</h3>
      <p className="approval-why">&ldquo;{request.why}&rdquo;</p>

      <dl className="approval-facts">
        <dt>Pay to</dt>
        <dd>
          <a className="mono-addr" href={addressUrl(request.payee)} target="_blank" rel="noreferrer">
            {request.payee} <ExternalIcon size={10} />
          </a>
        </dd>
        {request.requestedAt ? (
          <>
            <dt>Asked</dt>
            {/* The owner's own timezone, which the server cannot know. Same instant either way. */}
            <dd suppressHydrationWarning>{new Date(request.requestedAt).toLocaleString()}</dd>
          </>
        ) : null}
      </dl>

      {problem ? <p className={blocked ? "error" : "hint"}>{problem.message}</p> : null}

      {decided ? (
        <p className={`approval-result ${decided}`} role="status">
          {decided === "approved" ? (
            <>
              <CheckIcon size={12} /> Allowlisted on chain. The agent can pay this address now.{" "}
              {hash ? (
                <a href={txUrl(hash)} target="_blank" rel="noreferrer">
                  proof <ExternalIcon size={10} />
                </a>
              ) : null}
            </>
          ) : (
            <>Declined. Nothing was written on chain and the agent stays refused.</>
          )}
        </p>
      ) : (
        <>
          <p className="approval-terms">
            Approving lets the agent pay this address again later, within your caps. It does not
            pay anything by itself.
          </p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => decide("approved")} disabled={pending || blocked}>
              {acting === "approved" ? "Signing…" : "Approve payee"}
            </button>
            <button type="button" onClick={() => decide("declined")} disabled={pending}>
              {acting === "declined" ? "Declining…" : "Decline"}
            </button>
          </div>
        </>
      )}

      {error ? <p className="error" role="alert">{error}</p> : null}
    </article>
  );
}
