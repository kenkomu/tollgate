# Backlog

Everything not built. Not scoped to the hackathon — this is the whole picture, including
work that only makes sense months out.

Ordered within each section by how much it matters, not by effort.

`ROADMAP.md` is the phased view of the same scope, with gates. This file is the flat
inventory. Both were reconciled against the source tree on 2026-08-09.

---

## Contract

### Correctness and safety

- [x] **`setPayee` rejects `address(this)`.** An owner could previously allowlist the
      PolicyEngine itself, which has no withdraw function — funds sent there were
      unrecoverable. Fixed and shipped in the redeploy. See `docs/outcomes.md` §5.3.
- [ ] **External audit.** Nothing here has been reviewed by anyone but us and a fuzzer.
- [ ] **Formal verification of the headline invariant** (`spent ≤ budgetCap`, always).
      Certora or Halmos. The invariant suite tests it; a prover would settle it.
- [ ] **Differential testing** against an independent reference implementation of the
      token bucket.
- [ ] **Fork tests** against real Arc state rather than a local EVM.

### Capability

- [x] **Multiple agents per owner.** Done in v2 (ADR 0010): per-agent policies and allowlists, an owner-wide pause, fleet views on web and phone. Supersedes
      ADR 0004's one policy per owner.
- [ ] **Per-payee sub-budgets.** "At most $50/month to this supplier" — currently the
      allowlist is binary.
- [ ] **Category limits.** Group payees and cap the group.
- [ ] **Time windows.** No payments outside business hours; no payments on weekends.
- [ ] **Batch spend / multicall.** One transaction, many micro-payments — the fix for the
      $0.002 flat gas cost making sub-$0.05 payments uneconomic.
- [ ] **On-chain payment references.** Arc has a memo contract; an invoice id on the
      transfer would make reconciliation possible.
- [ ] **Guardian role.** A second party who can pause but not spend — the corporate case.
- [ ] **Policy templates.** "Research agent", "procurement agent" as named presets.
- [ ] **Upgradeability story.** The contract is immutable. A bug means redeploy and migrate,
      and there is no migration path written.
- [ ] **A registry.** Discovering policies currently means knowing the owner address.

### Integration

- [ ] **ERC-6900 module / ERC-4337 account** — the architecturally correct home for this,
      blocked on Circle Modular Wallets session keys shipping. ADR 0001.
- [ ] **ERC-8183 escrow routing.** ADR 0005.
- [ ] **CCTP v2 cross-chain policy.** Same leash across chains.
- [ ] **Gateway nanopayment enforcement.** Today x402 per-call payments settle off-chain
      where the contract cannot see them; our enforcement point is the top-up. ADR 0005.
- [ ] **Paymaster / gas sponsorship**, when Arc supports it. Today the agent must hold its
      own USDC for gas, which is a second pot the dashboard does not show.

---

## Agent and SDK

- [x] **Package the SDK.** `TollgateClient` now lives in `sdk/` as `@tollgate/sdk`. Not yet
      published to npm.
- [~] **Framework adapters** — MCP server, Glove and Vercel AI SDK done; LangChain still to
      do. Glove and AI SDK shapes follow their docs and are not yet run against live installs.
- [x] **Deterministic attacker script.** `pnpm attack` holds the real agent key and runs
      eleven evasions in a fixed order (unknown payee, per-payment and budget overruns, burst,
      paying the contract, self-allowlisting, raising caps, unpausing, re-binding, direct
      `spend`, and a raw USDC `transferFrom` around the contract). Dry run is free;
      `--submit` leaves the refusals on chain. Exits non-zero on any breach. The budget and
      burst rules are reported as skipped, with the reason, when the per-payment cap would
      refuse first.
- [x] **Automatic retry on `EXCEEDS_VELOCITY`.** The client computes the wait from the
      bucket state and sleeps, or throws `VelocityWaitTooLongError` if the wait exceeds
      the caller's patience.
- [x] **Stuck-transaction recovery.** `unstick()` replaces at the same nonce — speed-up or
      cancel — and detects an already-settled payment rather than sending a second one.
- [x] **Nonce management** for concurrent payments from one key, via a serialisation queue.
- [x] **Gas balance monitoring.** `gasHealth()` reports the agent's own fee balance
      separately from the owner's budget, so an empty key never reads as a policy refusal.
- [ ] **Real marketplace integration.** `marketplace.ts` is a local catalogue standing in
      for Circle's Agent Marketplace, which is Base-only.
- [ ] **Persistent state across restarts.** An agent restarted mid-payment forgets the
      in-flight transaction hash it was told not to retry.

---

## Dashboard

- [x] **Owner signs in the browser.** Owner actions are signed by an injected EIP-1193
      wallet; the server holds no key and can authorise nothing. ADR 0008. A passkey layer
      on top remains desirable for onboarding, but the custody gap is closed.
- [x] **Policy editing.** All eight owner writes — caps, velocity, expiry, agent, payees,
      allowance, revoke, and policy creation — are now editable from the UI.
- [x] **Refusal visibility.** `trySpend` emits `Refused`, and the activity log renders
      refusals with their reason and a link to the transaction that proves it.
- [x] **Empty and error states** for a fresh deployment with no policy, and for an
      unconfigured environment.
- [ ] **Deployment.** It runs on localhost. Nothing is hosted.
- [ ] **Authentication.** There is none. Whoever reaches the port is the owner.
- [ ] **Notifications.** Email or push when the agent escalates or is refused. Requires a
      durable cursor, which requires a database. ADR 0006.
- [ ] **Multi-owner / team accounts**, roles, and multi-party approval.
- [ ] **CSV export and accounting integration.**
- [x] **History beyond the 400k-block horizon.** The horizon was silently dropping the
      oldest payments once Arc advanced past it. Removed; the persistent settled-window
      cache makes a full walk from the deployment block a one-time cost.
- [ ] **Real-time updates** over WebSocket rather than an interval refresh.
- [ ] **Accessibility beyond the contrast pass** — keyboard traversal, screen reader
      labelling, focus order through the policy editors.

---

## Web, beyond the dashboard

None of this exists.

- [ ] **Landing site.** No public page explains what this is to anyone who has not read
      the repository.
- [ ] **Documentation site** for the SDK — quickstart, API reference, examples.
- [ ] **Public security page** and a written incident-response process. For a money-handling
      trust layer the plan classes this as a product feature, not a chore.
- [ ] **Status page**, once anything is hosted.
- [ ] **The design system, formalised.** It currently lives as custom properties in one
      `globals.css` and cannot be shared with a second surface.

---

## Mobile — Android and iOS

Nothing exists yet. The case for it is specific: a kill switch you must be at your laptop
to reach is not a kill switch.

- [x] **Expo/React Native vs native Kotlin** — decided in ADR 0007: Expo, Android first, so
      the reason codes and token-bucket maths come from `shared/` rather than being
      reimplemented where nothing guards the drift.
- [ ] **Scaffold the app** and wire it into the workspace.
- [ ] **Passkey onboarding via Android Credential Manager.** Circle's modular-wallets SDK
      is web-first, so this needs a WebAuthn bridge or a native path — the same blocked
      dependency as the web passkey work. ADR 0001.
- [ ] **Kill switch in one tap from a cold start**, behind a biometric gate.
- [ ] **Approve a payee from a push notification**, with a deep link to the request.
- [ ] **FCM push** for escalations and refusals — needs the backend and a device-token
      registry, and therefore the database.
- [ ] **Key storage in Android Keystore**, hardware-backed.
- [ ] **Offline and stale-data handling.** A phone that cannot reach the RPC must say so
      loudly. A cached "all clear" during an outage is the worst failure this app can have.
- [ ] Live spend feed, budget and policy setup, progressive autonomy, multi-agent views.
- [ ] Background sync and a home-screen widget showing remaining budget.
- [ ] Play Store release: signing, privacy policy, data-safety declaration, and the extra
      review financial apps attract.
- [ ] Low-end device and slow-network testing.
- [ ] iOS parity: Secure Enclave, APNs, App Store review.

---

## Infrastructure

- [x] **CI.** GitHub Actions gates contracts (fmt, build, `ci` fuzz profile), typecheck,
      lint, unit tests and a production dashboard build on every push.
- [ ] **Deployment.** The dashboard runs on localhost only. Nothing is hosted.
- [ ] **The indexer + Postgres**, under the constraints in ADR 0006: a cache in front of
      the chain, never an authority over it.
- [ ] **Monitoring and alerting** on the contract — a spend spike, a pause, an approaching
      budget ceiling.
- [x] **`service/` and `mobile/` scaffolds removed**, along with the dead `pnpm service`
      and `pnpm mobile` root scripts. Both are real planned surfaces; an empty directory
      with a failing script was not a placeholder for one.
- [ ] **Mainnet.** Arc mainnet is not live.
- [x] **Fix the duplicated `POLICY_ENGINE_ADDRESS` in `.env`.**

---

## Testing

47 Solidity tests and 99 TypeScript tests.

- [x] **Unit tests for `shared/`** — 54. Includes a check that reads the Solidity `Reason`
      enum and fails if the TypeScript table drifts from it, and a 20,000-case differential
      of the token bucket against an independently written reference.
- [x] **Unit tests for the agent** — 23, against a stub node reached through an injectable
      transport. `selftest.ts` still covers the live paths and still spends real money, so
      it stays out of CI.
- [x] **Dashboard tests** — 20, over the log-window planner and the audit projection.
- [ ] **Component tests for the dashboard's React tree.** The projection is covered; the
      rendering is not.
- [ ] **End-to-end test of the agent loop** against a local fork.
- [ ] **Load-test the RPC assumptions.** The 20,000-block `eth_getLogs` limit was found by
      probing; it is not documented and could change.

---

## Documentation

- [x] `docs/threat-model.md`
- [x] `docs/circle-feedback.md`
- [x] `docs/outcomes.md`
- [x] `docs/tech-stack.md`
- [x] `docs/decisions/0001`–`0006`
- [x] `ROADMAP.md`
- [x] `docs/architecture.md`
- [x] `docs/decisions/0007` — the mobile stack decision
- [ ] `docs/demo-script.md`
- [ ] A written redeploy-and-migrate story. We have now redeployed once and still have no
      migration path on paper.
- [ ] SDK API reference

---

## The honesty gaps

Kept separate because they are not features. These are places where the claim is stronger
than the evidence, and closing them matters more than any feature above.

1. **The compromised-agent demo depends on a model's choices.** In the run, the model
   refused the attack *and also* declined some routes on its own reasoning. The hard
   evidence is the two contract refusals; the model's commentary is not evidence. A
   deterministic attacker fixes this. **Open.**
2. ~~**The dashboard cannot show a refusal.**~~ **Closed.** `trySpend` records refusals on
   chain and the activity log renders them with a proof link.
3. **The owner key lives in a `.env` file.** Non-custodial in the contract, custodial in the
   demo app. **Open, and now the largest.**
4. **The invariant suite was once passing vacuously** — zero successful spends across
   32,768 calls while all eight invariants reported green. Fixed, and locked in with a
   deterministic coverage test, but it is a reminder that a green suite is not proof.
5. **Nothing outside the contract is tested.** Three TypeScript packages move money and
   none of them has a single test. Added since the original four.
