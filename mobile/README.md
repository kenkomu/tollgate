# @tollgate/mobile

The owner's control plane in a pocket. Expo + React Native, Android first (ADR 0007).

```sh
pnpm service          # the backend it reads history from
pnpm mobile           # Expo dev server
```

Then scan the QR code with **Expo Go**, or press `w` for the browser.

> On a physical device, `localhost` means the phone. Set `expo.extra.apiUrl` in `app.json` to
> your machine's LAN address — `pnpm mobile` prints it — or the app will correctly report that
> it cannot reach the service.

---

## Why this exists

A kill switch you have to be at your laptop to reach is not a kill switch.

The two features this app is built around are the two that most need to be in a pocket: the
**kill switch**, because an agent behaving wrongly does not wait for you to get to a desk, and
the **approval queue**, because a strict allowlist (ADR 0003) means a blocked agent stops until
a human answers — and if that human is unreachable for hours, the leash has become a
productivity tax and the pressure to loosen the policy starts building.

## The structural decision

**Policy state comes from the chain. History comes from our service.**

The limits this app shows — budget left, rate headroom, paused or not — are read directly from
`PolicyEngine` by the device. They are the numbers the contract will enforce a second from now,
because they came from the contract. If our backend is down, wrong, or hostile, the numbers
that matter are unaffected.

History is a convenience layered on top, and the app says so when it is missing rather than
rendering an empty list that looks like "nothing happened".

## The rule this app must not break

**A phone that cannot reach the chain must say so, loudly.**

It is the worst failure available here. Every figure on screen is a claim about what an agent is
allowed to spend *right now*; showing a cached one during an outage tells an owner their agent
is bounded when the app has no idea whether it is.

So: no silent cache, no stale-while-revalidate, no default that hides a failure. Every screen
carries a freshness indicator, chain and service failures are reported *separately* — because
"history is stale but the limits are live" is a materially different situation from "we know
nothing" — and `test/freshness.test.ts` pins the staleness maths.

## The kill switch hands off to a wallet

Pausing is a signed transaction, and this app does not hold the owner's key.

It could — generate one, keep it in Keystore, sign here — and that would quietly recreate the
problem ADR 0008 just removed: a key held by software the owner did not choose, on a device
that can be lost, for the most sensitive action in the system.

So the app prepares the transaction and hands it to a wallet the owner already trusts. The
biometric prompt is **not** the authorisation; the wallet's signature is. It is there to stop a
pocket-tap from opening a signing flow nobody meant to start.

WalletConnect would make this one in-app flow, and it is the obvious next step. Until then this
is a deep link plus an explanation — worse UX than holding the key, and better than either
holding it or pretending the button does something it does not.

## Screens

| | |
|---|---|
| **Now** | Kill switch, budget and rate meters, the caps. Read from chain |
| **Approvals** | What the agent is blocked on. Approving records a decision; it grants nothing until the owner signs `setPayee` |
| **Activity** | Every payment, refusal and policy change, newest first |

Policy *editing* stays on the web for now. ADR 0007 leaves it open, and putting a velocity-limit
rewrite one tap from a lock screen is not obviously right.

## What is not built

Named rather than implied:

- **Push notifications.** The service has the device registry and the once-only delivery cursor;
  this app does not register a token yet. Needs FCM credentials and a dev build — Expo Go cannot
  receive them.
- **Deep links from a notification.** The scheme (`tollgate://`) and the service's stable
  approval ids exist; nothing consumes them yet.
- **Passkey onboarding.** Blocked on the same Circle dependency as the web (ADR 0001).
- **Offline queueing.** Deliberately absent — an action queued while offline is an action taken
  against a policy you could not read.

## References

- ADR 0007 — Expo over native Kotlin, and why
- ADR 0008 — why no key lives in this app
- ADR 0009 — the service this reads history from
