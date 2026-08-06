"use client";

import {useState, useTransition} from "react";
import {setPaused} from "../lib/owner.ts";
import {txUrl} from "../lib/chain.ts";
import {ExternalIcon, ShieldIcon, StopIcon} from "./Icon.tsx";

/**
 * The kill switch.
 *
 * Given the most prominent treatment on the page, and the only place besides a refusal
 * where red appears. An owner should never have to hunt for this.
 */
export function KillSwitch({paused}: {paused: boolean}) {
  const [pending, startTransition] = useTransition();
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    setError(null);
    setHash(null);
    startTransition(async () => {
      const result = await setPaused(!paused);
      if (result.ok) setHash(result.hash ?? null);
      else setError(result.error ?? "Failed");
    });
  }

  return (
    <section className={`card${paused ? " stopped" : ""}`}>
      <h2 className="card-title">{paused ? "Agent is stopped" : "Kill switch"}</h2>
      <p className="card-note">
        {paused
          ? "Every payment is being refused. Nothing can move until you resume."
          : "Stops every payment immediately. Takes effect on chain, not here — it keeps working even if this dashboard is down."}
      </p>

      <div className="actions">
        <button
          type="button"
          className={paused ? "primary" : "danger"}
          onClick={toggle}
          disabled={pending}
        >
          {paused ? <ShieldIcon size={13} /> : <StopIcon size={13} />}
          {pending ? "Signing…" : paused ? "Resume agent" : "Stop everything"}
        </button>
        <span className={`chip ${paused ? "stopped" : "ok"}`}>{paused ? "Paused" : "Active"}</span>
      </div>

      {hash ? (
        <div style={{marginTop: 12, fontSize: 12.5}}>
          <a href={txUrl(hash)} target="_blank" rel="noreferrer" style={{color: "var(--muted)"}}>
            View transaction on ArcScan <ExternalIcon size={11} />
          </a>
        </div>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
    </section>
  );
}
