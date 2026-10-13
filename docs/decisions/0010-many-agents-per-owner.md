# ADR 0010 — Many agents per owner

**Status:** accepted · supersedes 0004
**Date:** 2026-10-13

## Context

ADR 0004 chose one policy per owner address and named its own cost: an owner with two
agents needs two wallets, and the fix would need a redeploy. The fleet is the product's
real customer (a team running a research agent, a procurement agent and a trial agent off
one treasury), and nothing is on mainnet yet, so the redeploy costs one testnet policy.
After mainnet it would cost every customer a migration.

## Decision

**Every policy has an id. An owner may hold any number of them, one agent key each.**

- `createPolicy(agent, …)` returns a `policyId`. Owner functions take it as their first
  argument and check `owner == msg.sender`; ids are public, so that check is the whole of
  the access control (`NotPolicyOwner`).
- **Per-agent everything.** Each policy keeps its own budget, per-payment cap, rate limit,
  expiry, pause and payee allowlist. Considered and rejected: one owner-wide budget with
  per-agent sub-limits. It is fewer numbers, but one runaway agent can spend the budget the
  others need, and the contract gets harder to reason about.
- **Per-agent allowlists.** `isAllowedPayee(policyId, payee)`. A leaked research-bot key
  cannot pay procurement's suppliers. Considered and rejected: a shared owner-level list,
  which lets any compromised agent reach every supplier any agent was ever approved for.
- **The allowlist hangs off the policy, not the key**, so rotating a leaked key keeps the
  approved payees. Ids are never reused, so a revoked policy's allowlist is unreachable.
- **One owner-wide pause** (`setOwnerPaused`), on top of each policy's own. With a fleet, a
  kill switch that takes one transaction per agent is not a kill switch. Resuming the fleet
  does not lift an individual policy's pause.
- **The agent's call does not change.** `spend(payee, amount)` and `trySpend` still find the
  policy through a reverse index (`policyOf[agent]`), so agent code and the SDK's payment
  path are untouched. `ownerOf(agent)` remains as a view.
- `policiesOf(owner)` enumerates an owner's live policies (swap-and-pop on revoke), so a
  dashboard can list the fleet without an indexer.
- Every event carries the owner as an indexed topic and the policy id, so one owner's
  whole history is still a single log filter.

## Consequences

**Good**

- A fleet on one wallet, each agent on its own leash, with blast radius per key.
- The allowance remains the ceiling across all agents together: approve the sum of the
  budgets, never more. Tested (`test_multi_sharedAllowanceBindsAcrossAgents`).
- Invariants now run three owners with two agents each, with key rotation, the fleet
  switch, and owners trying to edit each other's policies (`invariant_noCrossOwnerEdits`).

**Bad**

- Breaking ABI change. Every owner function, `getPolicy`, `availableNow`, `remainingBudget`,
  `isAllowedPayee` and every event signature changed. The v1 testnet deployment keeps
  working for anyone pinned to it, but nothing in this repo reads it after the switch.
- Owners reason about ids. The dashboard and phone hide them behind agent names.
- `Reason.NOT_AGENT` stays unreachable, for the same reason as before: the index finds the
  policy from the caller, so `policy.agent == msg.sender` by construction, and
  `invariant_agentIndexMatchesPolicy` is what guarantees it.
