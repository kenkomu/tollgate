import {Suspense} from "react";
import {ApprovalQueue} from "../../components/ApprovalQueue.tsx";
import {ChainUnreachable, NotConfigured, PageHead} from "../../components/PageHead.tsx";
import {PayeeRow} from "../../components/PayeeRow.tsx";
import {AddPayeeEditor} from "../../components/PolicyEditors.tsx";
import {owner, pendingApprovals, tryAudit} from "../../lib/data.ts";
import {isConfigured} from "../../lib/chain.ts";

export const dynamic = "force-dynamic";

async function Allowlist() {
  const read = await tryAudit(owner);
  // "No payees approved" and "we could not read the allowlist" must never look the same.
  // The first means the agent can pay nobody; the second means we do not know who it can pay.
  if (!read.ok) return <ChainUnreachable detail={read.error} />;
  const audit = read.value;

  return (
    <section className="card">
      <h2 className="card-title">Allowlist</h2>
      <p className="card-note">
        The complete set of addresses your agent may pay. Anything not on this list is
        refused by the contract, whatever the agent believes.
      </p>

      {audit.allowedPayees.length === 0 ? (
        <div className="empty">No payees approved. The agent cannot pay anyone.</div>
      ) : (
        <div className="rows">
          {audit.allowedPayees.map((payee) => (
            <PayeeRow key={payee} payee={payee} />
          ))}
        </div>
      )}
    </section>
  );
}

async function Requests() {
  const pending = await pendingApprovals();
  return <ApprovalQueue requests={pending} />;
}

export default function PayeesPage() {
  if (!isConfigured()) {
    return (
      <>
        <PageHead title="Payees" lede="Who your agent is allowed to pay." />
        <NotConfigured />
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Payees"
        lede="Who your agent is allowed to pay — and who it has asked you to add."
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
        <Requests />
      </Suspense>

      <AddPayeeEditor />

      <Suspense fallback={<div className="card empty">Reading the allowlist from Arc&hellip;</div>}>
        <Allowlist />
      </Suspense>
    </>
  );
}
