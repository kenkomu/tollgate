# 0005 — ERC-8183 escrow routing: deferred, not dropped

**Status:** deferred · **Date:** 2026-08-05

## Context

The plan names the x402 verify-versus-settle gap as its hardest open technical problem —
payment can settle without the service being delivered — and proposed addressing it partly
by contributing upstream to the specification.

That is unnecessary. **Arc ships an escrow primitive natively.** ERC-8183 defines a job
lifecycle of create → fund escrow in USDC → submit a deliverable hash → an named evaluator
calls `complete()`, which releases the funds. States are Open, Funded, Submitted,
Completed, Rejected, Expired. A reference implementation is live on Arc testnet at
`0x0747EEf0706327138c69792bF28Cd525089e4583`. Alongside it, ERC-8004 provides on-chain
agent identity and reputation.

This is delivery-conditioned release — the only genuine fix on the plan's own list of
options — available off the shelf.

## The idea

Tollgate as a **router**, where policy chooses the settlement rail:

- small, high-frequency calls stream over x402 nanopayments;
- anything above an owner-set threshold is forced through ERC-8183 escrow with a
  deliverable.

The threshold is policy. That reframes the product from "a spend cap" to "the layer that
decides how much ceremony a payment needs", which is more defensible against Circle's own
off-chain spend controls, and uses considerably more of the Arc stack — itself a judging
criterion.

## Decision

**Deferred to a stretch.** Build and harden the core — PolicyEngine, dashboard, agent loop
— first. Add routing only if all three are working with time left.

Rationale: the hackathon's stated criterion is "quality of execution over complexity". A
solid core beats an ambitious half-finished one, and this is real additional surface with
days rather than weeks available.

## Worth knowing before we build it

ERC-8183 shifts trust to the evaluator rather than eliminating it — a compromised or lazy
evaluator can still approve substandard work and release funds. That is a much better
position than "payment settles, service may or may not arrive", but it is not atomicity
and should not be described as such.

## An enforcement gap this exposes

Circle's Gateway nanopayments settle **off-chain**: the buyer funds a Gateway balance with
one on-chain deposit, then signs EIP-3009 authorisations that Circle batches and settles in
bulk. Those per-call payments never touch a contract PolicyEngine can intercept.

So for nanopayment streams, our enforcement point is the **top-up into the Gateway
balance**, not each individual call — we budget the pipe rather than each drop. The token
bucket is exactly the right primitive for that, but the claim has to be stated precisely.
Notably this is one place where Circle's off-chain controls are genuinely stronger than
ours, because the payments are on their own rails; ours hold on any on-chain movement
regardless of provider. Complementary, not strictly better.

ERC-8183 escrow, by contrast, *is* on-chain — `fund()` is a contract call — so it is a rail
where per-transaction enforcement genuinely works. That is a further argument for routing
value through escrow rather than streaming it.
