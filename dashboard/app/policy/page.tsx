import {erc20Abi} from "viem";
import {agentLabel, availableNow, formatUsdc, formatUsdcApprox, USDC_ADDRESS} from "@tollgate/shared";
import {AgentSwitcher} from "../../components/AgentSwitcher.tsx";
import {ExternalIcon} from "../../components/Icon.tsx";
import {FleetSwitch, KillSwitch} from "../../components/KillSwitch.tsx";
import {Meter} from "../../components/Meter.tsx";
import {ChainUnreachable, NoPolicy, NotConfigured, PageHead} from "../../components/PageHead.tsx";
import {
  AgentEditor,
  AllowanceEditor,
  CapsEditor,
  ExpiryEditor,
  RevokeEditor,
  VelocityEditor,
} from "../../components/PolicyEditors.tsx";
import {fleetRemaining, owner, pickPolicy, tryFleet} from "../../lib/data.ts";
import {ENGINE, addressUrl, isConfigured, publicClient, shortAddress} from "../../lib/chain.ts";

export const dynamic = "force-dynamic";

/**
 * The policy itself, in full.
 *
 * Every row states the rule and what it stops, because a cap without its consequence is
 * just a number. This page needs only `getPolicy`, so it never waits on the log walk.
 */
export default async function PolicyPage({searchParams}: {searchParams: Promise<{agent?: string | string[]}>}) {
  if (!isConfigured()) {
    return (
      <>
        <PageHead title="Policy" lede="The rules the contract enforces." />
        <NotConfigured />
      </>
    );
  }

  const read = await tryFleet(owner);
  if (!read.ok) {
    return (
      <>
        <PageHead title="Policy" lede="The rules the contract enforces." />
        <ChainUnreachable detail={read.error} />
      </>
    );
  }

  const fleet = read.value;
  const policy = pickPolicy(fleet, (await searchParams).agent);
  if (!policy) {
    return (
      <>
        <PageHead title="Policy" lede="The rules the contract enforces." />
        <NoPolicy />
      </>
    );
  }

  const headroom = availableNow(policy);
  const many = fleet.policies.length > 1;
  const name = many ? agentLabel(policy.id) : undefined;

  // The second ceiling. A policy whose allowance is below its budget refuses at the
  // allowance, so showing one without the other would be a half-truth.
  const allowance = (await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, ENGINE],
  })) as bigint;

  const rules = [
    {
      rule: "Lifetime budget",
      value: formatUsdc(policy.budgetCap),
      stops: "Total spending, ever. Once reached, every further payment is refused.",
    },
    {
      rule: "Per payment",
      value: formatUsdc(policy.perTxCap),
      stops: "Any single transfer above this, however much budget remains.",
    },
    {
      rule: "Burst",
      value: formatUsdc(policy.bucketCapacity),
      stops: "The most that can leave at once when the bucket is full.",
    },
    {
      rule: "Refill rate",
      value: `${formatUsdcApprox(policy.refillPerSecond * 86_400n)} a day`,
      stops: "Sustained outflow. Many small legal payments still cannot drain you fast.",
    },
    {
      rule: "Expiry",
      value: policy.expiry === 0n ? "never" : new Date(Number(policy.expiry) * 1000).toLocaleString(),
      stops: "Everything, after this moment. A dead man's switch for an abandoned agent.",
    },
  ];

  return (
    <>
      <PageHead
        title={name ? `Policy · ${name}` : "Policy"}
        lede={
          many
            ? `The five rules every payment from ${name} must satisfy. Your other agents have their own.`
            : "The five rules every payment must satisfy, and the switch that stops them all."
        }
      />

      <AgentSwitcher policies={fleet.policies} current={policy.id} path="/policy" fleetPaused={fleet.fleetPaused} />

      <KillSwitch policyId={policy.id} paused={policy.paused} fleetPaused={fleet.fleetPaused} name={name} />
      {many || fleet.fleetPaused ? <FleetSwitch paused={fleet.fleetPaused} agents={fleet.policies.length} /> : null}

      <div className="grid grid-2">
        <section className="card">
          <h2 className="card-title">Where it stands now</h2>
          <p className="card-note">Live from the contract.</p>
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
            caption="refills continuously, capped at the burst ceiling"
          />
        </section>

        <section className="card">
          <h2 className="card-title">The agent</h2>
          <p className="card-note">
            One key, bound to this policy. It can request payments and nothing else — it
            cannot change a cap, add a payee, or lift the pause.
          </p>
          <dl className="facts">
            <dt>agent key</dt>
            <dd>
              <a href={addressUrl(policy.agent)} target="_blank" rel="noreferrer">
                {shortAddress(policy.agent)} <ExternalIcon size={11} />
              </a>
            </dd>
            <dt>spent to date</dt>
            <dd>{formatUsdc(policy.spent)}</dd>
            <dt>policy id</dt>
            <dd>{policy.id.toString()}</dd>
            <dt>state</dt>
            <dd>{fleet.fleetPaused ? "stopped with every agent" : policy.paused ? "paused" : "active"}</dd>
          </dl>
        </section>
      </div>

      <section>
        <h2 className="section-title">Change the policy</h2>
        <p className="section-note">
          Each of these is a transaction you sign, straight to the contract. The agent
          cannot reach any of them.
        </p>
        <div className="editors">
          <CapsEditor policy={policy} />
          <VelocityEditor policy={policy} />
          <AllowanceEditor allowance={allowance} needed={fleetRemaining(fleet)} agents={fleet.policies.length} />
          <ExpiryEditor policy={policy} />
          <AgentEditor policy={policy} />
          <RevokeEditor policyId={policy.id} name={name} />
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">The rules</h2>
        <p className="card-note">
          Checked in this order on every payment. The first one that fails reverts the
          transaction, and no money moves.
        </p>
        <div className="table-wrap">
          <table className="rules">
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Setting</th>
                <th scope="col">What it stops</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((row) => (
                <tr key={row.rule}>
                  <th scope="row">{row.rule}</th>
                  <td className="num" data-label="Setting">{row.value}</td>
                  <td className="muted-cell" data-label="What it stops">{row.stops}</td>
                </tr>
              ))}
              <tr>
                <th scope="row">Payee allowlist</th>
                <td className="num" data-label="Setting">strict</td>
                <td className="muted-cell" data-label="What it stops">
                  Any address you have not approved. This is the rule the compromised-agent
                  demo runs into.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
