"use client";

import {useState, useTransition} from "react";
import {useRouter} from "next/navigation";
import type {ApprovalCardData, ApprovalCardResult} from "@tollgate/sdk/glove";
import {agentLabel} from "@tollgate/shared";
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
  /** The SDK's slot data. `policyId` may be missing on requests from agents older than ADR 0010. */
  request: Omit<ApprovalCardData, "policyId"> & {
    policyId?: string | null;
    serviceName?: string;
    requestedAt?: number;
  };
  /**
   * The owner's agents, by policy id. With more than one, the card names the agent asking,
   * and lets the owner pick one when the request did not say.
   */
  agents?: bigint[];
  /** Set when the request was already answered, here or on another device. */
  settled?: Decision | null;
  onDecide?: (result: ApprovalCardResult) => void;
}

export function ApprovalCard({request, agents = [], settled = null, onDecide}: ApprovalCardProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [acting, setActing] = useState<Decision | null>(null);
  const [decided, setDecided] = useState<Decision | null>(settled);
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // An agent can ask for anything. The two addresses that can never be payees are refused
  // before the owner is asked to sign, rather than after the wallet simulates a revert.
  const problem = checkPayee(request.payee, ENGINE);

  // Allowlists are per agent (ADR 0010), so approving needs to know which agent. A request
  // that says is approved for that one; one that does not, for the only agent, or for the
  // one the owner picks.
  const named = request.policyId ? BigInt(request.policyId) : null;
  const [chosen, setChosen] = useState<bigint | null>(named ?? (agents.length === 1 ? agents[0]! : null));
  const target = named ?? chosen;
  const blocked = problem?.level === "error" || target === null;

  function decide(decision: Decision) {
    setError(null);
    setActing(decision);
    startTransition(async () => {
      if (decision === "approved") {
        if (target === null) return;
        const result = await approvePayee(target, request.payee, request.requestId ?? undefined);
        if (!result.ok) {
          setError(result.error ?? "Failed");
          setActing(null);
          return;
        }
        setHash(result.hash ?? null);
      } else {
        await declineRequest(request.payee, target ?? undefined, request.requestId ?? undefined);
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

      <h3 className="approval-title">
        {title}
        {named !== null && agents.length > 1 ? <span className="approval-agent"> for {agentLabel(named)}</span> : null}
      </h3>
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

      {problem ? <p className={problem.level === "error" ? "error" : "hint"}>{problem.message}</p> : null}

      {!decided && named === null && agents.length > 1 ? (
        <label className="field approval-pick">
          <span>Approve for which agent?</span>
          <select
            value={chosen?.toString() ?? ""}
            onChange={(e) => setChosen(e.target.value ? BigInt(e.target.value) : null)}
          >
            <option value="">Choose an agent</option>
            {agents.map((id) => (
              <option key={id.toString()} value={id.toString()}>
                {agentLabel(id)}
              </option>
            ))}
          </select>
          <small>This request did not say which agent asked. Only the one you pick can pay this address.</small>
        </label>
      ) : null}

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
