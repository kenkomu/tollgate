import Link from "next/link";
import {agentLabel, explainToOwner, formatUsdc} from "@tollgate/shared";
import {describe, type Activity} from "../lib/activity.ts";
import {shortAddress, txUrl} from "../lib/chain.ts";
import {CheckIcon, ExternalIcon, SlidersIcon, StopIcon} from "./Icon.tsx";

/** Colour already carries the row's meaning; the glyph repeats it for anyone who can't see it. */
function KindIcon({kind}: {kind: Activity["kind"]}) {
  if (kind === "paid") return <CheckIcon size={13} />;
  if (kind === "refused" || kind === "paused" || kind === "fleet-paused" || kind === "payee-removed") {
    return <StopIcon size={13} />;
  }
  return <SlidersIcon size={13} />;
}

function when(timestamp: number): string {
  if (!timestamp) return "";
  const seconds = Math.floor(Date.now() / 1000) - timestamp;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

/**
 * The audit log.
 *
 * Every row here is a contract event, read from Arc at request time. We store none of it,
 * which means none of it can be wrong — and it is why the "rebuild the whole thing from
 * chain" claim in §2.4 is not aspirational here, it is just what the code does.
 *
 * Written in plain English rather than event names, per §5.1: an owner reading this should
 * not need to know what a `PayeeSet` is.
 */
export function Feed({
  entries,
  limit = 40,
  more = false,
  showAgent = false,
}: {
  entries: Activity[];
  /** How many rows to render. The overview shows a window; Activity shows the log. */
  limit?: number;
  /** Offer a link to the full log, for the windowed case: true for /activity, or a URL. */
  more?: boolean | string;
  /** Name the agent on each row, for a log that mixes several (ADR 0010). */
  showAgent?: boolean;
}) {
  if (entries.length === 0) {
    return (
      <section className="card">
        <h2 className="card-title">Activity</h2>
        <p className="card-note">Every payment and every policy change, read from Arc.</p>
        <div className="empty">Nothing has happened yet.</div>
      </section>
    );
  }

  return (
    <section className="card">
      <h2 className="card-title">{more ? "Recent activity" : "Activity"}</h2>
      <p className="card-note">
        Every payment and policy change, read from Arc at page load. Nothing is stored here.
      </p>

      <div className="feed" role="list" aria-label="Activity" aria-live="polite" aria-relevant="additions">
        {entries.slice(0, limit).map((entry) => {
          const stopped =
            entry.kind === "refused" ||
            entry.kind === "paused" ||
            entry.kind === "fleet-paused" ||
            entry.kind === "payee-removed";
          const neutral = entry.kind === "policy-created" || entry.kind === "resumed" || entry.kind === "fleet-resumed";
          const rowClass = stopped ? "feed-row stopped" : neutral ? "feed-row neutral" : "feed-row";

          return (
            <div className={rowClass} key={entry.key} role="listitem">
              <div className="feed-stripe" aria-hidden="true" />
              <div className="feed-body">
                <div className="feed-top">
                  <span className="feed-what">
                    <KindIcon kind={entry.kind} />
                    {describe(entry)}
                  </span>
                  {entry.amount !== undefined ? (
                    <span className="feed-amount">{formatUsdc(entry.amount)}</span>
                  ) : null}
                </div>
                {/* The refusal reason, in the owner's words rather than the enum's. This is
                    the line the whole redeploy existed to make possible. */}
                {entry.reason !== undefined ? (
                  <p className="feed-reason">{explainToOwner(entry.reason)}</p>
                ) : null}

                <div className="feed-sub">
                  {showAgent && entry.policyId !== undefined ? (
                    <span className="feed-agent">{agentLabel(entry.policyId)}</span>
                  ) : null}
                  {entry.payee ? (
                    <span className="mono-addr">
                      {entry.kind === "refused" ? "blocked to" : "to"} {shortAddress(entry.payee)}
                    </span>
                  ) : null}
                  {entry.agent ? (
                    <span className="mono-addr">by {shortAddress(entry.agent)}</span>
                  ) : null}
                  {entry.timestamp ? <span>{when(entry.timestamp)}</span> : null}
                  <a href={txUrl(entry.txHash)} target="_blank" rel="noreferrer">
                    proof <ExternalIcon size={11} />
                  </a>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {more && entries.length > limit ? (
        <p className="card-more">
          <Link href={typeof more === "string" ? more : "/activity"}>
            All {entries.length} events <ExternalIcon size={11} />
          </Link>
        </p>
      ) : null}
    </section>
  );
}
