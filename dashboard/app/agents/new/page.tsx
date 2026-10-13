import Link from "next/link";
import {CreatePolicy} from "../../../components/CreatePolicy.tsx";
import {NotConfigured, PageHead} from "../../../components/PageHead.tsx";
import {isConfigured} from "../../../lib/chain.ts";

export const dynamic = "force-dynamic";

/**
 * Add an agent (ADR 0010).
 *
 * The same form as the first policy. What differs is the allowance: it is shared, so this adds
 * the new budget to what is already approved instead of replacing it.
 */
export default function NewAgentPage() {
  if (!isConfigured()) {
    return (
      <>
        <PageHead title="Add an agent" lede="Give another agent its own leash." />
        <NotConfigured />
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Add an agent"
        lede="Another agent, with its own key, budget, rate limit and payees. Your other agents are untouched."
      />
      <section className="card note-card">
        <p className="prose">
          Give each agent a key of its own. A key can only ever be bound to one policy, so a leak
          reaches one budget and one allowlist. Your USDC allowance is shared by every agent, so
          this adds the new budget to it rather than replacing it.
        </p>
      </section>
      <CreatePolicy />
      <p className="hint">
        <Link href="/">Back to your agents</Link>
      </p>
    </>
  );
}
