# The stack, and why each piece is there

Every choice here has a reason that is specific to *this* product. Where a default would
have been fine, it says so.

---

## Chain

### Arc testnet (chain 5042002)

The hackathon is on Arc, but it also happens to be the right chain for this:

- **Gas is USDC.** An agent economy has to price things in dollars. An agent that needs a
  volatile gas token to buy a $0.05 API call has a currency problem before it has a
  spending problem.
- **Sub-second finality**, so a policy check does not stall the agent's loop.
- **Enterprise stablecoin infrastructure** — CCTP, Gateway, StableFX — all addressable
  from the same contract if we extend.

Mainnet is not live. Everything here is testnet, and the README says so.

**The trap:** USDC on Arc has two interfaces over one balance — native at 18 decimals for
gas, ERC-20 at 6 decimals for transfers. Mixing them is a 10¹² error in software that moves
money. House rule: every amount crossing a Tollgate boundary is 6-decimal ERC-20 units, and
nothing in the codebase reads a native balance except the agent's own gas check.

### Allowance-based, not custodial

The single most important architectural choice. The owner calls `approve`, keeps their
money, and the contract pulls owner → payee when policy permits.

Rejected alternatives:

- **A custody vault.** Would mean holding user funds — a much larger blast radius, and a
  much harder thing to ask anyone to trust in a weekend-old contract.
- **ERC-6900 / ERC-4337 modular account.** The architecturally cleanest answer, and blocked:
  Circle Modular Wallets session keys are unreleased and Paymaster is unsupported on Arc.
  See `circle-feedback.md`.

The allowance is also a **second ceiling**: approve exactly the budget, never `max`. If our
contract is wrong, the damage is bounded by the outstanding allowance rather than the whole
wallet.

---

## Contract

| Choice | Why |
|---|---|
| **Solidity 0.8.28** | Transient storage, for `ReentrancyGuardTransient` — a reentrancy guard that costs ~100 gas instead of ~5,000 |
| **`evm_version = "cancun"`** | Not assumed. Verified empirically by disassembling Circle's live ERC-8183 proxy on Arc and finding 10 `PUSH0` opcodes in the executed fallback. An earlier note claiming Arc needed `paris` was wrong. |
| **Foundry** | Fuzzing and invariant testing are native, not a plugin. For a contract whose whole value is "this limit always holds," invariants are the test that matters. |
| **OpenZeppelin v5.7.0** | `SafeERC20` and `ReentrancyGuardTransient`. Audited code for the two things you should never hand-roll. |
| **Pinned git submodules at repo root** | `forge init` created a nested git repo; promoting the libs to root-level pinned submodules keeps one repo and reproducible builds. |

**One `_evaluate`.** `checkTransfer` (the view the SDK pre-flights with) and `spend` (the
enforcement) both delegate to the same internal function. They cannot drift, because there
is only one implementation of policy. This is the design detail worth pointing at in a code
review.

---

## TypeScript everywhere

### Node 26 with native TypeScript

No build step for `shared/` or `agent/`. Node runs `.ts` directly.

The cost, which is real: Node's strip-only mode **rejects `enum`**. Our reason codes are a
`const` object plus a derived type instead, and `erasableSyntaxOnly: true` is set so the
compiler catches any future syntax Node cannot strip. Imports carry real `.ts` extensions
for the same reason.

### pnpm workspaces

Four packages, one lockfile. The point is `shared/`: the chain config, the contract ABI, the
reason codes and the USDC decimals have **exactly one definition** in the repo. The
dashboard and the agent import the same `Reason.PAYEE_NOT_ALLOWED` the contract emits.

An ABI copy-pasted into two places is how a dashboard starts lying about what a contract
did.

### viem, not ethers

Type inference from the ABI. `readContract` returns the actual struct shape rather than
`any`, which for a codebase full of `uint128` amounts held as `bigint` is the difference
between the compiler catching a decimals error and a user finding it.

---

## Agent

### `@anthropic-ai/claude-agent-sdk`

The same SDK Circle's own Agent Stack kit is built on. We do not use the kit itself:
its `.env.example` states *"The kit operates on Base mainnet only; there is no chain to
configure."* It cannot be pointed at Arc, and it moves real money. So we follow its patterns
with our own Arc wiring.

### Deliberately unrestricted tools

`pay_address` takes **any address and any amount**. This is the most important design
decision in the agent, and it is intentionally the opposite of best practice.

Constraining an agent by giving it narrow tools is an app-level guardrail — exactly the
thing this product exists to replace. If the demo only worked because the tools were
restrictive, it would prove nothing. The agent is handed the rawest possible capability and
stopped by the contract instead.

---

## Dashboard

### Next.js 16, App Router, React Server Components

Server components read the chain directly with viem. **There is no API layer** — no
`/api/activity` route, no client-side fetching, no serialisation boundary to keep in sync.
The page *is* the query.

Client components exist only where there is genuine interaction: the kill switch, the
approvals queue, the chart's hover layer, the live-refresh poller.

### No database

Deliberate, and argued at length in **ADR 0006**. Short version: the chain is the source of
truth, so the audit log is rebuilt from events on every request and cannot drift from what
happened.

### No chart library, no webfonts, no CDN

The chart is hand-written inline SVG. Fonts are a system stack. Icons are inline SVG paths.

The reasoning is the same in all three cases: **anything that has to load is something that
can fail to load**, in front of a judge, on conference wifi. It also keeps the page
CSP-clean and the bundle small enough that first paint is 0.44s.

The chart being hand-written has a second benefit — the step-after interpolation is a
correctness decision (spending is discrete; a curve would draw money moving when none did),
and a library default would have drawn the smooth line.

---

## What we deliberately did not build

| Not built | Why |
|---|---|
| `service/` Fastify workers | The dashboard reads chain directly. A worker tier with nothing to do is not architecture. |
| `mobile/` Expo app | Android toolchain gaps; poor use of four days. |
| An indexer | See ADR 0006 — arrives with volume, as a cache and never an authority. |
| ERC-8183 escrow routing | Documented stretch, ADR 0005. |
| Circle Wallets / Paymaster | Session keys unreleased, Paymaster unsupported on Arc. |

Full list in `BACKLOG.md`.
