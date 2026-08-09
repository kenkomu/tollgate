# @tollgate/service

The indexer, the notification cursor, and the API the phone talks to.

```sh
pnpm service          # http://localhost:8080
```

Needs `POLICY_ENGINE_ADDRESS` and `OWNER_ADDRESS` in the repository-root `.env`. Nothing else.
The database is created on first run at `.tollgate/tollgate.db`.

---

## What it is for

Three things that have no on-chain answer. Everything else in this project deliberately avoids
storing state, and ADR 0006 sets out why; these are the exceptions it named.

1. **A durable record of what has already been notified.** The chain records that a payment was
   refused. It cannot record that we told anybody. Without this, every restart re-reads the
   chain, finds the same refusals, and alerts the owner about them again.
2. **Device tokens.** A push token exists nowhere else in the world.
3. **Approval identity.** A phone opening a notification needs a stable id to resolve to a
   specific request.

Indexed history is a convenience on top — the dashboard reads chain directly and does not need
this service at all.

## What it cannot do

**Authorise anything.** There is no endpoint that moves money, pauses an agent, or allowlists a
payee, and a test asserts there never will be. Every one of those is a transaction signed by
the owner's own key.

If this service is fully compromised, the attacker gets a read replica and the ability to send
notifications. They cannot spend.

This is the property the whole system is shaped around, and it is worth not quietly giving away
the first time an endpoint would be convenient.

## The rules it runs under

From ADR 0006, enforced by tests rather than by intention:

- **The chain is the authority.** Every row carries `tx_hash` and `log_index`.
- **It is droppable.** Delete the file, restart, and it rebuilds. There is a test that does
  exactly that and compares the result.
- **It never gates enforcement.** If this process is down, the contract is unaffected and the
  dashboard still works.

## API

| | | |
|---|---|---|
| `GET` | `/health` | What it is, how far it has indexed, and the current chain head |
| `GET` | `/activity?limit=100` | Indexed audit log, newest first |
| `GET` | `/approvals` | Open approval requests |
| `GET` | `/approvals/:id` | One request, including resolved ones — notifications deep-link here |
| `POST` | `/approvals` | The agent asks for a payee it cannot pay |
| `POST` | `/approvals/:id/resolve` | Record that a human decided. Grants nothing |
| `POST` | `/devices` | Register a push token |
| `POST` | `/devices/forget` | Unregister one |

`indexedThrough` appears on `/health` and `/activity` so a client can measure its own
staleness. A client that cannot tell how old the data is has to assume it is current, and
assuming a stale spend limit is current is exactly the failure ADR 0007 forbids on the phone.

## Layout

| File | |
|---|---|
| `db.ts` | Schema and additive-only migrations |
| `store.ts` | Every read and write. The only thing that touches SQL |
| `indexer.ts` | Chain → projection, sharing `projectAuditLog` with the dashboard |
| `notifications.ts` | What is worth interrupting someone for, and the once-only delivery |
| `api.ts` | HTTP |
| `index.ts` | The three of them, wired together |

## Two things the live run taught us

Both were found by running against Arc, not by reasoning about it, and both are in the tests
now:

**Notification cannot depend on the index pass succeeding.** The obvious shape — index, and if
anything was written, notify — lost four real alerts: a pass wrote its rows, Arc rate-limited
it before it returned, and the notify step never ran. Every later pass wrote nothing and
skipped notification too. Now notification reads the store on every tick, which the claim table
makes safe.

**A cold start must pace itself.** Two dozen `eth_getLogs` calls back to back earn a `-32005`
that stalls the whole backfill.

## References

- ADR 0006 — the no-database position and the triggers that ended it
- ADR 0007 — the mobile app that forced this
- ADR 0009 — why SQLite rather than the Postgres the plan named
