# Threat model

Plan §3.1: *"write it first, maintain it forever."* This is the first draft, written against
the shipped MVP. Every adversary below has a mitigation and, where the mitigation is code, a
test that exercises it.

**Scope.** The enforcement core (`enforcement/PolicyEngine.sol`), the agent that spends
through it, and the owner's control plane. Circle's and Arc's own infrastructure are
dependencies, not scope — but where trusting them is load-bearing, that is stated.

**Assets.** In order of what an attacker wants: the owner's USDC balance; the ability to
move it; the integrity of the audit log; the availability of the kill switch.

---

## 1. Compromised or prompt-injected agent

**The threat we exist for.** The agent's session key is stolen, or the model is talked into
serving an attacker. It has full, legitimate signing authority.

**Mitigation.** Policy is enforced in the contract, not the agent. Nothing the agent does —
including running arbitrary code — changes the caps, the allowlist, the velocity, or the
expiry. `agent/` deliberately contains **no** policy logic and hands the model an
unrestricted `pay_address(any, any)` tool, so the demo cannot be accused of working because
the tools were narrow.

**Residual risk.** The attacker can spend *within* policy — up to the per-transaction cap,
to an already-allowlisted payee, at the refill rate. Policy bounds loss; it does not
eliminate it. Choosing the caps is the owner's risk decision, and the product should make
that consequence legible rather than hide it.

**Tests.** `test_compromisedAgent_cannotEscapePolicy`, and the live run in
`docs/demo-script.md`.

---

## 2. Buggy or looping agent

**Threat.** A retry loop hammers a refused payment, or an agent misreads a refusal as
transient and retries forever.

**Mitigation.** Reason codes carry a `retry-later` / `needs-owner` distinction
(`shared/src/reasons.ts`), surfaced to the agent in words, so a correct agent backs off.
Independently, the token bucket bounds the damage a *wrong* agent can do — a loop drains
headroom and then simply fails. `checkTransfer` is free, so a refused attempt costs no gas.

**Residual risk.** A looping agent burns its own gas. That is its problem, not the owner's;
the agent's gas balance is deliberately separate from the owner's budget.

---

## 3. Malicious payee

**Threat.** An allowlisted supplier takes payment and delivers nothing.

**Mitigation today.** Weak, and we should say so. The strict allowlist means only payees the
owner explicitly approved can be paid at all, and the per-transaction cap bounds each
incident. That is containment, not prevention.

**Planned.** ERC-8183 escrow routing (ADR 0005) — payments above a threshold go through
escrow with a deliverable hash and a named evaluator. It shifts trust to the evaluator
rather than eliminating it, which is still a much better position than "payment settles,
service may not arrive."

---

## 4. Leaked owner key

**Threat.** The owner's key is stolen. The attacker can rewrite policy, allowlist
themselves, and drain to the allowance.

**Mitigation.** Weak today, and this is the MVP's sharpest edge. The owner is an EOA and the
dashboard signs owner actions server-side from `.env` — an arrangement Tollgate's own thesis
argues against.

**Planned.** Circle Modular Wallets: the owner authenticates with a passkey held in the
device secure enclave, never leaves the device, cannot be phished. `PolicyEngine` does not
care what kind of account the owner is, so this is a swap rather than a rewrite. Guardian
recovery after that.

**Note.** The blast radius is still bounded by the outstanding allowance, because we approve
exactly the budget rather than `type(uint256).max`. A leaked owner key on a vault design
would reach every deposited dollar.

---

## 5. A bug in `PolicyEngine`

**Threat.** Our own code is wrong, and enforcement fails open.

**Mitigation, in layers.**
1. **The allowance is a second ceiling.** Approving the exact budget means even total
   failure of our logic cannot exceed what the owner approved. A vault has no such backstop.
2. **We hold no funds.** There is no deposit and no withdraw; `invariant_engineNeverHoldsFunds`
   asserts a zero balance continuously. There is no honeypot to drain.
3. **The owner exits unilaterally.** `approve(engine, 0)` needs no cooperation from us.
4. 40 tests: every reason code, both sides of every cap, 1024-run fuzzing, and seven
   invariants over 32,768 calls.
5. Check-effects-interactions ordering with a transient-storage reentrancy guard.

**Residual risk.** Unaudited. No bug bounty. Testnet only, holding no real money — and
mainnet is gated on an external audit per plan §3.2.

**Known weakness in our own tests.** An early version of the invariant handler produced
*zero successful spends* across 32,768 calls while all invariants passed — green, and
proving nothing. `HandlerDebugTest.test_handlerReachesBothBranchesAtScale` now fails if
either the permitted or refused path is starved. Vacuous tests are a live risk in any
invariant suite and worth naming.

---

## 6. Upgrade abuse

**Threat.** A malicious or coerced upgrade changes enforcement under live policies.

**Mitigation.** `PolicyEngine` is **immutable**. No proxy, no admin, no owner role, no
upgrade path. Migration means deploying a new contract and owners choosing to move — which
they can, because their funds were never held here.

**Consequence, accepted.** Fixing a bug requires redeployment and voluntary migration. Plan
§3.2 prefers exactly this trade.

---

## 7. Operator and insider risk

**Threat.** Whoever runs the dashboard misuses their position.

**Mitigation.** Structurally limited: the backend holds no funds and cannot alter policy for
any owner but the one whose key it has. The audit log is on chain and cannot be edited by us.

**Live weakness.** The MVP dashboard holds the owner key. Anyone with server access has
owner authority. Testnet-only, documented in `lib/owner.ts`, and the passkey migration
removes it.

---

## 8. Reorgs and chain-level failures

**Threat.** A reorg unwinds a payment the audit log already showed.

**Mitigation.** Arc has sub-second deterministic finality, which makes this largely
theoretical. Structurally, the audit log is *derived* from chain rather than stored, so a
reorg self-heals on the next read — there is no mirror to drift. Entries are keyed by
`tx_hash + log_index` per §3.5, so replay cannot double-count.

---

## 9. RPC failure or censorship

**Threat.** The RPC lies, stalls, or drops transactions.

**Mitigation.** Fail-safe by construction: if reads fail the dashboard shows an error rather
than a stale allowance, and if writes fail nothing moves. **The safe default is no spend.**
Arc publishes four independent RPC endpoints; the kill switch can be called from any wallet
or block explorer, so it does not depend on ours.

**Residual risk.** A censoring RPC could delay the kill switch. Mitigated by there being
nothing special about our path to it.

---

## 10. Off-chain settlement outside our reach

**Threat.** Spending that never touches our contract.

**Reality.** Circle Gateway nanopayments settle off-chain: the buyer funds a Gateway balance
on chain once, then signs EIP-3009 authorisations that Circle batches. **`PolicyEngine`
cannot see individual nanopayments.**

**Mitigation.** Our enforcement point is the top-up into the Gateway balance — we budget the
pipe, not each drop. The token bucket is the right primitive for that.

**Stated plainly:** this is a boundary of the product, not a bug, and inside Circle's rails
their own policy engine is genuinely stronger than ours. See ADR 0005 and
`docs/circle-feedback.md`.

---

## 11. Decimal confusion

**Threat.** Arc's native USDC is 18 decimals; the ERC-20 interface is 6. Mixing them is a
10¹² error in software that moves money.

**Mitigation.** House rule: `PolicyEngine` never reads a native balance and every policy
amount is 6-decimal ERC-20 units. `shared/src/chain.ts` is the single definition, carrying
the warning, and every package imports from it. Helpers in `shared/src/amounts.ts` exist so
nobody reaches for `parseEther` out of habit.

**Not yet mitigated.** No test asserts the two are never mixed. A lint rule banning
`parseEther` and `formatEther` repo-wide would close it.

---

## Maintaining this

New adversary, new section. New mitigation, name the test. When a residual risk stops being
acceptable, it becomes a backlog item rather than a footnote.

The next three additions, in order: griefing bundlers and oracle manipulation (both become
live once we move to ERC-4337 validation), and multi-agent isolation (live once the registry
in ADR 0004 lands).
