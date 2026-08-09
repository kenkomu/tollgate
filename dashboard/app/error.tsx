"use client";

import {useEffect} from "react";

/**
 * The last line of defence.
 *
 * Individual pages handle an unreachable chain themselves and say something useful about it.
 * This catches everything else, and exists because the default Next error page is the single
 * worst thing this product could show: a stack trace, on a dashboard whose entire job is to
 * tell someone whether their money is safe, reads as "the thing guarding your funds has
 * crashed". It has not — nothing here can change a policy, and the contract does not depend
 * on this app being up.
 */
export default function Error({error, reset}: {error: Error & {digest?: string}; reset: () => void}) {
  useEffect(() => {
    console.error("Dashboard render failed:", error);
  }, [error]);

  return (
    <section className="card stopped">
      <h2 className="card-title">This page failed to load</h2>
      <p className="card-note">
        Something went wrong rendering this view. Your policy is unaffected — this app only
        reads the chain, and every control it offers also exists on chain without it.
      </p>
      <p className="prose">
        The kill switch is a direct owner-to-chain write. If you need to stop your agent right
        now and this page will not load, call <code>setPaused(true)</code> on the policy
        contract from any wallet or from the block explorer. That path does not involve us.
      </p>
      <div className="actions">
        <button type="button" className="primary" onClick={reset}>
          Try again
        </button>
      </div>
      {error.digest ? (
        <p className="card-note" style={{marginTop: 10}}>
          Reference: <code>{error.digest}</code>
        </p>
      ) : null}
    </section>
  );
}
