import {Suspense, cache} from "react";
import type {Address} from "viem";
import {arcTestnet, availableNow, formatUsdc, formatUsdcApprox, type Policy} from "@tollgate/shared";
import {ApprovalQueue} from "../components/ApprovalQueue.tsx";
import {Feed} from "../components/Feed.tsx";
import {ExternalIcon} from "../components/Icon.tsx";
import {KillSwitch} from "../components/KillSwitch.tsx";
import {LiveRefresh} from "../components/LiveRefresh.tsx";
import {Meter} from "../components/Meter.tsx";
import {SkeletonFacts, SkeletonFeed} from "../components/Skeleton.tsx";
import {Verdict} from "../components/Verdict.tsx";
import {readAuditLog} from "../lib/activity.ts";
import {listPending} from "../lib/approvals.ts";
import {ENGINE, OWNER, abi, addressUrl, isConfigured, publicClient, shortAddress} from "../lib/chain.ts";

// Always read fresh. A cached view of a spend limit is a wrong view of a spend limit.
export const dynamic = "force-dynamic";

/**
 * One log walk per request, shared by both streamed sections.
 *
 * The leash card needs two counts out of the audit log and the feed needs all of it. Left
 * alone that is two independent walks of the same history; `cache` collapses them into one
 * for the life of a single request, and no longer.
 */
const auditFor = cache(readAuditLog);

function NotConfigured() {
  return (
    <main className="wrap">
      <section className="card">
        <h2 className="card-title">Not configured</h2>
        <p className="card-note">
          Set <code>POLICY_ENGINE_ADDRESS</code> and <code>OWNER_ADDRESS</code> in the
          repository-root <code>.env</code>, then reload.
        </p>
      </section>
    </main>
  );
}

/**
 * The two facts that can only come from the log walk.
 *
 * Split out so the rest of the leash — the caps the contract actually enforces — paints
 * from the single `getPolicy` call without waiting on seven `eth_getLogs` round trips.
 */
async function LeashFacts({owner}: {owner: Address}) {
  const audit = await auditFor(owner);
  const payments = audit.entries.filter((entry) => entry.kind === "paid");
  return (
    <>
      <dt>approved payees</dt>
      <dd>{audit.allowedPayees.length}</dd>
      <dt>payments made</dt>
      <dd>{payments.length}</dd>
    </>
  );
}

async function ActivitySection({owner}: {owner: Address}) {
  const audit = await auditFor(owner);
  return <Feed entries={audit.entries} />;
}

export default async function Page() {
  if (!isConfigured()) return <NotConfigured />;

  const [policyRaw, pending] = await Promise.all([
    publicClient.readContract({address: ENGINE, abi, functionName: "getPolicy", args: [OWNER]}),
    listPending(),
  ]);

  const policy = policyRaw as unknown as Policy;

  if (!policy.exists) {
    return (
      <main className="wrap">
        <section className="card">
          <h2 className="card-title">No policy yet</h2>
          <p className="card-note">
            No policy exists for {shortAddress(OWNER)} on this contract. Seed one with{" "}
            <code>forge script script/SeedDemo.s.sol:SeedDemo --broadcast</code>.
          </p>
        </section>
      </main>
    );
  }

  const headroom = availableNow(policy);

  return (
    <>
      <header className="mast">
        <div className="mast-inner">
          <div>
            <p className="eyebrow">Agent spend control · Arc testnet</p>
            <h1 className="wordmark">Tollgate</h1>
          </div>
          <div className="mast-meta">
            <LiveRefresh />
            <div>
              policy{" "}
              <a href={addressUrl(ENGINE)} target="_blank" rel="noreferrer">
                {shortAddress(ENGINE)} <ExternalIcon size={11} />
              </a>
            </div>
            <div>
              owner{" "}
              <a href={addressUrl(OWNER)} target="_blank" rel="noreferrer">
                {shortAddress(OWNER)} <ExternalIcon size={11} />
              </a>
            </div>
            <div>chain {arcTestnet.id}</div>
          </div>
        </div>
      </header>

      <main className="wrap">
        <Verdict policy={policy} />

        <div className="grid grid-2">
          <section className="card">
            <h2 className="card-title">This agent&rsquo;s leash</h2>
            <p className="card-note">
              Enforced in the contract, not in the agent. It cannot change any of this.
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

            <dl className="facts" style={{marginTop: 20}}>
              <dt>agent key</dt>
              <dd>
                <a href={addressUrl(policy.agent)} target="_blank" rel="noreferrer">
                  {shortAddress(policy.agent)}
                </a>
              </dd>
              <dt>per payment</dt>
              <dd>{formatUsdc(policy.perTxCap)}</dd>
              <dt>expires</dt>
              <dd>
                {policy.expiry === 0n
                  ? "never"
                  : new Date(Number(policy.expiry) * 1000).toLocaleDateString()}
              </dd>
              <Suspense fallback={<SkeletonFacts />}>
                <LeashFacts owner={OWNER} />
              </Suspense>
            </dl>
          </section>

          <div className="stack">
            <KillSwitch paused={policy.paused} />
            <ApprovalQueue requests={pending} />
          </div>
        </div>

        <Suspense fallback={<SkeletonFeed />}>
          <ActivitySection owner={OWNER} />
        </Suspense>
      </main>
    </>
  );
}
