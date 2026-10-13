import Link from "next/link";
import {agentLabel, type PolicyWithId} from "@tollgate/shared";

/**
 * Which agent this page is about, when the owner runs more than one (ADR 0010).
 *
 * Links rather than client state, like the activity filters: the chosen agent survives a
 * reload, can be shared, and every write on the page targets the agent named in the URL,
 * so there is no hidden selection to get out of sync with what is on screen.
 *
 * Renders nothing for a single agent, which keeps the one-agent dashboard unchanged.
 */
export function AgentSwitcher({
  policies,
  current,
  path,
  all = false,
  fleetPaused = false,
}: {
  policies: PolicyWithId[];
  /** The agent on screen, or null for "all agents" where the page supports it. */
  current: bigint | null;
  path: string;
  /** Offer an "All agents" choice (the activity log). */
  all?: boolean;
  fleetPaused?: boolean;
}) {
  if (policies.length < 2) return null;

  return (
    <nav className="chips agent-switcher" aria-label="Choose an agent">
      {all ? (
        <Link href={path} className={`chip-link${current === null ? " active" : ""}`} aria-current={current === null ? "true" : undefined} scroll={false}>
          All agents
        </Link>
      ) : null}
      {policies.map((p) => {
        const active = p.id === current;
        const stopped = fleetPaused || p.paused;
        return (
          <Link
            key={p.id.toString()}
            href={`${path}?agent=${p.id}`}
            className={`chip-link${active ? " active" : ""}`}
            aria-current={active ? "true" : undefined}
            scroll={false}
          >
            <span className={`agent-dot${stopped ? " stopped" : ""}`} aria-hidden="true" />
            {agentLabel(p.id)}
            {stopped ? <span className="visually-hidden"> (stopped)</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
