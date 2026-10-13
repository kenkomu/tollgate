import Link from "next/link";
import {erc20Abi, type Address} from "viem";
import {USDC_ADDRESS} from "@tollgate/shared";
import {ENGINE, publicClient} from "../lib/chain.ts";
import {tryAudit} from "../lib/data.ts";

/**
 * The first-run checklist.
 *
 * A blank page after "connect wallet" gives a newcomer no next move. This turns setup into
 * four visible steps whose state is read from the chain, not remembered by the browser — so
 * it is right after a refresh, on another device, and after the owner acts in a block
 * explorer instead of here. It disappears once every step is done.
 */

export interface Step {
  title: string;
  detail: string;
  done: boolean;
  href?: string;
  cta?: string;
}

export function Checklist({steps}: {steps: Step[]}) {
  const next = steps.findIndex((step) => !step.done);
  const doneCount = steps.filter((step) => step.done).length;

  return (
    <section className="card setup" aria-labelledby="setup-title">
      <div className="setup-head">
        <h2 className="card-title" id="setup-title">
          Get set up
        </h2>
        <span className="setup-count">
          {doneCount} of {steps.length} done
        </span>
      </div>
      <ol className="setup-steps">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className={`setup-step${step.done ? " done" : ""}${index === next ? " current" : ""}`}
            aria-current={index === next ? "step" : undefined}
          >
            <span className="setup-mark" aria-hidden="true">
              {step.done ? "✓" : index + 1}
            </span>
            <div>
              <p className="setup-title">
                {step.title}
                <span className="visually-hidden">{step.done ? " (done)" : ""}</span>
              </p>
              <p className="setup-detail">{step.detail}</p>
              {index === next && step.href ? (
                <Link href={step.href} className="setup-cta">
                  {step.cta ?? "Open"} →
                </Link>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Before a policy exists: only step one can be acted on, so show the road ahead. */
export function PreSetup() {
  return (
    <Checklist
      steps={[
        {
          title: "Connect your wallet",
          detail: "Your wallet signs everything. Our server never holds a key.",
          done: false,
        },
        {
          title: "Create a policy",
          detail: "Name the agent and set its ceiling, per-payment cap and spend rate (form below).",
          done: false,
        },
        {
          title: "Approve exactly the budget",
          detail: "Done in the same step: an allowance for the budget and not a cent more.",
          done: false,
        },
        {
          title: "Add a first payee",
          detail: "Only approved payees can ever be paid.",
          done: false,
        },
      ]}
    />
  );
}

/** With a policy: read the allowance and payee list, hide when finished. */
export async function SetupGuide({owner, needed}: {owner: Address; needed: bigint}) {
  const [allowance, audit] = await Promise.all([
    publicClient
      .readContract({address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [owner, ENGINE]})
      .then((value) => value as bigint)
      .catch(() => null),
    tryAudit(owner),
  ]);

  // `needed` is what every agent together can still spend: the allowance is shared.
  const allowanceOk = allowance !== null && allowance >= needed && needed > 0n;
  // Partial history can miss an old approval, so it does not count as knowing.
  const payeesKnown = audit.ok && audit.value.partialFrom === undefined;
  const hasPayee = audit.ok && audit.value.allowedPayees.length > 0;

  // Unknown is not "done" and not "missing": if the log walk failed, say nothing rather
  // than send the owner to fix something that may be fine.
  if (allowanceOk && (hasPayee || !payeesKnown)) return null;

  return (
    <Checklist
      steps={[
        {title: "Connect your wallet", detail: "Signing happens in your wallet, never on our server.", done: true},
        {title: "Create a policy", detail: "Your agent's limits are live in the contract.", done: true},
        {
          title: "Approve exactly the budget",
          detail: allowanceOk
            ? "The allowance covers what your agents can still spend."
            : "The allowance is below what your agents can still spend, so payments will be refused once it runs out. Top it up.",
          done: allowanceOk,
          href: "/policy",
          cta: "Fix the allowance",
        },
        {
          title: "Add a first payee",
          detail: "Until someone is approved, every payment is refused.",
          done: hasPayee,
          href: "/payees",
          cta: "Add a payee",
        },
      ]}
    />
  );
}
