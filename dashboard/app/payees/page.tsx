import {Suspense} from "react";
import {ApprovalQueue} from "../../components/ApprovalQueue.tsx";
import {ChainUnreachable, NotConfigured, PageHead, PartialHistory} from "../../components/PageHead.tsx";
import {PayeeRow} from "../../components/PayeeRow.tsx";
import {AddPayeeEditor} from "../../components/PolicyEditors.tsx";
import {agentLabel} from "@tollgate/shared";
import {AgentSwitcher} from "../../components/AgentSwitcher.tsx";
import {owner, pendingApprovals, pickPolicy, scopeAudit, tryAudit, tryFleet} from "../../lib/data.ts";
import {isConfigured} from "../../lib/chain.ts";

export const dynamic = "force-dynamic";

async function Allowlist({policyId, name}: {policyId: bigint; name: string | undefined}) {
  const read = await tryAudit(owner);
  // "No payees approved" and "we could not read the allowlist" must never look the same.
  // The first means the agent can pay nobody; the second means we do not know who it can pay.
  if (!read.ok) return <ChainUnreachable detail={read.error} />;
  // Allowlists are per agent (ADR 0010): this one's, and nobody else's.
  const audit = scopeAudit(read.value, policyId);
  const partial = audit.partialFrom !== undefined;

  return (
    <>
    <PartialHistory from={audit.partialFrom} />
    <section className="card">
      <h2 className="card-title">
        {name ? `${name}'s allowlist` : "Allowlist"}
        {partial ? " (recent changes only)" : ""}
      </h2>
      <p className="card-note">
        The complete set of addresses {name ?? "your agent"} may pay. Anything not on this list
        is refused by the contract, whatever the agent believes.
      </p>

      {audit.allowedPayees.length === 0 ? (
        <div className="empty">
          {partial
            ? "No payees were approved in the recent history read. Older approvals may exist; start the service to see them."
            : `No payees approved. ${name ?? "The agent"} cannot pay anyone.`}
        </div>
      ) : (
        <div className="rows">
          {audit.allowedPayees.map((payee) => (
            <PayeeRow key={payee} payee={payee} policyId={policyId} />
          ))}
        </div>
      )}
    </section>
    </>
  );
}

async function Requests({agents}: {agents: bigint[]}) {
  const pending = await pendingApprovals();
  return <ApprovalQueue requests={pending} agents={agents} />;
}

export default async function PayeesPage({searchParams}: {searchParams: Promise<{agent?: string | string[]}>}) {
  if (!isConfigured()) {
    return (
      <>
        <PageHead title="Payees" lede="Who your agent is allowed to pay." />
        <NotConfigured />
      </>
    );
  }

  const fleetRead = await tryFleet(owner);
  if (!fleetRead.ok) {
    return (
      <>
        <PageHead title="Payees" lede="Who your agent is allowed to pay." />
        <ChainUnreachable detail={fleetRead.error} />
      </>
    );
  }
  const fleet = fleetRead.value;
  const policy = pickPolicy(fleet, (await searchParams).agent);
  const many = fleet.policies.length > 1;
  const name = policy && many ? agentLabel(policy.id) : undefined;

  return (
    <>
      <PageHead
        title="Payees"
        lede={
          many
            ? "Who each agent may pay, and who they have asked you to add. Every agent has its own list."
            : "Who your agent is allowed to pay — and who it has asked you to add."
        }
      />
      <AgentSwitcher
        policies={fleet.policies}
        current={policy?.id ?? null}
        path="/payees"
        fleetPaused={fleet.fleetPaused}
      />

      <section className="card note-card">
        <p className="prose">
          A strict allowlist is the strongest guarantee here and it has a real cost: the
          agent cannot pay anyone new, however good the reason. That cost is paid on this
          page. The agent asks, you decide, and the leash lengthens one link at a time.
          Approving writes <code>setPayee</code> on chain — until that transaction lands,
          the agent stays refused.
        </p>
      </section>

      <Suspense fallback={<div className="card empty">Loading requests&hellip;</div>}>
        <Requests agents={fleet.policies.map((p) => p.id)} />
      </Suspense>

      {policy ? (
        <>
          <AddPayeeEditor policyId={policy.id} name={name} />
          <Suspense fallback={<div className="card empty">Reading the allowlist from Arc&hellip;</div>}>
            <Allowlist policyId={policy.id} name={name} />
          </Suspense>
        </>
      ) : (
        <section className="card empty">No agents yet, so nobody can be paid. Create one on the overview.</section>
      )}
    </>
  );
}
