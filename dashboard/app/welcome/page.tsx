import Link from "next/link";
import {activeChain} from "@tollgate/shared";

export const metadata = {
  title: "How Tollgate works",
  description: "Spend limits for AI agents that live in a contract, not in the agent.",
};

/**
 * The public explanation. Static: it reads nothing from the chain, so it renders instantly
 * and works before anything is configured. It is the page someone lands on from a link,
 * which is why it makes the claim before it asks for anything.
 */
export default function Welcome() {
  return (
    <>
      <section className="hero">
        <h1>Give an AI agent a wallet it can&rsquo;t overspend.</h1>
        <p>
          Tollgate puts the spending limits in a smart contract on Arc, not in the agent. Even if
          the agent&rsquo;s key is stolen or its prompt is hijacked, the contract refuses any
          payment outside the rules you set. You keep your money the whole time.
        </p>
        <div className="hero-actions">
          <Link href="/" className="primary-link">
            Open the dashboard
          </Link>
          <Link href="/activity">See refused payments</Link>
        </div>
      </section>

      <div className="steps-3">
        <section className="card">
          <p className="step-num">1</p>
          <h3>You set the leash</h3>
          <p>
            A total budget, a per-payment cap, a spend rate, and a list of approved payees. You
            approve exactly that budget from your own wallet. Nothing is deposited anywhere.
          </p>
        </section>
        <section className="card">
          <p className="step-num">2</p>
          <h3>The agent asks, the contract decides</h3>
          <p>
            The agent can only request a payment. The contract checks every rule first and moves
            USDC straight from you to the payee, or refuses with a reason.
          </p>
        </section>
        <section className="card">
          <p className="step-num">3</p>
          <h3>You can verify and stop it</h3>
          <p>
            Every payment and every refusal is on chain with a link to prove it. Pausing or
            revoking is one transaction from your wallet, and it works even if this site is down.
          </p>
        </section>
      </div>

      <section className="card">
        <h2 className="card-title">Why on-chain limits are different</h2>
        <table className="compare">
          <thead>
            <tr>
              <th></th>
              <th>Limits inside the agent or app</th>
              <th>Tollgate</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Stolen agent key</th>
              <td data-label="Rules in the app">Attacker bypasses the app and spends freely.</td>
              <td data-label="Tollgate">Refused by the contract. No path skips the check.</td>
            </tr>
            <tr>
              <th scope="row">Hijacked prompt</th>
              <td data-label="Rules in the app">Model can be talked out of its own rule.</td>
              <td data-label="Tollgate">The rule is not the model&rsquo;s to change.</td>
            </tr>
            <tr>
              <th scope="row">Custody</th>
              <td data-label="Rules in the app">Often a pooled or hosted wallet.</td>
              <td data-label="Tollgate">Your wallet. Revoke any time with approve(0).</td>
            </tr>
            <tr>
              <th scope="row">Proof</th>
              <td data-label="Rules in the app">Trust the vendor&rsquo;s logs.</td>
              <td data-label="Tollgate">Public events anyone can read.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="card note-card" style={{marginTop: 18}}>
        <p className="prose">
          Running on {activeChain.name}
          {activeChain.testnet ? " (testnet, no real money)" : " (mainnet, real USDC)"}. This is
          an early, unaudited release: approve only budgets you are happy to lose, and read the{" "}
          <a href="https://github.com/kenkomu/tollgate/blob/main/docs/threat-model.md">
            threat model
          </a>
          .
        </p>
      </section>
    </>
  );
}
