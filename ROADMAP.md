# Roadmap

Every task the project needs, cross-referenced against
`tollgate-implementation-plan-v2.md`. Section numbers in parentheses point back to it.

This is the complete scope, not the hackathon scope — every surface the product needs to
exist as a business: contract, agent, SDK, web, Android, backend, infrastructure.
Hackathon-only items are in the submission checklist at the bottom.

**Status:** `[x]` done · `[~]` partial · `[ ]` not started · `[!]` blocked on someone else

Last reconciled against the source tree at commit `ee53870`. Where this file and the code
disagree, the code is right — say so and fix this file.

---

## Where the plan was wrong, and where we beat it

Three corrections worth recording before the list, because all three change what follows.

**The plan says pin `evmVersion: "paris"` (§3.2). That is wrong.** We verified empirically
by disassembling Circle's live ERC-8183 proxy on Arc and finding ten `PUSH0` opcodes in
the executed fallback. We build with `cancun`, which is what lets us use transient storage
for a ~100-gas reentrancy guard instead of ~5,000.

**The plan budgets a custody vault for Phase 0 (§9) and defers non-custody to Phase 2.**
We skipped the vault entirely and shipped the allowance model in Phase 0. The single
biggest architectural risk in the plan — "a contract bug drains user funds" (§11) — was
designed out at the start rather than refactored away later. Phase 2's "replace the custody
vault" line item does not exist for us.

**The plan schedules the Phase 2 correctness work months out.** Four of those items shipped
in Phase 0 instead: refusal visibility, the `setPayee(address(this))` fix, policy editing,
and agent-loop hardening. They are marked done below rather than deferred, because a
roadmap that claims credit for finished work is worth less than one that shows the real
remaining surface.

---

## Where the code actually stands

| Package | State | Tests |
|---|---|---|
| `enforcement/` | Deployed + verified at `0x8168eb562496A966f339a4bD165B924EeDce9873` (block 55,621,174) | 47 — 37 unit, 7 invariant, 3 coverage |
| `shared/` | Chain config, reason codes, amounts, ABI. Every TS package imports it | 0 |
| `agent/` | 7 tools, 5 failure classes, nonce queue, velocity back-off, unstick, gas health | 0 unit; `selftest.ts` is live-chain only |
| `dashboard/` | 4 pages, all 8 owner writes wired, refusals visible, no database | 0 |
| `service/`, `mobile/` | **Do not exist.** Empty scaffolds removed rather than left as decoration | — |

Nothing is deployed anywhere but a local machine and Arc testnet.

Totals: **47 Solidity tests, 97 TypeScript tests**, all gated by CI.

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
- [x] `trySpend` + `Refused` — refusals exist on chain, not just in a revert string
- [x] `setPayee` rejects `address(this)` — the unrecoverable-funds footgun

### Surfaces
- [x] Agent on the Claude Agent SDK, deliberately unrestricted tools (§2.3)
- [x] Compromised-agent scenario, real key, $0.00 moved
- [x] Web dashboard: overview, activity, payees, policy (§5.2)
- [x] Design system — charcoal, one accent, red reserved for blocked/kill (§5.4)
- [x] Plain-English audit log rebuilt from chain, no database (§2.4, ADR 0006)
- [x] Calibrated-trust approval queue (§5.1)
- [x] Refusals rendered with reason text and a proof link
- [x] Policy creation and editing from the UI — no Foundry script required
- [x] Empty and error states for an unconfigured deployment
- [x] Agent loop hardened: velocity back-off, stuck recovery, nonce serialisation, gas monitoring

### Discipline
- [x] Threat model written (§3.1)
- [x] ADRs 0001–0006
- [x] `docs/outcomes.md`, `docs/tech-stack.md`, `BACKLOG.md`
- [x] `docs/circle-feedback.md` — six findings on Circle's stack
- [x] Public repository
- [x] Gas floor applied to agent *and* owner writes; in-flight vs reverted distinguished
- [x] 30% gas buffer around Arc's estimator, with the measurement that justifies it

### Left in Phase 0
- [x] **CI.** GitHub Actions gates contracts, typecheck, lint, tests and a production build
- [x] **97 TypeScript tests** across `shared/`, `agent/` and `dashboard/`
- [x] `docs/architecture.md`
- [x] Removed the empty `service/` and `mobile/` scaffolds and their dead root scripts
- [x] `README.md` counts corrected
- [ ] `docs/demo-script.md` — the runbook the video is shot from
- [ ] 3-minute video
- [ ] Submission deck

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

- [x] **Refusal visibility.** `trySpend` returns a reason and emits `Refused`; the dashboard
      shows what was stopped, with a transaction link for each
- [x] `setPayee` rejects `address(this)`
- [ ] **Owner key out of `.env`.** Passkey/WebAuthn signing in the browser. Non-custodial
      in the contract, custodial in the app, is a contradiction that sinks a security
      pitch (§3.3). **The largest remaining honesty gap**
- [ ] **Deterministic attacker script.** The compromised demo depends on a model *choosing*
      to attack; the evidence is the contract refusals, not its commentary. A scripted
      adversary trying every evasion in a fixed order makes the guarantee reproducible
- [ ] Write the redeploy-and-migrate story. The contract is immutable, we have now
      redeployed once, and there is still no written migration path (§3.2 upgrade safety)

### The ERC-4337 / 6900 question
- [!] **Policy module on a modular smart account** (§2.2) — blocked: Circle Modular Wallets
      session keys are unreleased (ADR 0001, `circle-feedback.md`)
- [ ] **Decide whether this is still the destination.** The allowance model works with any
      EOA on any ERC-20 chain today, with no account-abstraction infrastructure. That is a
      wider surface than a plugin for one wallet vendor. Make it a decision, not a drift
- [ ] Registry / factory (§2.3)
- [ ] Scoped session keys with expiry and rotation (§3.3)
- [ ] Guardian / social recovery (§3.3)

### Contract capability
- [ ] Multiple agents per owner — one policy per owner today, and a real operator runs a
      fleet (ADR 0004)
- [ ] Per-payee sub-budgets; the allowlist is binary
- [ ] Category limits and time windows
- [ ] Batch spend / multicall — the fix for flat gas making sub-$0.05 payments uneconomic
      (`docs/outcomes.md` §7)
- [ ] On-chain payment references via Arc's memo contract, for reconciliation
- [ ] Guardian role: a second party who can pause but not spend
- [ ] Policy templates — "research agent", "procurement agent" as named presets

### The SDK is the real product (§5.3)
- [ ] Extract `TollgateClient` from `agent/` and publish `@tollgate/sdk`
- [ ] `checkTransfer`, policy management, event subscription as the public surface
- [ ] **MCP server** — highest-leverage adapter; makes Tollgate available to any
      MCP-speaking agent with no integration work
- [ ] LangChain and Vercel AI SDK adapters (§2.3)
- [ ] Documentation, examples, quickstart. The plan calls DX a core competency (§5.3)
- [ ] Versioned ABI package so integrators are not pinned to our repo layout

### Agent robustness
- [x] Automatic back-off and retry on `EXCEEDS_VELOCITY`, the only retryable reason
- [x] Stuck-transaction recovery: replace-by-fee at the same nonce
- [x] Nonce management for concurrent payments
- [x] Gas-balance monitoring, reported separately from the owner's budget
- [ ] Real marketplace integration instead of the local catalogue
- [ ] Persistent state across restarts — an agent restarted mid-payment currently forgets
      the in-flight hash it was told not to retry
- [ ] Structured spend logs the owner can diff against chain

---

## The web surface

Today this means one Next.js app on `localhost:3000`. A product needs more than that.

### Dashboard — hardening what exists
- [ ] **Deploy it.** Nothing is hosted. Vercel or equivalent, with the RPC and contract
      address as environment config, not `.env` on a laptop
- [ ] **Authentication.** There is none. The dashboard trusts whoever opens the port
- [ ] **Multi-owner / team accounts** with roles and multi-party approval (§5.2)
- [ ] **Notifications** — email or push when the agent escalates or is refused. Requires a
      durable cursor, which requires the database (ADR 0006)
- [ ] **CSV export and accounting integration** (§5.2)
- [ ] **History beyond the 400k-block horizon.** Needs the indexer
- [ ] Manage many agents from one view, once the contract supports more than one
- [ ] Per-agent cost attribution and exportable compliance reports (§2.3, §5.2)
- [ ] Accessibility audit beyond the contrast pass — keyboard traversal, screen reader,
      focus order on the editors
- [ ] Real-time updates over WebSocket instead of the current interval refresh

### Marketing and documentation web — does not exist at all
- [ ] **Landing site.** There is no public page explaining what this is to a non-reader of
      the repo
- [ ] **Documentation site** for the SDK — quickstart, API reference, examples (§5.3)
- [ ] **Public security page** and incident-response process (§7) — a trust signal, and the
      plan classes it as a product feature, not a chore
- [ ] Status page once anything is hosted
- [ ] The design system formalised and shared across app, dashboard and marketing (§5.4) —
      it currently lives as CSS custom properties in one `globals.css`

---

## The mobile surface — Android and iOS

`mobile/` is an empty directory. **Nothing exists.** Plan §5.1 makes this the *consumer*
control plane, and the case for it is specific: the kill switch and the approval queue are
both things an owner needs when they are away from a desk. A dashboard you have to be at
your laptop to use is not a kill switch.

### Decide first
- [x] **Expo/React Native vs native Kotlin** — ADR 0007: React Native via Expo, Android
      first, so reason codes and token-bucket maths come from `shared/` rather than being
      reimplemented in Kotlin where nothing guards the drift
- [!] **Scaffold the app** — blocked on sign-off before any install or scaffold is run
- [ ] Whether mobile is approve-and-kill only, or full policy editing (open in ADR 0007)

### Core screens (§5.1)
- [ ] Passkey onboarding — no seed phrase, ever
- [ ] Live spend feed, plain English, same `explainToOwner` strings as the web
- [ ] Budget and policy setup
- [ ] Calibrated-trust approvals — approve a payee from a push notification
- [ ] Progressive autonomy — widen the leash as the agent earns it
- [ ] **Prominent kill switch**, reachable in one tap from a cold start
- [ ] Multi-agent views, once the contract supports a fleet

### Android specifics that are their own work
- [ ] **Passkey signing via Credential Manager API.** Circle's
      `@circle-fin/modular-wallets-core` is web-first; Android needs either a WebAuthn
      bridge or a native path, and this is the same blocked dependency as the web passkey
      work (ADR 0001)
- [ ] **Key storage in Android Keystore** — hardware-backed, never in shared preferences
- [ ] **Biometric gate** on the kill switch and every policy write
- [ ] **FCM push notifications** for escalations and refusals — which requires the backend,
      device-token storage, and therefore the database
- [ ] **Deep links** from a notification straight to the approval it refers to
- [ ] **Offline and stale-data handling.** A phone that cannot reach the RPC must say so
      loudly. Showing a cached "all clear" when the chain is unreachable is the worst
      failure this app can have
- [ ] Background sync and a home-screen widget showing remaining budget
- [ ] Play Store release: signing keys, privacy policy, data-safety declaration, and the
      extra review that financial apps attract
- [ ] Low-end device and slow-network testing — the ICP is not all on flagship hardware
- [ ] iOS parity: Secure Enclave, APNs, App Store review

---

## Backend — `service/`, when it is actually needed

Empty today, and ADR 0006 argues that is correct for now. It stops being correct the moment
notifications, history beyond 400k blocks, or multi-tenant accounts are real requirements —
all three of which the mobile app needs on day one.

- [ ] Event-driven orchestrator and indexer (§2.3) — a cache in front of the chain, never
      an authority over it (ADR 0006)
- [ ] Postgres projections + Redis (§2.3)
- [ ] Reconciler that heals mirror-vs-chain drift (§3.5)
- [ ] Webhook ingestion, idempotent by notification id (§3.5)
- [ ] Realtime fan-out so any node serves any client (§4)
- [ ] Policy simulator — a fast off-chain mirror of `_evaluate` (§2.3)
- [ ] Queue-backed ingestion to absorb agent-swarm bursts (§4)
- [ ] Per-tenant partitioning (§4)
- [ ] Device-token registry and notification dispatch for mobile
- [ ] **Prove the rebuild claim.** The whole design rests on "the off-chain layer can be
      rebuilt from chain if lost." That must be a tested drill, not an assertion (§4)

---

## Testing

- [x] **Unit tests for `shared/`** — 54, including a check that reads the Solidity enum and
      fails if the TypeScript reason table drifts from it
- [x] **Unit tests for the agent** — 23, driven against a stub node through an injectable
      transport, covering the paths a live chain will not produce on demand
- [x] **Dashboard tests** — 20, over the log-window planner and the audit projection
- [x] **Differential test against an independent token-bucket implementation** — 20,000
      pseudo-random states, fixed seed
- [ ] End-to-end test of the agent loop against a local fork
- [ ] Fork tests against real Arc state rather than a local EVM
- [ ] Chaos drills: kill the indexer, drop the backend, replay a reorg (§4)
- [ ] Load-test the RPC assumptions — the 20,000-block `eth_getLogs` limit was found by
      probing, is undocumented, and could change under us
- [ ] Component tests for the dashboard's React tree — the projection is covered, the
      rendering is not

---

## Phase 3 — Harden and audit

*Gate: clean audit, SLOs met in a staging soak, DR restore tested.*

- [ ] **External audit** (§3.2) — hard gate before mainnet
- [ ] Bug bounty, Immunefi-style (§3.2)
- [ ] Formal specs for the critical invariants — Certora or Halmos on `spent ≤ budgetCap` (§3.2)
- [ ] MPC/HSM for any operator-held keys, least privilege, rotation (§3.3)
- [ ] **Solve the x402 atomicity gap** (§3.4) — payment can settle without service
      delivery, which is unacceptable for a trust product. In priority order:
  - [ ] Delivery-conditioned release or escrow where the protocol allows (ADR 0005)
  - [ ] Reconcile every nanopayment against Gateway settlement, flag disputes
  - [ ] Bound exposure with per-call caps and payee reputation
  - [ ] Contribute upstream toward atomicity in the x402/MPP spec
- [ ] Horizontal stateless services behind a load balancer (§4)
- [ ] Multi-region and disaster recovery; documented RPO/RTO; **tested restore** (§4)
- [ ] Observability: structured logs, metrics, tracing, per-agent cost attribution (§4)
- [ ] SLOs — pre-check p99, settlement lag, block/allow correctness — and alerts (§4)
- [ ] Circuit breakers, load shedding, retries with backoff (§2.1, §4)
- [ ] Monitoring on the contract itself — spend spikes, pauses, an approaching ceiling
- [ ] CI running the full test pyramid as a merge gate (§8)

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
- [!] Paymaster / gas sponsorship — unsupported on Arc (`circle-feedback.md` §2)
- [ ] Engage Build-on-Circle and Arc House; pursue Builders Fund (§6)
- [ ] Decide what stays proprietary: managed service, dashboard, compliance (§6)
- [ ] Send `circle-feedback.md` to Circle — six findings, including a reproducible gas
      estimator defect, currently sitting in our repo helping nobody

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
- [ ] `docs/architecture.md`
- [ ] 3-minute video
- [ ] Deck

---

## The honesty gaps

Repeated from `BACKLOG.md` because they matter more than any feature above. These are
places where the claim is currently stronger than the evidence. Two of the original four
are now closed.

1. ~~**The dashboard cannot show a refusal.**~~ **Closed.** `trySpend` emits `Refused`, and
   the dashboard renders refusals with a reason and a transaction link.
2. **The attack demo depends on a model's choices.** Two contract refusals are evidence;
   the model's reasoning is not. Open.
3. **The owner key lives in a `.env` file.** Open, and now the largest one.
4. **The invariant suite once passed vacuously** — zero successful spends across 32,768
   calls, all eight invariants green. Fixed and locked in with a deterministic coverage
   test, but a standing reminder that green is not proof.

A fifth, added since: **nothing outside the contract is tested at all.** 47 Solidity tests
and zero TypeScript tests, guarding money-moving code in three packages.
