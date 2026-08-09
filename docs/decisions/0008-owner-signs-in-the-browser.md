# ADR 0008 — The owner signs in their own browser

**Status:** accepted
**Date:** 2026-08-09

## The question

Owner actions — including the kill switch — were signed on the server from
`DEPLOYER_PRIVATE_KEY` in `.env`. How do we get that key out of the server?

## Why it mattered more than any feature

This was the largest gap between what Tollgate claimed and what Tollgate did.

The pitch is *"you should not have to trust an operator."* The implementation was an operator
holding the owner's private key, able to pause the agent, rewrite every limit, rotate the
agent key, and revoke the policy. The contract was genuinely non-custodial; the application
wrapped around it was not. A reviewer who read `lib/owner.ts` would have found the one place
where the product contradicted its own argument, and they would have been right to.

It was also the answer to a question the demo invites: *"what if your server is compromised?"*
Previously: everything an owner could do, an attacker could do. Now: nothing.

## Decision

**Owner actions are signed in the owner's browser by an injected EIP-1193 wallet.** The server
holds no key and can no longer authorise anything.

## Why this rather than passkeys

Task 20 originally said "passkey". Passkeys are the better *end state* and they are not what
this problem needed.

The goal was to remove a private key from a server. A browser wallet does that completely and
immediately, with **no new dependencies** — the injected provider is a browser API and viem
was already in the tree. Circle Modular Wallets, the passkey route, requires Console setup, a
registered passkey domain, and an SDK whose Arc support is unverified. Given that Circle's
Agent Stack kit turned out to be Base-mainnet-only and Session Keys are still unreleased
(ADR 0001), betting the fix for the biggest honesty gap on another unverified Circle
integration would have been a poor trade.

Passkeys remain the right destination for *onboarding* — "no seed phrase" is a real product
advantage, and ADR 0007 wants the same path on Android. That is a UX layer to add on top of
this, not a reason to leave a key on a server in the meantime.

WalletConnect was considered and rejected for now: a sizeable dependency tree and a project ID
to obtain, for reach we do not yet need on a desktop dashboard.

## What changed

- `lib/owner.ts` keeps its exact function signatures and moves to the client. The components
  calling it did not have to know where a signature comes from.
- `lib/wallet.ts` is new: connection, Arc network detection, and `wallet_addEthereumChain`
  when the wallet has never seen Arc — which, for a chain this new, is the common path.
- The one server action left is clearing an approval request from a JSON file. It carries no
  authority: the allowlist is on chain, and dismissing a request grants nothing.
- `WalletBar` shows the signing address on every page, and warns when the connected account is
  not the policy owner. `PolicyEngine` keys everything on `msg.sender`, so a write from the
  wrong account fails rather than editing the wrong policy — saying which account is connected
  turns a confusing revert into an instruction.
- Transactions are simulated before the wallet prompt is raised, so the owner is never asked
  to approve something that will revert. Asking people to sign failing transactions teaches
  them to sign without reading.

## What it costs

- **A wallet extension is now required to change anything.** Reading needs nothing.
- **Arc must be added to the wallet.** We offer it rather than instructing it.
- **Two prompts to create a policy** — `approve` then `createPolicy`. They were always two
  transactions; now the owner sees both, which is arguably more honest than one click.

## What it does not change

The contract. `PolicyEngine` never knew or cared how the owner's transaction was signed — the
owner is just an address that granted an allowance. This was a swap, not a rewrite, which is
itself an argument for the allowance design in ADR 0001.

## References

- Plan §3.3 — non-custodial key posture
- ADR 0001 — the allowance model that made this a swap
- ADR 0007 — the mobile app, which wants the passkey layer on top of this
- `docs/threat-model.md` — the operator-compromise row this closes
