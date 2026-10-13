import {formatUsdc, type Policy} from "@tollgate/shared";
import {ShieldIcon, StopIcon} from "./Icon.tsx";

/**
 * The headline.
 *
 * Someone landing here has about five seconds of attention, and the thing worth spending
 * it on is not a number — it is *where the number is enforced*. So the ribbon leads with
 * state and follows with the ceiling that produced it.
 *
 * Every figure comes from a single `getPolicy` call, which is why this can paint before
 * the log walk finishes.
 *
 * This used to carry a note explaining why it could say nothing about refusals — a
 * reverted spend emits no event, so a count of blocked attempts was not something chain
 * could tell us, and inventing one would have been exactly the off-chain assertion this
 * project exists to replace. `trySpend` and the `Refused` event closed that gap. The count
 * now lives in the KPI strip, one log walk behind, and every one of them is a real
 * transaction someone can open on ArcScan.
 */
export function Verdict({policy}: {policy: Policy}) {
  const stopped = policy.paused;
  const remaining = policy.budgetCap - policy.spent;

  return (
    <section className={`verdict${stopped ? " stopped" : ""}`}>
      <div className="verdict-main">
        <span className="verdict-badge">
          {stopped ? <StopIcon size={15} /> : <ShieldIcon size={15} />}
          {stopped ? "Stopped" : "Enforcing"}
        </span>
        <p className="verdict-hero num">{stopped ? "$0.00 can move" : `${formatUsdc(remaining)} left to spend`}</p>
        <p className="verdict-line">
          {stopped
            ? "Every payment is refused at the contract until you resume."
            : `of ${formatUsdc(policy.budgetCap)} in total. Checked on chain before any money moves, and the agent can't change it.`}
        </p>
      </div>
      <span className="verdict-orb" aria-hidden="true">
        {stopped ? <StopIcon size={30} /> : <ShieldIcon size={30} />}
      </span>

      <dl className="verdict-stats">
        <div>
          <dt>moved so far</dt>
          <dd className="num">{formatUsdc(policy.spent)}</dd>
        </div>
        <div>
          <dt>max per payment</dt>
          <dd className="num">{formatUsdc(policy.perTxCap)}</dd>
        </div>
      </dl>
    </section>
  );
}
