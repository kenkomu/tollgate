import {activeChain} from "@tollgate/shared";
import {ENGINE, OWNER, addressUrl, shortAddress} from "../lib/chain.ts";
import {CreatePolicy} from "./CreatePolicy.tsx";
import {ExternalIcon} from "./Icon.tsx";
import {PreSetup} from "./SetupGuide.tsx";

/**
 * The header every section shares.
 *
 * The contract and owner addresses ride along on every page rather than living once on
 * an "about" screen, because they are what makes the rest of the page checkable. A number
 * you cannot trace to an address is a number you are being asked to take on faith.
 */
export function PageHead({title, lede}: {title: string; lede: string}) {
  return (
    <header className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="page-lede">{lede}</p>
      </div>
      <dl className="page-meta">
        <dt>policy</dt>
        <dd>
          <a href={addressUrl(ENGINE)} target="_blank" rel="noreferrer">
            {shortAddress(ENGINE)} <ExternalIcon size={11} />
          </a>
        </dd>
        <dt>owner</dt>
        <dd>
          <a href={addressUrl(OWNER)} target="_blank" rel="noreferrer">
            {shortAddress(OWNER)} <ExternalIcon size={11} />
          </a>
        </dd>
        <dt>chain</dt>
        <dd>{activeChain.id}</dd>
      </dl>
    </header>
  );
}

export function NotConfigured() {
  return (
    <section className="card">
      <h2 className="card-title">Not configured</h2>
      <p className="card-note">
        Set <code>POLICY_ENGINE_ADDRESS</code> and <code>OWNER_ADDRESS</code> in the
        repository-root <code>.env</code>, then reload.
      </p>
    </section>
  );
}

export function NoPolicy() {
  return (
    <>
      <PreSetup />
      <section className="card note-card">
        <p className="prose">
          No policy exists for <code>{shortAddress(OWNER)}</code> yet. Creating one takes
          two transactions and about thirty seconds — you keep your money the whole time,
          and nothing can move until you name an agent and a ceiling.
        </p>
      </section>
      <CreatePolicy />
    </>
  );
}

/**
 * The chain is unreachable.
 *
 * The most important state in this app to get right, and the easiest to get wrong by
 * omission. Every number on every other page is a claim about what an agent is currently
 * allowed to spend. When we cannot reach Arc we do not know any of them, and the honest
 * answer is to say so — not to show the last thing we saw, and certainly not to render a
 * framework error page that reads as "the product is broken".
 *
 * The kill switch is deliberately still described here, because it does not depend on this
 * app: it is a direct owner-to-chain write and works from any wallet or block explorer.
 * Someone who reached this screen because something is going wrong needs to know that.
 */
export function ChainUnreachable({detail}: {detail?: string}) {
  return (
    <section className="card stopped">
      <h2 className="card-title">Cannot reach Arc</h2>
      <p className="card-note">
        This page could not read the contract, so it cannot tell you what your agent is
        allowed to spend right now. Nothing shown elsewhere should be trusted until this
        clears — and no policy has changed, because reading is all this app was trying to do.
      </p>
      <p className="prose">
        Your controls do not depend on this dashboard. The policy lives at{" "}
        <a href={addressUrl(ENGINE)} target="_blank" rel="noreferrer">
          <code>{shortAddress(ENGINE)}</code> <ExternalIcon size={11} />
        </a>{" "}
        and <code>setPaused</code> can be called from any wallet or block explorer. That is
        the whole point of the kill switch being an on-chain write.
      </p>
      {detail ? <p className="card-note" style={{marginTop: 10}}>{detail}</p> : null}
    </section>
  );
}
