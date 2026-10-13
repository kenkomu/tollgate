import {Suspense} from "react";
import {FilterChips, parseFilter, type FilterId} from "../../components/FilterChips.tsx";
import {Feed} from "../../components/Feed.tsx";
import {ChainUnreachable, NotConfigured, PageHead, PartialHistory} from "../../components/PageHead.tsx";
import {SkeletonFeed} from "../../components/Skeleton.tsx";
import {AgentSwitcher} from "../../components/AgentSwitcher.tsx";
import {owner, scopeAudit, tryAudit, tryFleet} from "../../lib/data.ts";
import {isConfigured} from "../../lib/chain.ts";

export const dynamic = "force-dynamic";

async function FullLog({filter, agent}: {filter: FilterId; agent: string | undefined}) {
  const [read, fleetRead] = await Promise.all([tryAudit(owner), tryFleet(owner)]);
  // An audit log that silently renders empty when the read failed is worse than no page at
  // all: "nothing happened" and "we could not find out" look identical, and only one of them
  // is a reason to relax.
  if (!read.ok) return <ChainUnreachable detail={read.error} />;

  // Every agent by default; one agent (plus owner-wide events) when the switcher says so.
  // The fleet read failing only costs the switcher, never the log.
  const policies = fleetRead.ok ? fleetRead.value.policies : [];
  const scoped = agent && /^\d+$/.test(agent) ? BigInt(agent) : null;
  const audit = scoped === null ? read.value : scopeAudit(read.value, scoped);
  const all = audit.entries;
  const matches = (kind: string, f: FilterId) =>
    f === "all" ? true : f === "paid" ? kind === "paid" : f === "refused" ? kind === "refused" : kind !== "paid" && kind !== "refused";
  const counts = {
    all: all.length,
    paid: all.filter((e) => matches(e.kind, "paid")).length,
    refused: all.filter((e) => matches(e.kind, "refused")).length,
    changes: all.filter((e) => matches(e.kind, "changes")).length,
  };
  return (
    <>
      <PartialHistory from={read.value.partialFrom} />
      <AgentSwitcher
        policies={policies}
        current={scoped}
        path="/activity"
        all
        fleetPaused={fleetRead.ok && fleetRead.value.fleetPaused}
      />
      <FilterChips active={filter} counts={counts} agent={scoped?.toString()} />
      <Feed
        entries={all.filter((e) => matches(e.kind, filter))}
        limit={200}
        showAgent={scoped === null && policies.length > 1}
      />
    </>
  );
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{[key: string]: string | string[] | undefined}>;
}) {
  const params = await searchParams;
  const filter = parseFilter(params.filter);
  const agent = typeof params.agent === "string" ? params.agent : undefined;
  if (!isConfigured()) {
    return (
      <>
        <PageHead title="Activity" lede="Every payment and policy change." />
        <NotConfigured />
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Activity"
        lede="Every payment and every policy change, rebuilt from contract events on each load."
      />
      <section className="card note-card">
        <p className="prose">
          This log is not a copy of anything. There is no database behind it — each row is
          decoded from a contract event at request time, which is why it cannot drift from
          what happened, and why losing this server would lose nothing. The{" "}
          <strong>proof</strong> link on every row opens the transaction on ArcScan, so you
          can check this page against the chain rather than trusting it.
        </p>
      </section>
      <Suspense fallback={<SkeletonFeed />}>
        <FullLog filter={filter} agent={agent} />
      </Suspense>
    </>
  );
}
