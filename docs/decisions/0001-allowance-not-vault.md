# 0001 — Enforce on an allowance, not a vault

**Status:** accepted · **Date:** 2026-08-05

## Context

The original plan proposed a custody vault for the hackathon probe: agents deposit USDC
into a Tollgate contract, which releases it under policy. The plan itself called this "a
speed hack" and named a single contract bug draining user funds as the one existential
technical risk.

The intended long-term design is a policy module installed on an ERC-6900 modular smart
account, enforcing at the account's validation layer. That is not available: Circle's
Modular Wallets ship exactly one module today (Address Book), the Session Keys module is
marked "coming soon" with limited availability, and there is no documented deployment path
for a custom module.

So the destination architecture is blocked, and the fallback contradicts the thesis.

## Decision

Neither. Enforce on an **ERC-20 allowance**.

The owner keeps USDC in their own wallet and calls `approve(PolicyEngine, budget)`. The
agent calls `PolicyEngine.spend(payee, amount)`. The contract evaluates policy and, only
on success, calls `transferFrom(owner, payee, amount)`.

This is viable on Arc because USDC is both the native gas token *and* exposes an ERC-20
interface at the predeploy `0x3600000000000000000000000000000000000000`, sharing one
underlying balance. Circle's docs describe that interface as being there precisely "for
developers who need `transferFrom`, `approve`, and allowance management."

## Consequences

**Good**

- Genuinely non-custodial. There is no deposit function and no withdraw function; the
  contract's own balance is asserted to be zero as a continuous invariant.
- No honeypot. A vault pools every user's funds behind one contract; this pools nothing.
- Exit is unilateral. `approve(engine, 0)` ends the relationship without our cooperation,
  our permission, or our servers being reachable.
- **A second ceiling.** Owners approve exactly their budget, never `type(uint256).max`.
  The allowance then bounds the blast radius of a bug in our own code — something a vault
  structurally cannot offer.
- Forward-compatible. The checks live in one `_evaluate` function that becomes the body of
  an ERC-6900 module when session keys ship; the allowance wrapper simply falls away.

**Bad**

- Narrower scope than the module design. An allowance governs pull-transfers of one token.
  It does not govern arbitrary contract calls the agent might make with its own funds. For
  spend policy on USDC — the whole x402 and nanopayment surface — this is the right scope,
  but the claim must be stated as "enforcement on the money movement", not "on everything
  the agent does".
- Two owner transactions to set up (approve, then createPolicy) rather than one.

## Alternatives rejected

- **Custody vault.** No faster to build, and it makes us custodial while pitching
  non-custodial.
- **Wait for ERC-6900 session keys.** Correct destination, unavailable now.
- **Own ERC-4337 account with policy in `validateUserOp`.** This is the real Phase-2 path
  and does *not* depend on Circle shipping anything — worth revisiting. Rejected for now
  because writing a secure 4337 account is exactly the kind of work that should not be
  done against a five-day deadline.
