# Backlog

Everything not built. Not scoped to the hackathon — this is the whole picture, including
work that only makes sense months out.

Ordered within each section by how much it matters, not by effort.

---

## Contract

### Correctness and safety

- [ ] **`setPayee` should reject `address(this)`.** An owner can currently allowlist the
      PolicyEngine itself, which has no withdraw function — funds sent there are
      unrecoverable. One-line fix. Not applied before submission because redeploying
      invalidates the verified contract and every proof link in the demo. See
      `docs/outcomes.md` §5.3.
- [ ] **External audit.** Nothing here has been reviewed by anyone but us and a fuzzer.
- [ ] **Formal verification of the headline invariant** (`spent ≤ budgetCap`, always).
      Certora or Halmos. The invariant suite tests it; a prover would settle it.
- [ ] **Differential testing** against an independent reference implementation of the
      token bucket.
- [ ] **Fork tests** against real Arc state rather than a local EVM.

### Capability

- [ ] **Multiple agents per owner.** One policy per owner today (ADR 0004). A real operator
      runs a fleet, each with its own leash.
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

- [ ] **Package the SDK.** `TollgateClient` is the actual product for a developer and it
      currently lives inside the demo app. It should be `@tollgate/sdk` on npm.
- [ ] **Framework adapters** — an MCP server, a LangChain tool, a Vercel AI SDK tool.
- [ ] **Deterministic attacker script.** The compromised-agent demo relies on a model
      choosing to attack. A scripted adversary that tries every evasion in a fixed order
      would make the guarantee reproducible instead of anecdotal. **This is the single
      biggest honesty gap in the demo** — see below.
- [ ] **Automatic retry on `EXCEEDS_VELOCITY`.** It is the only `retry-later` reason and the
      agent currently just reports it. It should back off and resume.
- [ ] **Stuck-transaction recovery.** `verify()` exists; automatic replace-by-fee at the
      same nonce does not.
- [ ] **Nonce management** for concurrent payments from one key.
- [ ] **Gas balance monitoring.** An agent that runs out of gas fails in a way that looks
      like a policy refusal but is not.
- [ ] **Real marketplace integration.** `marketplace.ts` is a local catalogue standing in
      for Circle's Agent Marketplace, which is Base-only.

---

## Dashboard

- [ ] **Owner signs in the browser.** The biggest gap. Owner actions are currently signed
      server-side from `DEPLOYER_PRIVATE_KEY` in `.env` — an MVP shortcut that sits badly
      against the non-custodial thesis. Should be a passkey or WalletConnect signature.
      Documented in `lib/owner.ts` and the threat model.
- [ ] **Policy editing.** Caps, velocity and expiry are read-only in the UI; only pause and
      payee approval are writable. The contract supports the rest.
- [ ] **Refusal visibility.** Reverts emit no events, so the dashboard can prove what was
      *allowed* and cannot show what was *stopped*. Needs either an indexer capturing
      reverted transactions or an on-chain `Refused` event. **The most valuable single
      item on this list** — it is the demo's core claim, and the UI currently cannot show it.
- [ ] **Notifications.** Email or push when the agent escalates or is refused. Requires a
      durable cursor, which requires a database. ADR 0006.
- [ ] **Multi-owner / team accounts.**
- [ ] **CSV export and accounting integration.**
- [ ] **History beyond the 400k-block horizon.** Needs the indexer.
- [ ] **Mobile.** Expo scaffold deferred.
- [ ] **Empty and error states** for a fresh deployment with no policy — currently a bare
      instruction to run a forge script.

---

## Infrastructure

- [ ] **CI.** No GitHub Actions. `forge test` and `pnpm typecheck` should gate every push.
- [ ] **Deployment.** The dashboard runs on localhost only. Nothing is hosted.
- [ ] **The indexer + Postgres**, under the constraints in ADR 0006: a cache in front of
      the chain, never an authority over it.
- [ ] **Monitoring and alerting** on the contract — a spend spike, a pause, an approaching
      budget ceiling.
- [ ] **`service/` package.** Scaffolded, empty, and currently unjustified. Delete it or
      fill it.
- [ ] **Mainnet.** Arc mainnet is not live.
- [ ] **Fix the duplicated `POLICY_ENGINE_ADDRESS` in `.env`** — defined twice, empty first.
      Last wins so nothing breaks, but it is a trap for the next person.

---

## Testing

- [ ] **End-to-end test of the agent loop.** 40 contract tests, zero tests of the agent.
- [ ] **Dashboard tests.** None exist.
- [ ] **Load-test the RPC assumptions.** The 20,000-block `eth_getLogs` limit was found by
      probing; it is not documented and could change.

---

## Documentation

- [x] `docs/threat-model.md`
- [x] `docs/circle-feedback.md`
- [x] `docs/outcomes.md`
- [x] `docs/tech-stack.md`
- [x] `docs/decisions/0001`–`0006`
- [ ] `docs/architecture.md`
- [ ] `docs/demo-script.md`
- [ ] `ROADMAP.md`
- [ ] SDK API reference

---

## The honesty gaps

Kept separate because they are not features. These are places where the claim is stronger
than the evidence, and closing them matters more than any feature above.

1. **The compromised-agent demo depends on a model's choices.** In the run, the model
   refused the attack *and also* declined some routes on its own reasoning. The hard
   evidence is the two contract refusals; the model's commentary is not evidence. A
   deterministic attacker fixes this.
2. **The dashboard cannot show a refusal.** The product's central claim is "it stops
   things," and the UI can only display what got through.
3. **The owner key lives in a `.env` file.** Non-custodial in the contract, custodial in the
   demo app.
4. **The invariant suite was once passing vacuously** — zero successful spends across
   32,768 calls while all eight invariants reported green. Fixed, and locked in with a
   deterministic coverage test, but it is a reminder that a green suite is not proof.
