# 0002 — Token bucket for velocity, not a tumbling window

**Status:** accepted · **Date:** 2026-08-05

## Context

Policy needs a rate limit as well as a total budget, so that a compromised agent grinding
away under the per-transaction cap still cannot drain the budget in one burst.

## Decision

A **token bucket**. State is `available`, `bucketCapacity`, `refillPerSecond` and
`lastRefill`. Headroom accrues continuously and is clamped at capacity:

```
available = min(capacity, available + elapsed * refillPerSecond)
```

## Why not a tumbling window

A tumbling window (`windowStart`, `windowSpent`, reset when elapsed) is cheaper and easier
to explain, but it permits a burst at the boundary: spend the full cap in the last second
of window *N* and the full cap again in the first second of *N+1*, and twice the intended
allowance leaves in a two-second interval.

Being precise about what the bucket actually guarantees, because it is easy to overstate:

- Over a window of length *T*, starting from a full bucket, maximum outflow is
  `capacity + T × rate`. It is **not** capped at one period's worth — starting full, a day
  at "200/day" with a 200 capacity can move up to 400.
- What the bucket removes is the *instantaneous* double-spend. Once drained, refill is
  strictly proportional to elapsed time. There is no moment at which a fresh allowance
  appears on top of what was just spent.

So the honest claim is that a bucket bounds the sustained rate with a known burst, while a
window bounds the average but permits an unbounded-in-time spike at each boundary. For a
spend guard the second failure mode is the one that matters.

It also renders well: a continuously refilling meter is the natural picture for the
progressive-autonomy language in the product design, where a tumbling window would show a
bar that snaps back to full at midnight.

## Consequences

- Widening `bucketCapacity` does **not** retroactively fill the bucket. Headroom must be
  earned by elapsed time, otherwise repeatedly re-setting velocity would be an unbounded
  spend hole. Covered by `test_setVelocity_wideningDoesNotRetroactivelyFill`.
- `setVelocity` settles the bucket at the *old* rate before applying the new one, so a
  rate change can neither mint nor destroy headroom retroactively.
- Arithmetic runs in `uint256` internally before clamping to `uint128`. A `uint64` elapsed
  multiplied by a `uint128` rate cannot overflow `uint256`.
