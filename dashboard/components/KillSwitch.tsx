"use client";

import {useState, useTransition} from "react";
import {useRouter} from "next/navigation";
import {setOwnerPaused, setPaused, type WriteResult} from "../lib/owner.ts";
import {txUrl} from "../lib/chain.ts";
import {ExternalIcon, ShieldIcon, StopIcon} from "./Icon.tsx";

/**
 * The kill switches.
 *
 * Given the most prominent treatment on the page, and the only place besides a refusal
 * where red appears. An owner should never have to hunt for these.
 *
 * Two of them since ADR 0010: one agent, and every agent at once. The fleet switch is the one
 * for "something is wrong and I do not know which agent": one signature, no hunting.
 */
function useSwitch(write: () => Promise<WriteResult>) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    setError(null);
    setHash(null);
    startTransition(async () => {
      const result = await write();
      if (result.ok) {
        setHash(result.hash ?? null);
        router.refresh();
      } else {
        setError(result.error ?? "Failed");
      }
    });
  }

  return {pending, hash, error, toggle};
}

function Proof({hash, error}: {hash: string | null; error: string | null}) {
  return (
    <>
      {hash ? (
        <div style={{marginTop: 12, fontSize: 12.5}}>
          <a href={txUrl(hash)} target="_blank" rel="noreferrer" style={{color: "var(--muted)"}}>
            View transaction on ArcScan <ExternalIcon size={11} />
          </a>
        </div>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}

/** One agent. */
export function KillSwitch({
  policyId,
  paused,
  fleetPaused = false,
  name,
}: {
  policyId: bigint;
  paused: boolean;
  fleetPaused?: boolean;
  name?: string | undefined;
}) {
  const {pending, hash, error, toggle} = useSwitch(() => setPaused(policyId, !paused));
  const who = name ?? "the agent";

  return (
    <section className={`card${paused ? " stopped" : ""}`}>
      <h2 className="card-title">{paused ? `${name ?? "Agent"} is stopped` : "Kill switch"}</h2>
      <p className="card-note">
        {paused
          ? `Every payment from ${who} is being refused. Nothing can move until you resume.`
          : `Stops every payment from ${who} immediately. Takes effect on chain, not here, so it keeps working even if this dashboard is down.`}
        {fleetPaused && !paused ? " Every agent is also stopped by the fleet switch right now." : ""}
      </p>

      <div className="actions">
        <button type="button" className={paused ? "primary" : "danger"} onClick={toggle} disabled={pending}>
          {paused ? <ShieldIcon size={13} /> : <StopIcon size={13} />}
          {pending ? "Signing…" : paused ? `Resume ${name ?? "agent"}` : name ? `Stop ${name}` : "Stop everything"}
        </button>
        <span className={`chip ${paused ? "stopped" : "ok"}`}>{paused ? "Paused" : "Active"}</span>
      </div>
      <Proof hash={hash} error={error} />
    </section>
  );
}

/** Every agent this owner runs, in one transaction. */
export function FleetSwitch({paused, agents}: {paused: boolean; agents: number}) {
  const {pending, hash, error, toggle} = useSwitch(() => setOwnerPaused(!paused));

  return (
    <section className={`card${paused ? " stopped" : ""}`}>
      <h2 className="card-title">{paused ? "Every agent is stopped" : "Stop every agent"}</h2>
      <p className="card-note">
        {paused
          ? "The fleet switch is on: all your agents are refused, whatever their own settings. Resuming leaves any agent you stopped individually stopped."
          : `One signature stops all ${agents} agents at the contract. For when something is wrong and you do not yet know which agent.`}
      </p>
      <div className="actions">
        <button type="button" className={paused ? "primary" : "danger"} onClick={toggle} disabled={pending}>
          {paused ? <ShieldIcon size={13} /> : <StopIcon size={13} />}
          {pending ? "Signing…" : paused ? "Resume all agents" : "Stop every agent"}
        </button>
      </div>
      <Proof hash={hash} error={error} />
    </section>
  );
}
