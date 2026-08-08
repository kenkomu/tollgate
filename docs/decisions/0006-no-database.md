# ADR 0006 — No database

**Status:** accepted
**Date:** 2026-08-06

## The question

Do we need a database?

## Decision

**Not yet, and not for anything we currently do.** The audit log is rebuilt from contract
events on every request. Postgres arrives when a specific, named condition is met — not
by default.

## Why not

**The chain already is the database, and it is a better one for this job.**

Three properties we would otherwise have to build and defend:

1. **It cannot drift.** A mirror can disagree with the chain. Ours cannot, because there is
   nothing to disagree — every row is decoded from a `Spent` or `PayeeSet` event at the
   moment you look at it.
2. **It cannot be tampered with.** An audit log whose operator can edit it is not an audit
   log. Ours is as tamper-evident as Arc.
3. **Losing the server loses nothing.** There is no backup to take, no migration to run,
   no restore to test. Deleting the whole deployment costs history nothing.

There is also a positioning argument, and it is not a small one. This product's entire
claim is *"don't trust the operator, check the chain."* Shipping it with a private
operator-controlled database of what happened would undercut that claim in the one place a
sceptical judge would look. **"We rebuild the entire audit log from chain on every load" is
a stronger sentence than "we keep a mirror."**

Every row in the UI carries a `proof` link to ArcScan for exactly this reason: you are
invited to check us, not trust us.

## What it costs

Honestly stated, because the tradeoff is real:

- **Reads are expensive.** Seven `eth_getLogs` windows plus block timestamps: 8.7s cold.
- **History has a horizon.** `MAX_HISTORY_BLOCKS` is 400,000 blocks — a couple of days on
  Arc. Beyond that this approach stops being reasonable.
- **No cross-owner queries.** "Show every owner who paid this payee" is not answerable
  without scanning. One owner per deployment hides this today.
- **Refusals are invisible.** A reverted `spend` emits no event, so there is no on-chain
  record of a *blocked* attempt. **This is the sharpest limitation of the no-database
  position** — the dashboard can prove what was allowed and cannot show what was stopped.
  The demo's strongest evidence lives in the agent's terminal, not in the UI.

## How we made the cost bearable

Without adding a database:

- **Settled history is memoised in process.** A block more than 64 confirmations behind
  the tip will never contain different logs, so it is read once. Only the tip window is
  re-read.
- **The log walk streams behind Suspense**, so the caps paint from a single `getPolicy`
  call while history loads.

Result: 8.7s → 0.44s to first paint, 17.4s → 1.0s total.

Note what is *not* cached: the policy. Current state is read fresh on every request,
because a cached view of a spend limit is a wrong view of a spend limit. Caching immutable
history and caching current state are different things, and only one of them is safe.

## When this flips

Adopt Postgres when **any** of these becomes true:

| Trigger | Why it forces the change |
|---|---|
| More than ~10 owners on one deployment | Client-side filtering of a full log walk stops scaling |
| History beyond ~400k blocks matters | Chunked reads exceed a reasonable request budget |
| Refusals must be visible in the UI | Requires capturing reverts, which are not on chain |
| Notifications, digests, or webhooks | Needs a durable cursor of what has already been sent |
| Cross-owner analytics | Not answerable from a per-owner scan |

The first of these we will hit is **refusal visibility**, and it is worth being clear that
a database is genuinely the right answer there rather than a concession.

### Amendment, 2026-08-08: the first trigger fired, and the answer was not a database

Refusal visibility arrived, and the fix was to make refusals *exist on chain* rather than to
build a mirror that captures reverts. `trySpend` returns a reason code and emits `Refused`
instead of reverting, so a blocked attempt is now a successful transaction carrying a
permanent record. The dashboard reads it in the same log walk as everything else.

This is worth stating plainly because it inverts the prediction above. The trigger was real;
the inference from it was wrong. Reaching for storage would have produced an
operator-controlled record of refusals — precisely the thing this ADR argues against — when
the honest fix was to put the evidence somewhere nobody has to trust us about. The cost is
about $0.0007 of gas per refusal, paid by the agent, and it is not the agent's call to opt
out of being watched.

The remaining triggers stand unchanged. **Notifications are the next one**, and that one has
no on-chain answer: a durable cursor of what has already been sent is genuinely state, and
the mobile app in ADR 0007 needs it on day one.

## The shape it takes when it arrives

A **cache in front of the chain, never an authority over it.** The rules that keep this
ADR true even after Postgres exists:

- Chain remains the source of truth. Every stored row keeps its `txHash + logIndex`.
- The projection must be droppable and rebuildable from chain at any time.
- Any disagreement between database and chain is resolved in the chain's favour, always.
- The kill switch never routes through it. Pause is a direct owner → chain write and stays
  that way, so it keeps working when everything else is down.

## References

- Plan §2.3, §2.4
- `dashboard/lib/activity.ts` — the walk and the memoisation
- `docs/threat-model.md` — operator-tampering row
