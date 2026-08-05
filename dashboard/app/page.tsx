import {arcTestnet, availableNow, formatUsdc, fromUsdc, ratePerDay, type Policy} from "@tollgate/shared";
import {ApprovalQueue} from "../components/ApprovalQueue.tsx";
import {Feed} from "../components/Feed.tsx";
import {KillSwitch} from "../components/KillSwitch.tsx";
import {Meter} from "../components/Meter.tsx";
import {readAuditLog} from "../lib/activity.ts";
import {listPending} from "../lib/approvals.ts";
import {ENGINE, OWNER, abi, addressUrl, isConfigured, publicClient, shortAddress} from "../lib/chain.ts";

// Always read fresh. A cached view of a spend limit is a wrong view of a spend limit.
export const dynamic = "force-dynamic";

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

  const audit = await readAuditLog(OWNER);
  const headroom = availableNow(policy);
  const payments = audit.entries.filter((entry) => entry.kind === "paid");

  return (
    <>
      <header className="mast">
        <div className="mast-inner">
          <div>
            <p className="eyebrow">Agent spend control · Arc testnet</p>
            <h1 className="wordmark">Tollgate</h1>
          </div>
          <div className="mast-meta">
            <div>
              policy{" "}
              <a href={addressUrl(ENGINE)} target="_blank" rel="noreferrer">
                {shortAddress(ENGINE)} ↗
              </a>
            </div>
            <div>
              owner{" "}
              <a href={addressUrl(OWNER)} target="_blank" rel="noreferrer">
                {shortAddress(OWNER)} ↗
              </a>
            </div>
            <div>chain {arcTestnet.id}</div>
          </div>
        </div>
      </header>

      <main className="wrap">
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
              caption={`${fromUsdc(policy.budgetCap - policy.spent)} USDC left of the lifetime budget`}
            />
            <Meter
              label="rate headroom"
              value={headroom}
              total={policy.bucketCapacity}
              sense="remaining"
              caption={`refills at about ${ratePerDay(policy.refillPerSecond)} USDC a day`}
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
              <dt>approved payees</dt>
              <dd>{audit.allowedPayees.length}</dd>
              <dt>expires</dt>
              <dd>
                {policy.expiry === 0n
                  ? "never"
                  : new Date(Number(policy.expiry) * 1000).toLocaleDateString()}
              </dd>
              <dt>payments made</dt>
              <dd>{payments.length}</dd>
            </dl>
          </section>

          <div style={{display: "flex", flexDirection: "column", gap: 18}}>
            <KillSwitch paused={policy.paused} />
            <ApprovalQueue requests={pending} />
          </div>
        </div>

        <Feed entries={audit.entries} />
      </main>
    </>
  );
}
