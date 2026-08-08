# ADR 0007 — React Native for the mobile control plane

**Status:** proposed — needs sign-off before any scaffold is created
**Date:** 2026-08-08

## The question

Plan §5.1 makes mobile the *consumer* control plane: passkey onboarding, live spend feed,
policy setup, calibrated-trust approvals, a prominent kill switch, notifications, multi-agent
views. Nothing of it exists. Before writing any of it we have to answer how it is built,
because the choice is expensive to reverse once screens exist.

## Why mobile is not optional

Worth stating first, because "we have a web dashboard already" is the obvious objection.

**A kill switch you have to be at your laptop to reach is not a kill switch.** The two
features that most need to be in a pocket are the two this product is built around:

1. **The kill switch.** The scenario it exists for — an agent behaving wrongly — does not
   wait for you to get to a desk. Every second between noticing and pausing is spend.
2. **The approval queue.** A strict allowlist (ADR 0003) means a blocked agent stops until a
   human acts. If that human is unreachable for four hours, the leash has turned into a
   productivity tax, and the pressure to widen the policy "just to be safe" is exactly how
   these systems end up permissive.

Both are notification-driven, which is also why mobile is what finally forces a backend.

## Decision

**React Native via Expo, sharing `@tollgate/shared` directly with the rest of the repo.**

## Why, against the alternative

Native Kotlin is the better answer on two axes and the worse answer on the ones that decide
it.

| | React Native / Expo | Native Kotlin |
|---|---|---|
| Reason codes, token-bucket maths, amount formatting | Imported from `@tollgate/shared`, already tested | Reimplemented in Kotlin, tested again, drifts |
| viem / chain access | The exact client the dashboard and agent use | A second Web3 stack (web3j or Kotlin bindings) |
| Credential Manager (passkeys) | Bridge via `react-native-passkey` | First-class |
| Keystore, biometrics | Expo modules, adequate | First-class |
| iOS later | Same codebase | A third implementation |
| People who can work on it | Everyone already on this repo | A hire |

The deciding argument is the first row, and it is a correctness argument rather than a
convenience one. `shared/` exists precisely so that no consumer re-derives a reason code or a
decimal count. A Kotlin app would be the first component in the system to hold its own copy
of the enforcement vocabulary, and the failure mode is not a crash — it is a phone showing
the owner a wrong explanation for why their agent was stopped, or a wrong number for how much
budget is left. We have already written a test that reads `PolicyEngine.sol` and fails if the
TypeScript table drifts from it; there would be no equivalent guard on a hand-maintained
Kotlin enum.

Native wins on passkeys and biometrics. That is real, and it is the one place we will feel
this: Credential Manager through a bridge is more fragile than Credential Manager directly.
We accept it, and if passkey integration turns out to be the thing that does not work, that
is a reason to revisit *this decision*, not to fork the codebase.

## What this commits us to

- **Expo, not bare React Native.** EAS handles signing, builds and store submission, which is
  a meaningful fraction of the work in shipping a financial app.
- **Android first.** The ICP hypothesis (§1.5) is not iOS-skewed, and Play Store review is
  the more forgiving of the two to learn on.
- **The app is a client, never an authority.** It reads chain state and it signs owner
  transactions. It holds no policy logic of its own and no cached verdicts.

## The rule this app must not break

**A phone that cannot reach the chain must say so, loudly.**

This is the single worst failure available to this product. A cached "all clear" during an
RPC outage tells an owner their agent is bounded when the app has no idea whether it is. Every
screen showing policy state needs a freshness indicator and an explicit stale mode, and the
kill switch must report failure rather than optimistically showing success. Offline is not a
degraded-but-fine state here; it is a state where the app knows nothing.

## What it forces

Mobile is what makes the backend in ADR 0006 unavoidable, on day one, for three things that
have no on-chain answer:

- **Push notifications** need a device-token registry and a durable cursor of what has
  already been sent.
- **Deep links** from a notification to a specific approval need that approval to have a
  server-side identity; the current implementation is a JSON file shared between two local
  processes.
- **History** past the 400,000-block horizon is not something a phone should walk over a
  mobile connection.

So the sequence is: backend first, or at least concurrently. Building the app against the
current file-based approval store would be building against something we already know we are
replacing.

## Open questions

- Whether policy *editing* belongs on the phone at all, or whether mobile is approve-and-kill
  only with editing left to the web. Approving a payee and rewriting a velocity limit are very
  different levels of consequence to expose on a lock screen.
- Whether the passkey signs an EOA-equivalent key held in Keystore, or a real WebAuthn P-256
  credential against a smart account. The second is the better answer and depends on the same
  blocked Circle dependency as the web (ADR 0001).

## References

- Plan §5.1, §5.2
- ADR 0001 — why the modular-wallet path is blocked
- ADR 0003 — the strict allowlist that makes approvals time-critical
- ADR 0006 — the backend this forces
- `ROADMAP.md` — the mobile surface, itemised
