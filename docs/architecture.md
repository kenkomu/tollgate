# Architecture

How Tollgate is built, and why each piece is where it is.

The organising idea: **the constraint must live somewhere the agent cannot reach.** Every
structural decision below follows from that, including the ones that look like omissions.

---

## The claim this architecture has to support

> An agent whose key has been fully compromised still cannot spend outside its policy.

That sentence is falsifiable, which is the point. It fails if there is *any* path from the
agent's signing key to a USDC transfer that does not pass through policy evaluation. So the
architecture is mostly an argument that no such path exists.

---

## The payment path

```
   Owner (EOA today, passkey later)              Agent (session key)
        │                                              │
        │ approve(PolicyEngine, exactBudget)           │ trySpend(payee, amount)
        │ createPolicy(caps, velocity, expiry)         │
        │ setPayee(payee, true)                        │
        ▼                                              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  PolicyEngine  ·  0x8168eb562496A966f339a4bD165B924EeDce9873 │
   │                                                              │
   │   _evaluate()   budget cap · per-tx cap · token bucket       │
   │                 payee allowlist · expiry · pause             │
   └───────────────┬──────────────────────────┬───────────────────┘
                   │ Reason.OK                │ anything else
                   ▼                          ▼
       USDC.transferFrom(owner → payee)   emit Refused(reason)
       emit Spent(...)                    nothing moves, no gas wasted
                   │                          │
                   └──────────┬───────────────┘
                              ▼
                    Arc, as the only record
                              │
                   ┌──────────┴──────────┐
                   ▼                     ▼
              Dashboard              Agent's own
           (rebuilt from logs)     error handling
```

Money moves **owner → payee**. It never enters Tollgate. There is no vault, no pool, no
deposit, and no withdraw function to write a bug in.

---

## The four packages

### `enforcement/` — the trust core

Solidity 0.8.28, Foundry, `evm_version = "cancun"`. One contract, 389 lines, immutable, no
proxy, no admin key, no upgrade path.

`_evaluate` is the whole product. Both the free pre-check (`checkTransfer`) and the real
attempt (`_attempt`) call it, so the answer an agent gets when planning is computed by the
same code that decides when money is at stake. They cannot disagree, because there is only
one of them.

Two entry points, deliberately:

- **`spend`** reverts with `PolicyViolation(reason)`. Cheaper — a refused attempt costs no
  gas — but a revert takes its own logs down with it, so a refusal leaves no trace.
- **`trySpend`** returns the reason and emits `Refused`. Costs about $0.0007. The agent uses
  this one, and it is not the agent's call to opt out of being watched.

Both route through the same internal `_attempt`, so they cannot diverge in behaviour.

**Why an allowance rather than a vault.** The owner keeps custody and grants an ERC-20
approval sized to the budget. This is ADR 0001, and its best property is not the philosophy —
it is that the allowance is a **second ceiling that holds even if our contract is wrong**. A
vault bug reaches everything deposited. Here a bug reaches, at most, the outstanding approval.
Revocation is `approve(0)`: the owner leaves without our cooperation, our permission, or our
servers being up.

**Why one policy per owner.** ADR 0004. It is a real limitation — a fleet operator needs
several — and it is the next contract change.

### `shared/` — the vocabulary

The single source of truth for the ABI, reason codes, chain configuration and amount
handling. The rule: nothing outside `enforcement/` may hard-code a contract address, an ABI
fragment, a reason code or a decimal count.

This package exists because of one specific hazard. Arc's native USDC is **18 decimals** for
gas accounting and its ERC-20 interface is **6** for transfers. Both are correct. Mixing them
is a 10¹² error in software that moves money. `USDC_DECIMALS = 6` lives here with a warning,
every amount that crosses a boundary is 6-decimal, and a test asserts that `usdc("1")` is a
millionth of `parseEther("1")` so the mistake fails the build.

It also holds the off-chain mirror of the token bucket (`availableNow`), which is plan §2.3's
policy simulator: the dashboard and agent compute headroom locally instead of paying an RPC
round trip. It is a projection, never an authority — when it and the chain disagree, the chain
is right and the mirror is the bug. A 20,000-case differential test against an independently
written reference guards it.

### `agent/` — the thing being leashed

Built on `@anthropic-ai/claude-agent-sdk` with Arc wiring through viem. Circle's own Agent
Stack starter kit could not be used: it is Base-mainnet-only by its own `.env.example`, on a
hackathon whose premise is Arc.

The tool surface is deliberately **unrestricted**. `pay_address` takes an arbitrary address
and an arbitrary amount. Narrowing it would be exactly the app-level guardrail this product
exists to replace — a compromised or prompt-injected agent ignores it — and a demo that only
worked because the tools were restrictive would prove nothing.

`TollgateClient` is the part that will become `@tollgate/sdk`. Its shape matters more than its
code: `check` never throws and always answers the three questions an agent needs — is it
allowed, why not, and *would waiting help*. An agent that cannot tell "back off and retry"
from "a human must act" is the looping-agent failure this product exists to contain. Exactly
one reason code is retryable.

Five distinct error classes, because the correct response differs and collapsing any two is
dangerous:

| Error | What is true | Correct response |
|---|---|---|
| `PolicyRefusedError` | Refused, recorded on chain, nothing moved | Read the reason; retry only if velocity |
| `PaymentRevertedError` | Mined and reverted, nothing moved | Re-check and reassess |
| `PaymentInFlightError` | Submitted, **outcome unknown** | Resolve it. Never retry |
| `VelocityWaitTooLongError` | Nothing submitted, will work later | Do other work, come back |
| `GasExhaustedError` | The agent's own key is empty | Tell the owner. Not a policy problem |

The third is the one that matters. "Reverted" means the money definitely did not move;
"in flight" means we do not know. An agent told the second as though it were the first
retries, and that is how one invoice gets paid twice.

Submissions are serialised through a promise queue. Three concurrent purchases is the obvious
way to write an agent loop, and unserialised they all read the same pending nonce.

### `dashboard/` — the owner's control plane

Next.js App Router, React Server Components, viem. Four pages: overview, activity, payees,
policy. All eight owner writes are editable from the UI.

The audit log is **rebuilt from contract logs on every request**. There is no database. That
is ADR 0006, and the reasoning is not mainly about scale — it is that this product's claim is
*"don't trust the operator, check the chain,"* and shipping it with a private
operator-controlled record of what happened would undercut that in the one place a sceptic
would look. Every row carries a link to ArcScan. You are invited to check us, not trust us.

The projection logic lives in `lib/audit.ts` as pure functions, separate from `lib/activity.ts`
which owns the network. Both halves fail silently when wrong — a gap in the window grid drops
payments out of history and nothing errors — so the pure half is unit-tested.

---

## On-chain versus off-chain

Plan §2.4, applied literally.

| On chain | Off chain |
|---|---|
| Policy state and every limit | Rendering, explanation, English |
| The evaluation that decides | The pre-check that advises |
| Every payment and every refusal | The approval request queue |
| The allowlist | The service catalogue |
| Pause | Nothing that gates pause |

The dividing rule: **anything whose failure could permit a payment lives on chain.** Anything
whose failure could only degrade a display lives off it.

The kill switch is the sharpest case. It is a direct owner → chain write with no backend, no
indexer and no relayer in its path, so it works when everything else we run is down. That
constraint is why `arcFees` — which applies Arc's 20 Gwei floor — lives in `shared/` and is
used by the dashboard's owner actions as well as the agent: a pause transaction bid under the
floor may sit unmined indefinitely, and an unmined kill switch is the worst bug this system
could have.

---

## Deliberate absences

Things a reviewer will notice are missing, and why.

**No database.** ADR 0006. The chain is the record; losing this server loses nothing. Costs:
history has a 400,000-block horizon, and reads are expensive (mitigated to 0.44s first paint
by memoising settled log windows and streaming the walk behind Suspense).

**No backend service.** Nothing to reconcile because there is no mirror. It becomes necessary
the moment notifications exist, which is the moment mobile exists (ADR 0007).

**No ERC-4337 / ERC-6900 module.** This was the intended architecture — enforcement in the
account's validation hook governs *any* userOp, not just token transfers. Circle Modular
Wallets ship only the Address Book module; Session Keys is "coming soon". So we designed a
third path, and it turned out to have a property the module design lacks: it works with any
EOA on any ERC-20 chain today, with no account-abstraction infrastructure at all. Whether the
module is still the destination is now an open decision rather than a deferred plan.

**No escrow.** x402 payments can settle without the service being delivered. ERC-8183 escrow
routing is the answer and it is documented as a stretch in ADR 0005, not solved.

---

## Where the claim is currently weaker than the pitch

Stated here rather than buried, because an architecture document that only lists strengths is
marketing.

1. **The owner's key is in a `.env` file.** Owner actions are signed server-side. The contract
   is non-custodial; the demo app around it is not. This is the largest open gap.
2. **The attack demo depends on a model choosing to attack.** The hard evidence is the
   contract refusals; the model's commentary is not evidence. A deterministic adversary would
   make the guarantee reproducible.
3. **One policy per owner**, so "an operator's fleet" is currently one agent.
4. **Nothing is hosted.** It runs on a laptop against testnet. Arc mainnet is not live.

---

## Verifying any of this yourself

```sh
pnpm contracts:test    # 47 tests: unit, fuzz, invariant
pnpm test              # 99 TypeScript tests across shared, agent, dashboard
pnpm typecheck
pnpm agent             # an agent working inside a budget it did not set
pnpm agent:compromised # the same agent, hostile instructions, same key
pnpm dashboard         # http://localhost:3000
```

The contract is verified on ArcScan, so the source you read here is the source that runs.

## References

- `docs/threat-model.md` — what we assume an attacker can do
- `docs/outcomes.md` — every outcome of a `spend`, enumerated
- `docs/decisions/` — ADRs 0001–0007
- `docs/circle-feedback.md` — six findings on Circle's stack, including a reproducible
  gas-estimator defect
- `ROADMAP.md` — everything not built, phased
