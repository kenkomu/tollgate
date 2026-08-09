import {Suspense} from "react";
import {Feed} from "../../components/Feed.tsx";
import {ChainUnreachable, NotConfigured, PageHead} from "../../components/PageHead.tsx";
import {SkeletonFeed} from "../../components/Skeleton.tsx";
import {owner, tryAudit} from "../../lib/data.ts";
import {isConfigured} from "../../lib/chain.ts";

export const dynamic = "force-dynamic";

async function FullLog() {
  const read = await tryAudit(owner);
  // An audit log that silently renders empty when the read failed is worse than no page at
  // all: "nothing happened" and "we could not find out" look identical, and only one of them
  // is a reason to relax.
  if (!read.ok) return <ChainUnreachable detail={read.error} />;
  return <Feed entries={read.value.entries} limit={200} />;
}

export default function ActivityPage() {
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
        <FullLog />
      </Suspense>
    </>
  );
}
