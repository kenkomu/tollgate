# Tollgate

**An enforcement layer for autonomous agent spending.** Built on [Arc](https://docs.arc.io), Circle's stablecoin-native L1.

Agents now hold wallets and spend money. The industry's consensus barrier to agentic commerce is trust — and any guardrail that lives *inside* the agent can be talked out of it. A prompt-injected model, a looping retry, a leaked key: all of them route around an app-level check.

Tollgate puts the constraint somewhere the agent cannot reach: **in a contract, on-chain, on the money movement itself.**

---

## The claim, precisely

> An agent whose key has been **fully compromised** still cannot spend outside its policy.

That is the whole product. It is also the demo — we hand an attacker the agent's private key on camera and the contract refuses them anyway.

This is worth stating carefully, because Circle already ships spend controls for agent wallets (limits, allowlists, time bounds). Those are enforced **off-chain**, in Circle's policy engine, behind Circle's API. They are good controls. But they are only in the path when the caller goes through Circle. Tollgate's enforcement is in the contract: verifiable by anyone, portable across providers, and binding on a raw key with nobody in the loop.

The two are complementary. Ours is the one that survives the credential being stolen.

---

## Non-custodial, and not in the marketing sense

Tollgate never holds your money. There is no vault, no pool, no honeypot.

The owner keeps USDC in their own wallet and grants an **allowance** to the policy contract. The agent asks the contract to spend; the contract checks policy and, only if it passes, pulls the exact amount from the owner to the payee. Revocation is a standard ERC-20 `approve(0)` — the owner walks away without our cooperation, our permission, or our servers being up.

One deliberate consequence: **approve the exact budget, never `type(uint256).max`.** The allowance then acts as a hard ceiling that holds *even if our contract is wrong*. A vault has no such backstop; a bug there reaches every dollar deposited. Here a bug reaches, at most, the outstanding allowance.

```
   Owner (passkey wallet)                      Agent (session key)
        │                                            │
        │ approve(PolicyEngine, budget)              │ spend(payee, amount)
        │ createPolicy(caps, allowlist)              │
        ▼                                            ▼
   ┌──────────────────────────────────────────────────────┐
   │  PolicyEngine                                        │
   │    budget cap · per-tx cap · token-bucket velocity   │
   │    strict payee allowlist · expiry · pause           │
   └──────────────────────────┬───────────────────────────┘
                              │ passes → transferFrom(owner → payee)
                              │ fails  → revert PolicyViolation(code)
                              ▼
                       USDC on Arc
```

Funds move owner → payee. They never touch Tollgate.

---

## Layout

Every directory answers two questions: what is this, and what must never break here.

| Directory | What it is |
|---|---|
| **`enforcement/`** | **The trust core.** Solidity + Foundry. The only code here that is allowed to be wrong is none of it. |
| `shared/` | ABI, reason codes, chain config. The single source of truth every TypeScript package imports. |
| `dashboard/` | Next.js — the owner's control plane on the web. Policy setup, live spend feed, kill switch. |
| `agent/` | The demo agent (Claude Agent SDK). The thing being leashed. |
| `docs/` | Architecture, threat model, and the decision record behind every choice above. |
| `mobile/`, `service/` | **Empty.** Reserved for the phone control plane and the indexer. Neither is built — see `ROADMAP.md`. |

Start in `enforcement/` and `docs/decisions/`. Everything else is convenience and can be rebuilt from chain state.

---

## Running it

Contract dependencies are pinned git submodules, so clone recursively:

```sh
git clone --recursive https://github.com/kenkomu/tollgate
cd tollgate
pnpm install
```

Already cloned without `--recursive`? `git submodule update --init --recursive`.

```sh
pnpm contracts:test      # 47 tests: unit, fuzz, invariant. The part that matters.
pnpm agent               # the agent does its job inside a budget it did not set
pnpm agent:compromised   # the same agent, hostile instructions. It still cannot.
pnpm dashboard           # http://localhost:3000
```

Contracts need [Foundry](https://github.com/foundry-rs/foundry); everything else needs
Node ≥ 22.11. Copy `.env.example` to `.env` and fill it in — the agent needs
`ANTHROPIC_API_KEY` and a funded `AGENT_PRIVATE_KEY`; testnet USDC comes from
[faucet.circle.com](https://faucet.circle.com).

---

## Arc specifics worth knowing before you read the code

- **Chain ID `5042002`**, RPC `https://rpc.testnet.arc.io`, explorer [testnet.arcscan.app](https://testnet.arcscan.app). Testnet only — Arc mainnet is not live.
- **USDC is the native gas token** *and* exposes an ERC-20 interface at the predeploy `0x3600000000000000000000000000000000000000`. Same balance, two interfaces. That ERC-20 view is what makes the allowance design possible.
- **The decimals trap:** native USDC is 18 decimals for gas accounting, the ERC-20 interface is 6. Mixing them is a 10¹² error in a contract that moves money. House rule — `PolicyEngine` never reads a native balance, and every policy amount is 6-decimal ERC-20 units.
- **PUSH0 is supported.** Arc targets the Osaka hard fork and runs reth; Circle's own ERC-8183 reference contract executes PUSH0 on every call. Compile to `cancun`, not `paris` — we want transient storage for the reentrancy guard.

---

## Live on Arc testnet

| | |
|---|---|
| **PolicyEngine** | [`0x7Fa88da4FD0a86Af9c9567f0c317be6FBa1a376D`](https://testnet.arcscan.app/address/0x7Fa88da4FD0a86Af9c9567f0c317be6FBa1a376D) — verified source |
| USDC (ERC-20 view) | `0x3600000000000000000000000000000000000000` |
| Chain | Arc Testnet, id `5042002` |

Proven end to end on chain, not just in tests:

| | Result |
|---|---|
| Permitted payment, 2 USDC to an allowlisted payee | [`0xd7f7ae82…`](https://testnet.arcscan.app/tx/0xd7f7ae829546c8d87500e9bcad23f588d95435d8338be746ada41ad7dec8dfcc) ✅ |
| Second payment, drains the token bucket | [`0x7fedc3ef…`](https://testnet.arcscan.app/tx/0x7fedc3efe4f794f974fb4b39bebd4e34e8ee256084ab0503088861693dff44d8) ✅ |
| Third payment | reverted `PolicyViolation(9)` — EXCEEDS_VELOCITY |
| Agent pays an address the owner never approved | reverted `PolicyViolation(5)` — PAYEE_NOT_ALLOWED |
| Owner hits the kill switch, agent tries again | reverted `PolicyViolation(3)` — PAUSED |

Ledger afterwards: payee received exactly **4 USDC**, the contract recorded **4 USDC**
spent, the allowance fell from 10 to **6 USDC** — and `PolicyEngine`'s own USDC balance
is **0**, as it must be at every point in time.

## Status

Hackathon MVP. Testnet only, unaudited, and holding no real money by design.

The architecture is deliberately forward-compatible: `PolicyEngine`'s checks are written to become the body of an [ERC-6900](https://erc6900.io) module once Circle ships its session-key module, at which point the allowance wrapper falls away and the same audited logic validates userOps directly.
