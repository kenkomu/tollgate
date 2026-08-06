import {arcTestnet} from "@tollgate/shared";
import {ENGINE, OWNER, addressUrl, shortAddress} from "../lib/chain.ts";
import {ExternalIcon} from "./Icon.tsx";

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
        <dd>{arcTestnet.id}</dd>
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
    <section className="card">
      <h2 className="card-title">No policy yet</h2>
      <p className="card-note">
        No policy exists for {shortAddress(OWNER)} on this contract. Seed one with{" "}
        <code>forge script script/SeedDemo.s.sol:SeedDemo --broadcast</code>.
      </p>
    </section>
  );
}
