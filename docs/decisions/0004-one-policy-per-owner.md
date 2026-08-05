# 0004 — One policy per owner

**Status:** accepted · **Date:** 2026-08-05

## Context

Either key policies by an id (an owner may run many agents, each with its own leash), or
keep a single policy per owner address.

## Decision

**One policy per owner.** `mapping(address owner => Policy)`, plus a reverse index
`mapping(address agent => address owner)` so an agent can call `spend(payee, amount)`
without naming its owner.

## Consequences

**Good**

- Smallest storage layout and the least surface to get wrong before Sunday.
- The reverse index makes the agent-facing call a two-argument function, which matters
  because the SDK is meant to be the product and its ergonomics are the pitch.
- `AgentAlreadyBound` prevents one session key serving two owners, which keeps the index
  and the policy in agreement. That agreement is asserted continuously by
  `invariant_agentIndexMatchesPolicy`.

**Bad**

- Multi-agent organisations — the web dashboard's whole reason for existing — need a
  registry. Retrofitting one means a storage migration, and since we prefer immutable
  contracts over proxies, that means a redeploy and a migration path for live policies.
- An owner wanting two agents today needs two owner addresses.

## Note on an unreachable branch

`Reason.NOT_AGENT` is currently unreachable: `spend` finds the policy *through* the
reverse index, so `policy.agent` always equals the caller by construction. It is kept as
a defensive check, and the invariant above is what actually guarantees the property it is
defending. If the registry in a later version ever lets a caller name a policy directly,
this branch becomes live and must be tested for real.
