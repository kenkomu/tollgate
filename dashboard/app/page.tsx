import {Suspense} from "react";
import Link from "next/link";
import type {Address} from "viem";
import {availableNow, formatUsdc, formatUsdcApprox} from "@tollgate/shared";
import {Feed} from "../components/Feed.tsx";
import {Meter} from "../components/Meter.tsx";
import {NoPolicy, NotConfigured, PageHead} from "../components/PageHead.tsx";
import {SkeletonTiles} from "../components/Skeleton.tsx";
import {SpendChart, type SpendPoint} from "../components/SpendChart.tsx";
import {StatTile} from "../components/StatTile.tsx";
import {Verdict} from "../components/Verdict.tsx";
import {auditFor, owner, policyFor} from "../lib/data.ts";
import {ENGINE, isConfigured, shortAddress} from "../lib/chain.ts";

export const dynamic = "force-dynamic";

/**
 * Everything below needs the log walk, so it streams as one unit behind a skeleton while
 * the caps — which need only `getPolicy` — paint immediately.
 */
async function SpendSection({owner: who, budgetCap}: {owner: Address; budgetCap: bigint}) {
  const audit = await auditFor(who);

  /**
   * The chart's right-hand bound, read once on the server and passed down as a prop.
   *
   * react-hooks/purity flags any clock read during render, and for a client component it is
   * right to: server and client would seed different instants and the markup would not match,
   * which is exactly the hydration mismatch SpendChart already hit once. This is an async
   * Server Component under `force-dynamic`, so it renders once per request and never
   * re-renders — the read is deliberate, and passing the value down is what makes the chart
   * a pure function of its props.
   */
  // eslint-disable-next-line react-hooks/purity
  const now = Math.floor(Date.now() / 1000);
  const payments = audit.entries.filter((entry) => entry.kind === "paid");
  const refusals = audit.entries.filter((entry) => entry.kind === "refused");
  const blocked = refusals.reduce((sum, entry) => sum + (entry.amount ?? 0n), 0n);

  // Oldest first for the chart; the feed reads newest first.
  const points: SpendPoint[] = payments
    .filter((entry) => entry.timestamp > 0 && entry.spentTotal !== undefined)
    .map((entry) => ({
      timestamp: entry.timestamp,
      total: entry.spentTotal!,
      amount: entry.amount ?? 0n,
      txHash: entry.txHash,
    }))
    .reverse();

  const moved = payments.reduce((sum, entry) => sum + (entry.amount ?? 0n), 0n);

  return (
    <>
      <div className="tiles">
        <StatTile
          label="payments allowed"
          value={String(payments.length)}
          context="every one checked on chain first"
        />
        <StatTile label="total moved" value={formatUsdc(moved)} context="from the owner's own wallet" />
        <StatTile
          label="payments refused"
          value={String(refusals.length)}
          tone={refusals.length ? "stop" : undefined}
          context={
            refusals.length
              ? `${formatUsdc(blocked)} the contract would not let through`
              : "nothing has been turned away yet"
          }
        />
        <StatTile
          label="approved payees"
          value={String(audit.allowedPayees.length)}
          context="nobody else can be paid"
        />
      </div>

      <section className="card">
        <h2 className="card-title">Spend against the ceiling</h2>
        <p className="card-note">
          Cumulative, from <code>Spent</code> events. The steps are the payments — nothing
          moves between them.
        </p>
        <SpendChart
          points={points}
          budgetCap={budgetCap}
          now={now}
          startLabel={
            points.length
              ? new Date(points[0]!.timestamp * 1000).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })
              : ""
          }
        />
      </section>

      <Feed entries={audit.entries} limit={8} more />
    </>
  );
}

export default async function Page() {
  if (!isConfigured()) {
    return (
      <>
        <PageHead title="Overview" lede="Agent spend control on Arc." />
        <NotConfigured />
      </>
    );
  }

  const policy = await policyFor(owner);
  if (!policy.exists) {
    return (
      <>
        <PageHead title="Overview" lede="Agent spend control on Arc." />
        <NoPolicy />
      </>
    );
  }

  const headroom = availableNow(policy);

  return (
    <>
      <PageHead
        title="Overview"
        lede="What your agent has spent, and what the contract will still let it spend."
      />

      <Verdict policy={policy} />

      <div className="grid grid-2">
        <section className="card">
          <h2 className="card-title">This agent&rsquo;s leash</h2>
          <p className="card-note">
            Enforced in the contract, not in the agent. It cannot change any of this.{" "}
            <Link href="/policy">Full policy →</Link>
          </p>

          <Meter
            label="budget used"
            value={policy.spent}
            total={policy.budgetCap}
            sense="used"
            caption={`${formatUsdc(policy.budgetCap - policy.spent)} left of the lifetime budget`}
          />
          <Meter
            label="rate headroom"
            value={headroom}
            total={policy.bucketCapacity}
            sense="remaining"
            caption={`refills at about ${formatUsdcApprox(policy.refillPerSecond * 86_400n)} a day`}
          />
        </section>

        <section className="card">
          <h2 className="card-title">Why this is different</h2>
          <p className="card-note">
            The limits above are not settings this app obeys. They are conditions in a
            contract at <code>{shortAddress(ENGINE)}</code> that every payment must satisfy
            before any money moves.
          </p>
          <p className="prose">
            An agent with a stolen key, a jailbroken prompt, or a bug still cannot exceed
            them — there is no code path from the agent to a payment that skips the check.
            That is the entire claim, and the{" "}
            <Link href="/activity">activity log</Link> is the evidence: every row links to
            the transaction on ArcScan.
          </p>
        </section>
      </div>

      <Suspense fallback={<SkeletonTiles />}>
        <SpendSection owner={owner} budgetCap={policy.budgetCap} />
      </Suspense>
    </>
  );
}
