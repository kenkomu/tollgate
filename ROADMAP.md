# Roadmap

Every task the project needs, cross-referenced against
`tollgate-implementation-plan-v2.md`. Section numbers in parentheses point back to it.

This is the complete scope, not the hackathon scope. Hackathon-only items are in the
submission checklist at the bottom.

**Status:** `[x]` done · `[~]` partial · `[ ]` not started · `[!]` blocked on someone else

---

## Where the plan was wrong, and where we beat it

Two corrections worth recording before the list, because both change what follows.

**The plan says pin `evmVersion: "paris"` (§3.2). That is wrong.** We verified empirically
by disassembling Circle's live ERC-8183 proxy on Arc and finding ten `PUSH0` opcodes in
the executed fallback. We build with `cancun`, which is what lets us use transient storage
for a ~100-gas reentrancy guard instead of ~5,000.

**The plan budgets a custody vault for Phase 0 (§9) and defers non-custody to Phase 2.**
We skipped the vault entirely and shipped the allowance model in Phase 0. The single
biggest architectural risk in the plan — "a contract bug drains user funds" (§11) — was
designed out at the start rather than refactored away later. Phase 2's "replace the custody
vault" line item does not exist for us.

---

## Phase 0 — Probe *(current)*

*Gate: is the problem sharp for a real ICP, and does on-chain enforcement resonate?*

### Enforcement core
- [x] `PolicyEngine` deployed and verified on Arc testnet
- [x] Non-custodial allowance model, no deposit and no withdraw (§2.1, ADR 0001)
- [x] Five rules: budget, per-payment, allowlist, velocity, expiry
- [x] Token-bucket velocity rather than a tumbling window (ADR 0002)
- [x] Twelve reason codes, one `_evaluate` shared by pre-check and enforcement (§3.2)
- [x] Kill switch as a direct owner→chain write, never gated by backend health (§3.5)
- [x] Unit tests for every reason code and boundary (§3.2)
- [x] Invariant suite — `spent ≤ budgetCap`, `paused ⇒ no spend` (§3.2)
- [x] Fuzzing (§3.2)
- [x] Idempotency by `tx_hash + log_index` (§3.5)
- [x] Reproducible builds, verified source on ArcScan (§3.2)

### Surfaces
- [x] Agent on the Claude Agent SDK, deliberately unrestricted tools (§2.3)
- [x] Compromised-agent scenario, real key, $0.00 moved
- [x] Web dashboard: overview, activity, payees, policy (§5.2)
- [x] Design system — charcoal, one accent, red reserved for blocked/kill (§5.4)
- [x] Plain-English audit log rebuilt from chain, no database (§2.4, ADR 0006)
- [x] Calibrated-trust approval queue (§5.1)

### Discipline
- [x] Threat model written (§3.1)
- [x] ADRs 0001–0006
- [x] `docs/outcomes.md`, `docs/tech-stack.md`, `BACKLOG.md`
- [x] `docs/circle-feedback.md` — four findings on Circle's stack
- [x] Public repository
- [x] Gas floor applied; in-flight vs reverted payments distinguished

### Left in Phase 0
- [ ] `docs/demo-script.md` — the runbook the video is shot from
- [ ] `docs/architecture.md`
- [ ] 3-minute video
- [ ] Submission deck
- [ ] Delete or fill the empty `service/` and `mobile/` scaffolds — 0 source files each
- [ ] Fix duplicated `POLICY_ENGINE_ADDRESS` in `.env`

---

## Phase 1 — Sharpen the wedge

*Gate: a credible wedge with a couple of committed design partners.*

Almost none of this is engineering, and the plan is explicit that it decides everything
downstream (§1.3, §1.4, §10).

- [ ] Run 5–10 discovery interviews with people who would deploy budgeted agents (§1.4, §12.2)
- [ ] Confirm or replace the ICP hypothesis (§1.5)
- [ ] **Decide the wedge: neutral primitive vs. attribution vs. compliance** (§1.3)
- [ ] Sign 2–5 design partners (§9 gate)
- [ ] Prototype the SDK surface others would integrate against (§5.3, §12.4)
- [ ] Sharpen the differentiator against Circle Agent Wallets — theirs is off-chain and
      API-gated, ours is in-contract. This is a positioning task and it is worth more than
      most engineering below (§11 commoditization row)
- [ ] Set up the metrics in §10: block/allow ratio, agents under management, policy writes
- [ ] Write the kill/pivot triggers down and agree to honour them (§10)

---

## Phase 2 — Re-architect for correctness

*Gate: passes invariant/fuzz; a design partner runs a real workload on testnet.*

### Close the gaps where the claim outruns the evidence

These come first. They are what a serious reviewer attacks.

- [ ] **Refusal visibility.** A reverted spend emits no event, so the dashboard can prove
      what was allowed and cannot show what was stopped — the product's central claim.
      Needs a non-reverting `trySpend` returning a reason code and emitting `Refused`.
      Contract change, plus a migration path (ADR 0006, BACKLOG honesty gaps)
- [ ] **Owner key out of `.env`.** Passkey/WebAuthn signing in the browser. Non-custodial
      in the contract, custodial in the app, is a contradiction that sinks a security
      pitch (§3.3)
- [ ] **Deterministic attacker script.** The compromised demo currently depends on a model
      *choosing* to attack; the evidence is the two contract refusals, not its commentary
- [ ] `setPayee` must reject `address(this)` — funds sent to the engine are unrecoverable
      (`docs/outcomes.md` §5.3)
- [ ] Write the redeploy-and-migrate story. The contract is immutable and there is no
      migration path (§3.2 upgrade safety)

### The ERC-4337 / 6900 question
- [!] **Policy module on a modular smart account** (§2.2) — blocked: Circle Modular Wallets
      session keys are unreleased (ADR 0001, `circle-feedback.md`)
- [ ] **Decide whether this is still the destination.** The allowance model works with any
      EOA on any ERC-20 chain today, with no account-abstraction infrastructure. That is a
      wider surface than a plugin for one wallet vendor. Make it a decision, not a drift
- [ ] Registry / factory (§2.3)
- [ ] Scoped session keys with expiry and rotation (§3.3)
- [ ] Guardian / social recovery (§3.3)

### Capability
- [ ] Multiple agents per owner — one policy per owner today, and a real operator runs a
      fleet (ADR 0004)
- [ ] Per-payee sub-budgets; the allowlist is binary
- [ ] Category limits and time windows
- [ ] Batch spend / multicall — the fix for flat $0.002 gas making sub-$0.05 payments
      uneconomic (`docs/outcomes.md` §7)
- [ ] On-chain payment references via Arc's memo contract, for reconciliation
- [ ] Guardian role: a second party who can pause but not spend
- [ ] Policy templates
- [ ] Create and edit policies from the UI — onboarding is currently "run a forge script",
      and only pause and payee approval are writable

### The SDK is the real product (§5.3)
- [ ] Extract `TollgateClient` from the demo app and publish `@tollgate/sdk`
- [ ] `checkTransfer`, policy management, event subscription as the public surface
- [ ] **MCP server** — highest-leverage adapter; makes Tollgate available to any
      MCP-speaking agent with no integration work
- [ ] LangChain and Vercel AI SDK adapters (§2.3)
- [ ] Documentation, examples, quickstart. The plan calls DX a core competency (§5.3)

### Backend, when it is actually needed
- [ ] Event-driven orchestrator and indexer (§2.3) — as a cache in front of the chain,
      never an authority over it (ADR 0006)
- [ ] Postgres projections + Redis (§2.3)
- [ ] Reconciler that heals mirror-vs-chain drift (§3.5)
- [ ] Webhook ingestion, idempotent by notification id (§3.5)
- [ ] Realtime fan-out
- [ ] Policy simulator — a fast off-chain mirror of `_evaluate` (§2.3)

### Agent robustness
- [ ] Automatic back-off and retry on `EXCEEDS_VELOCITY`, the only retryable reason
- [ ] Stuck-transaction recovery: replace-by-fee at the same nonce (`docs/outcomes.md` §2.4)
- [ ] Nonce management for concurrent payments
- [ ] Gas-balance monitoring — the agent pays its own gas from a second pot the dashboard
      does not show
- [ ] Real marketplace integration instead of the local catalogue

### Testing
- [ ] End-to-end test of the agent loop — 40 contract tests, zero agent tests
- [ ] Dashboard tests — none exist
- [ ] Fork tests against real Arc state
- [ ] Differential test against an independent token-bucket implementation
- [ ] Chaos drills: kill the indexer, drop the backend, replay a reorg (§4)

---

## Phase 3 — Harden and audit

*Gate: clean audit, SLOs met in a staging soak, DR restore tested.*

- [ ] **External audit** (§3.2) — hard gate before mainnet
- [ ] Bug bounty, Immunefi-style (§3.2)
- [ ] Formal specs for the critical invariants (§3.2)
- [ ] MPC/HSM for any operator-held keys, least privilege, rotation (§3.3)
- [ ] **Solve the x402 atomicity gap** (§3.4) — payment can settle without service
      delivery, which is unacceptable for a trust product. In priority order:
  - [ ] Delivery-conditioned release or escrow where the protocol allows (ADR 0005)
  - [ ] Reconcile every nanopayment against Gateway settlement, flag disputes
  - [ ] Bound exposure with per-call caps and payee reputation
  - [ ] Contribute upstream toward atomicity in the x402/MPP spec
- [ ] Horizontal stateless services behind a load balancer (§4)
- [ ] Queue-backed ingestion to absorb agent-swarm bursts (§4)
- [ ] Per-tenant partitioning (§4)
- [ ] Multi-region and disaster recovery; documented RPO/RTO; **tested restore** (§4)
- [ ] Observability: structured logs, metrics, tracing, per-agent cost attribution (§4)
- [ ] SLOs — pre-check p99, settlement lag, block/allow correctness — and alerts (§4)
- [ ] Circuit breakers, load shedding, retries with backoff (§2.1, §4)
- [ ] CI running the full test pyramid as a merge gate (§8) — nothing gates a push today
- [ ] Deploy the dashboard; it runs on localhost only

---

## Phase 4 — Mainnet and first real money

- [!] **Arc mainnet is not live.** Everything is testnet until it is (§11)
- [ ] Cautious rollout with low limits, monitored closely (§9)
- [ ] Onboard first paying or design-partner customers
- [ ] Public security page and incident-response process (§7)
- [ ] Published docs

---

## Phase 5 — Scale, standardize, open

- [ ] Multi-agent org features: roles, multi-party approval, org-wide policy (§5.2)
- [ ] Attribution service and exportable audit/compliance reports (§2.3, §5.2)
- [ ] Warehouse for analytics and attribution (§4)
- [ ] Mobile app — passkey onboarding, notifications, multi-agent views (§5.1)
- [ ] Multi-chain via CCTP v2 (§9)
- [ ] Open-source the SDK and contract interfaces (§6)
- [ ] Progressive decentralisation of the primitive (§9)

---

## Standards and ecosystem *(runs continuously, §6)*

- [ ] **AP2 (FIDO)** — map policy to Intent/Cart/Payment mandates, versioned as the spec moves
- [ ] **Circle MPP** — conform to the USDC-charge machine-payments profile
- [ ] **ERC-8226** — track drafts; adopt reason-code and revocation interface shapes
- [ ] **ERC-8183 escrow routing** (ADR 0005)
- [ ] Gateway nanopayment enforcement — per-call x402 settles off-chain, beyond contract
      reach; our enforcement point is the top-up (ADR 0005)
- [!] Paymaster / gas sponsorship — unsupported on Arc (`circle-feedback.md`)
- [ ] Engage Build-on-Circle and Arc House; pursue Builders Fund (§6)
- [ ] Decide what stays proprietary: managed service, dashboard, compliance (§6)

---

## Compliance, legal, trust *(§7 — entirely untouched)*

- [ ] Regulatory analysis; real legal advice on custody, agent liability, cross-border
- [ ] Liability model: who is accountable when an agent misspends *within* policy vs
      outside it
- [ ] Data and privacy: minimise PII, retention policy, treat the audit log as financial data
- [ ] Trust signals as product: audits, verified contracts, transparent incident response

---

## Team and process *(§8)*

- [ ] Hire for smart-contract/security depth, backend/infra, mobile + DX, design
- [ ] Someone owning discovery and GTM, early
- [ ] Spec-and-threat-model before code on anything touching money
- [ ] Changelog discipline against Circle's fast-moving SDKs
- [ ] Roadmap reviewed at each phase gate, not fixed a year out

---

## Hackathon submission checklist

Everything else on this page is post-submission.

- [x] Registration
- [x] Working contract, agent, dashboard, public repo
- [x] `docs/circle-feedback.md`
- [ ] `docs/demo-script.md`
- [ ] 3-minute video
- [ ] Deck
- [ ] `docs/architecture.md`

---

## The four honesty gaps

Repeated from `BACKLOG.md` because they matter more than any feature above. These are
places where the claim is currently stronger than the evidence.

1. **The dashboard cannot show a refusal.** The central claim is "it stops things," and the
   UI can only display what got through.
2. **The attack demo depends on a model's choices.** Two contract refusals are evidence;
   the model's reasoning is not.
3. **The owner key lives in a `.env` file.**
4. **The invariant suite once passed vacuously** — zero successful spends across 32,768
   calls, all eight invariants green. Fixed and locked in with a deterministic coverage
   test, but a standing reminder that green is not proof.
