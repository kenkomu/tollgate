# ADR 0009 — SQLite for the projection store

**Status:** accepted
**Date:** 2026-08-09

## The question

ADR 0006 said the database arrives when notifications do, and specified Postgres. Mobile made
notifications real. Is Postgres still the right answer?

## Decision

**`node:sqlite`, behind a `Store` class that is the only thing which touches SQL.**

## Why not Postgres, which the plan named

The plan (§2.3) says "OLTP (Postgres) for the mirror", and that is right at maturity. It is
not right today, for three reasons that all point the same way.

**A clone must run.** `pnpm install && pnpm service` starts the backend with no daemon, no
`createdb`, no connection string, no container. For a project whose whole pitch is *verify this
yourself*, a reviewer who has to provision a database before they can see the audit log is a
reviewer who does not see the audit log. Postgres adds a step before the interesting part.

**The workload is one writer and a handful of readers.** The indexer writes; the API and the
phone read. There is no concurrency story that SQLite in WAL mode does not handle, and there
will not be until there are many owners on one deployment — which is the same trigger that
forces multi-tenancy generally.

**Node 26 ships it.** `node:sqlite` is in the standard library. This adds **zero
dependencies** to the part of the system that sits closest to money, which is where dependency
count matters most.

## What this is not

It is not a claim that SQLite scales to the plan's Phase 5. It will not. The `Store` class
exists precisely so that when it stops being enough, the change is a driver swap behind an
interface that already has 77 tests pinning its behaviour — not a rewrite that has to
rediscover what the semantics were supposed to be.

The triggers for revisiting: more than one owner per deployment, more than one service
instance, or a hosted deployment where the filesystem is not durable. Any of those and this
becomes Postgres.

## The rules that still bind, from ADR 0006

Unchanged, and enforced by tests rather than by intention:

- **The chain is the authority.** Every row keeps `tx_hash` and `log_index`; nothing is stored
  that was not decoded from a contract event.
- **It is droppable.** `test/indexer.test.ts` deletes the store, re-indexes, and asserts the
  result is identical. If that ever fails, something here has become authoritative and the
  no-database argument is void.
- **It never gates enforcement.** No payment consults it. The kill switch does not route
  through it. If this process is down, the contract is unaffected and the dashboard reads
  chain directly.
- **The API cannot authorise anything.** There is a test asserting no route exists that could
  move money or change policy. If this service is fully compromised, the attacker gets a read
  replica and a notification channel.

## What is genuinely ours

Three things with no on-chain answer, which is the whole reason this exists:

1. **The notification cursor.** The chain records that a payment was refused. It cannot record
   that we told someone. Without a durable claim, every restart re-alerts the entire history.
2. **Device tokens.** A push token exists nowhere else. Losing one silently stops a phone
   receiving alerts, which is the quietest possible failure in a product whose job is telling
   people things — hence migrations here are additive only, with a test that walks a real v1
   database through the upgrade.
3. **Approval identity.** A phone opening a notification needs a stable id to resolve. The
   previous implementation was a JSON file shared between two local processes.

## What the live run taught us

Both of these were found by running against Arc, not by reasoning:

**Notification cannot be conditional on indexing succeeding.** The obvious shape — index, and
if anything was written, notify — lost four real alerts. A pass wrote its rows, then Arc
rate-limited it before it returned, so the notify step never ran; every later pass wrote
nothing and skipped notification too. The alert was lost permanently and silently to a
transient network error. Notification now reads the store on every tick, made safe by the same
claim table.

**A cold start must pace itself.** Two dozen `eth_getLogs` calls fired back to back earn a
-32005 that then stalls the backfill. 250ms between windows, and exponential backoff on
failure capped at two minutes.

## References

- ADR 0006 — the no-database position this amends, and the triggers it named
- ADR 0007 — the mobile app that forced it
- `service/src/db.ts` — schema and additive migrations
- `service/test/migrations.test.ts` — the upgrade, on a real v1 database
