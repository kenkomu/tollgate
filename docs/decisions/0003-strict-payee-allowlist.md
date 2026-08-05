# 0003 — Strict payee allowlist

**Status:** accepted · **Date:** 2026-08-05

## Context

Three regimes were considered for constraining *where* an agent may send money:

1. **Strict allowlist** — every payee pre-approved by the owner.
2. **Two-tier threshold** — strict above an owner-set threshold, open but per-transaction
   capped below it.
3. **Caps only** — any payee, bounded purely by amount.

## Decision

**Strict allowlist.** `isAllowedPayee[owner][payee]` must be true or the spend is refused
with `PAYEE_NOT_ALLOWED`.

## Consequences

**Good**

- The strongest guarantee available, and the easiest to reason about in an audit: an agent
  can only ever transact with addresses its owner explicitly named.
- It makes the compromised-agent demo land properly. With caps only, an attacker holding
  the agent key drains the whole budget to their own address one capped transaction at a
  time — bounding the loss but not preventing it. With a strict allowlist the money can
  only ever go somewhere the owner already chose.

**Bad — and this is a real product cost**

- It breaks Circle's Agent Marketplace discovery flow. An agent that finds a new service
  cannot pay it, because the owner never allowlisted an address they had never heard of.
  The starter-kit demo is literally "discover services via the Marketplace and pay them",
  so this is not a hypothetical.

## How we turn the cost into the story

Rather than hide the friction, make it the point. The agent discovers a service, attempts
payment, and is refused on camera. The owner is prompted, approves the payee in one
transaction, and the agent proceeds.

That is the calibrated-trust and progressive-autonomy narrative from the product design,
made concrete: the leash lengthens deliberately, by a human, one link at a time. It is a
better demo beat than a payment that silently succeeds.

It does mean the dashboard must ship a payee-approval flow, which is scope that the
two-tier option would not have required.

## Revisit when

The two-tier threshold is the natural evolution, and it shares its shape with the
escrow-versus-nanopayment routing idea in [0005](0005-erc8183-escrow-routing.md) — in both
cases an owner-set threshold decides how much ceremony a payment needs. If discovery turns
out to matter to real users, the threshold becomes the central policy primitive rather
than the cap.
