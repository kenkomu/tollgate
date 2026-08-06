# Feedback on Circle's developer tools

The hackathon asks entrants to explain why specific Circle tools were chosen, how they
shaped the architecture, and to be explicit about what worked and what didn't. This is
that, written honestly. Every claim here is something we hit while building, not something
we read.

---

## 1. Modular Wallets: the module we needed is not released, and that changed our architecture

**What we planned.** Our intended design was an ERC-6900 policy module installed on a
Circle Modular Wallet, enforcing spend policy in the account's validation hook. That is the
right architecture — enforcement at the signing layer governs *any* userOp, not just token
transfers — and Circle co-authored ERC-6900, so it seemed like the natural home.

**What we found.** Modular Wallets ship exactly one module beyond the built-in passkey
signer: **Address Book**. The **Session Keys** module — which is what carries scoped agent
authority and spending limits — is listed on the Modules Beta page as *"Coming soon"* with
availability marked *limited*. The docs say developers "can also build custom modules
against the ERC-6900 standard" but publish no deployment path, no `installModule` surface
in the SDK reference, and no example.

**What it cost us.** We could not build the architecture we wanted. Since the fallback in
our original plan was a custody vault — which would have made us custodial while pitching
non-custodial — we designed a third path instead: enforcement on an ERC-20 **allowance**,
where the owner keeps custody and grants a revocable, exactly-sized approval. It turned out
to have a property the module design lacks: the allowance is a second ceiling that holds
*even if our contract is wrong*.

**What would help.** A documented path for deploying a custom ERC-6900 module to a Modular
Wallet, even in beta and even with an allowlist, would unblock a class of projects. A date
for Session Keys would let teams plan around it. Right now the gap between "ERC-6900
compliant" and "you can install your own module" is not obvious until you are days in.

---

## 2. Circle Paymaster does not support Arc — and on Arc it isn't needed

Our stack plan had Paymaster in it for USDC gas. It is unsupported on Arc: the docs list
Arbitrum and Base for EntryPoint v0.7, and Arbitrum, Avalanche, Base, Ethereum, Optimism,
Polygon and Unichain for v0.8. Arc is on neither list.

It is also **redundant on Arc**, because USDC is already the native gas token. The product
that fills the gap for gasless UX on Arc is **Gas Station**, reached through Modular Wallets
with `paymaster: true` — a different product with a similar-sounding name.

**What would help.** A line on the Paymaster page saying "not required on Arc; use Gas
Station" would have saved us an afternoon. The naming collision between Paymaster (pay gas
in USDC) and Gas Station (developer sponsors gas) is a genuine trap on a chain where gas
*is* USDC.

---

## 3. The Agent Stack starter kit is Base-mainnet-only, so it cannot be used on Arc

We planned to build our agent on the Claude Agent SDK kit from
`circlefin/agent-stack-starter-kits`. Its own `.env.example` says:

> *"The kit operates on Base mainnet only; there is no chain to configure."*

So a hackathon whose entire premise is building on Arc has an Agent Stack starter kit that
cannot target Arc, and that transacts real money rather than testnet funds.

**What we did instead.** Built directly on `@anthropic-ai/claude-agent-sdk` — the same SDK
the kit uses — with our own Arc wiring through viem, and a local service catalogue standing
in for the Agent Marketplace. We followed the kit's patterns without inheriting its chain.

**What would help.** An Arc-testnet mode for the kits, even a reduced one. As it stands, the
track that most rewards Agent Stack usage is the one where the starter kits do not run.

---

## 4. Gateway nanopayments settle off-chain, which on-chain policy cannot see

This is not a defect, but it is a structural fact worth stating because it bounds what any
on-chain control can promise.

Gateway nanopayments work by funding a Gateway balance with one on-chain deposit, then
signing off-chain EIP-3009 authorisations that Circle batches and settles in bulk. The
per-call payments never touch a contract.

So a contract-based policy engine **cannot intercept individual nanopayments.** Our
enforcement point for a nanopayment stream is the *top-up into the Gateway balance* — we
budget the pipe, not each drop.

Worth being fair about the consequence: this is a place where **Circle's own off-chain spend
controls are genuinely stronger than ours**, because the payments are on Circle's rails and
Circle's policy engine is in the path. Ours hold on any on-chain movement regardless of
provider. The two are complementary, and we would rather say so than overclaim.

**What would help.** Documenting the enforcement boundary explicitly — "controls apply at
deposit, not per authorisation" — would let builders reason about it without discovering it
by reading the settlement flow.

---

## 5. The "Arc rejects PUSH0, compile to paris" advice is obsolete

Widely repeated, including in stack guidance we were given. It is wrong.

Arc targets the **Osaka** hard fork as its baseline and runs `reth/v1.11.3`. We verified
empirically before writing a line of Solidity: Circle's own ERC-8183 reference contract at
`0x0747EEf0706327138c69792bF28Cd525089e4583` is an ERC-1967 proxy whose fallback path
executes **ten PUSH0 opcodes on every call**. If Arc rejected PUSH0 that contract would be
permanently bricked.

Our own deployed `PolicyEngine` contains PUSH0 and works.

Pinning `paris` is safe but costly: you forfeit PUSH0 gas savings and, more importantly,
**transient storage** (`TSTORE`/`TLOAD`) — which is the modern idiom for reentrancy guards,
and exactly what a policy contract wants. We compile to `cancun`.

**What would help.** A sentence in the Arc EVM-differences page stating the supported EVM
version explicitly, in the terms Solidity users configure (`evm_version`), rather than by
hard-fork name only.

---

## 6. `eth_estimateGas` leaves under 1% of headroom on a USDC transfer

**Impact:** payments fail intermittently, with no readable reason.

Measured on Arc testnet, on a contract that pulls USDC via `transferFrom`:

| | |
|---|---|
| `eth_estimateGas` returned | **97,846** |
| Execution actually needed | **96,931** |
| Headroom | **0.9%** |

That gap is closed by any small state difference between estimating and executing — a
storage slot that was cold at estimate time and warm at execution, or the reverse. We hit
it with three concurrent payments: two settled, the third reverted having consumed 96,931
of its 97,846 limit. Re-sent by hand with a 200,000 limit, the identical call succeeded
using 96,879.

Tracing the failure showed it dying inside USDC's own `transferFrom`, at a
`isBlocklisted()` staticcall to the precompile at `0x1800…0001`. We suspect the estimator
does not fully account for that path, though we could not confirm it — Foundry's local EVM
does not implement the precompile, so a replay cannot reproduce the on-chain behaviour.

**Why this is worse than a normal out-of-gas.** Our contract emits `Spent` *before* calling
`transferFrom`. When the transfer runs out of gas the whole transaction reverts, the event
is discarded, and what the operator sees is a payment that vanished with a bare "reverted"
and no reason code. It looks like a contract bug and is not one.

**What we did:** buffer every estimate by 30% (`GAS_BUFFER_PERCENT` in `shared/src/chain.ts`).
Unused gas is refunded, so over-buffering costs nothing and under-buffering costs a payment.

**Suggestion:** either widen the estimator's margin on transfers that touch the
blocklist precompile, or document that clients must add their own buffer on Arc. Most
wallet libraries — viem included — use the returned estimate verbatim, so the default
behaviour of the obvious code is a payment that fails roughly whenever the state moves.

---

## What worked well

- **USDC as native gas is genuinely clarifying.** One asset for fees and value removes an
  entire class of demo failure. No separate gas token to source, no "fund the agent with
  ETH first" step.
- **The dual USDC interface is the right design.** Native for gas, ERC-20 at
  `0x3600…0000` for `approve`/`transferFrom` over the same balance. Our whole
  non-custodial architecture depends on that ERC-20 view existing.
- **`llms.txt` on both docs sites is excellent** and materially sped up our research. More
  vendors should do this.
- **Arc's deploy path is unremarkable in the best way.** Foundry, standard RPC, Blockscout
  verification. It behaved like an EVM chain, which is what you want when the interesting
  part of your project is elsewhere.
- **ERC-8004 and ERC-8183 being native to Arc is underrated.** ERC-8183's escrow with a
  deliverable and a named evaluator is a real answer to the x402 pay-without-delivery gap,
  and we found it in the Arc docs rather than in any agent-payments discussion. It deserves
  more prominence.

## The one documentation trap that could cost someone real money

Native USDC on Arc is **18 decimals** for gas accounting; the ERC-20 interface is **6**.
Both are documented, in different places. Mixing them is a 10¹² error in software that moves
money.

We made it a house rule — `PolicyEngine` never reads a native balance, every policy amount
is 6-decimal — and put the warning in the one file every package imports. A prominent,
repeated warning wherever balances are discussed would be worth more than its length.
