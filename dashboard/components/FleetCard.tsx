import Link from "next/link";
import {agentLabel, formatUsdc, type PolicyWithId} from "@tollgate/shared";
import {shortAddress} from "../lib/chain.ts";

/**
 * Every agent at a glance: whose leash is shortest, who is stopped, who is close to the end
 * of their budget. One row per policy, each linking to that agent's own views.
 */
export function FleetCard({
  policies,
  fleetPaused,
  current,
}: {
  policies: PolicyWithId[];
  fleetPaused: boolean;
  current: bigint | null;
}) {
  return (
    <section className="card fleet">
      <div className="fleet-head">
        <h2 className="card-title">Your agents</h2>
        <Link href="/agents/new" className="fleet-add">
          + Add an agent
        </Link>
      </div>
      <p className="card-note">
        Each agent has its own key, budget, rate limit and payees. A leaked key reaches only its
        own leash.
      </p>
      <ul className="fleet-list">
        {policies.map((p) => {
          const left = p.budgetCap > p.spent ? p.budgetCap - p.spent : 0n;
          const used = p.budgetCap === 0n ? 100 : Number((p.spent * 100n) / p.budgetCap);
          const stopped = fleetPaused || p.paused;
          return (
            <li key={p.id.toString()} className={`fleet-row${p.id === current ? " current" : ""}`}>
              <Link href={`/?agent=${p.id}`} className="fleet-link" aria-current={p.id === current ? "true" : undefined}>
                <span className="fleet-name">
                  <span className={`agent-dot${stopped ? " stopped" : ""}`} aria-hidden="true" />
                  {agentLabel(p.id)}
                </span>
                <span className="fleet-key mono-addr">{shortAddress(p.agent)}</span>
                <span className="fleet-left num">{formatUsdc(left)} left</span>
                <span className={`chip ${stopped ? "stopped" : "ok"}`}>{stopped ? "Stopped" : "Active"}</span>
                <span className="fleet-bar" aria-hidden="true">
                  <span style={{width: `${Math.min(100, used)}%`}} />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
