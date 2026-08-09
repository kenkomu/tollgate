import {DatabaseSync} from "node:sqlite";
import {mkdirSync} from "node:fs";
import {dirname, resolve} from "node:path";

/**
 * The projection store.
 *
 * ADR 0006 argued against a database and set the conditions under which one becomes correct.
 * Mobile met them: push notifications need a durable cursor of what has already been sent,
 * and an approval a phone can deep-link into needs a server-side identity. Neither has an
 * on-chain answer, so this is the first state in the system that is genuinely ours.
 *
 * The rules from that ADR still bind, and they are what the schema is shaped around:
 *
 *   - **The chain is the authority.** Every indexed row keeps `tx_hash` and `log_index`, and
 *     nothing is written here that was not decoded from a contract event.
 *   - **It is droppable.** Delete the file, run the backfill, and you are whole again. There
 *     is a test that does exactly that and compares the result.
 *   - **It never gates enforcement.** No payment consults this. The kill switch does not
 *     route through it. If this process is down, the contract is unaffected and the dashboard
 *     falls back to reading chain directly.
 *
 * SQLite via `node:sqlite` rather than Postgres, deliberately — see ADR 0009. The interface
 * is narrow enough that swapping the driver is a day's work when hosting demands it.
 */

const DEFAULT_PATH = resolve(process.cwd(), "..", ".tollgate", "tollgate.db");

/**
 * `tx_hash + log_index` is the primary key on both event tables.
 *
 * §3.5 requires ingestion to be idempotent, and this is where that is enforced rather than
 * hoped for: re-indexing a range, replaying a webhook, or recovering from a reorg re-inserts
 * the same rows and SQLite rejects the duplicates. A payment cannot be double-counted because
 * there is nowhere for the second copy to go.
 *
 * Amounts are TEXT. They are 6-decimal USDC held as bigint, and SQLite's INTEGER is 64-bit
 * signed — enough today and a silent truncation the day it is not. Money does not go in a
 * type that can round.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  tx_hash      TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  owner        TEXT    NOT NULL,
  agent        TEXT,
  payee        TEXT,
  amount       TEXT,
  spent_total  TEXT,
  reason       INTEGER,
  detail_label TEXT,
  detail_values TEXT,
  previous_agent TEXT,
  block_number INTEGER NOT NULL,
  block_time   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS events_owner_block ON events (owner, block_number DESC);
CREATE INDEX IF NOT EXISTS events_kind ON events (kind);

-- How far the indexer has walked. One row.
CREATE TABLE IF NOT EXISTS cursor (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_block   INTEGER NOT NULL
);

-- Approval requests. Moved off the JSON file the agent and dashboard shared, because a
-- phone opening a notification needs to resolve a stable id to a specific request.
CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  service_id   TEXT NOT NULL,
  service_name TEXT NOT NULL,
  payee        TEXT NOT NULL,
  amount       TEXT NOT NULL,
  why          TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  resolved_at  INTEGER,
  outcome      TEXT
);

CREATE INDEX IF NOT EXISTS approvals_open ON approvals (owner, resolved_at);

-- Devices to push to. A phone registers here; nothing else in the system knows it exists.
CREATE TABLE IF NOT EXISTS devices (
  token         TEXT PRIMARY KEY,
  owner         TEXT NOT NULL,
  platform      TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

-- What has already been delivered. This is the durable cursor ADR 0006 named as the thing
-- with no on-chain answer: the chain records that a payment was refused, and cannot record
-- that we told someone about it. Without this, every restart re-notifies the whole history.
CREATE TABLE IF NOT EXISTS notified (
  event_key  TEXT NOT NULL,
  channel    TEXT NOT NULL,
  sent_at    INTEGER NOT NULL,
  PRIMARY KEY (event_key, channel)
);
`;

/**
 * Migrations, additive only.
 *
 * The events table is rebuildable from chain and could simply be dropped. `approvals` and
 * `devices` cannot — a device token exists nowhere else, and dropping it silently stops a
 * phone receiving alerts with no error anywhere. So migrations here add columns and never
 * remove them, and the version is only advanced once the statements have applied.
 */
const MIGRATIONS: string[][] = [
  // v1 → v2: owner policy changes joined the audit log and carry values with them.
  [
    "ALTER TABLE events ADD COLUMN detail_label TEXT",
    "ALTER TABLE events ADD COLUMN detail_values TEXT",
    "ALTER TABLE events ADD COLUMN previous_agent TEXT",
  ],
];

function migrate(db: DatabaseSync): void {
  const {user_version: current} = db.prepare("PRAGMA user_version").get() as {user_version: number};

  for (let version = current; version < MIGRATIONS.length; version++) {
    for (const statement of MIGRATIONS[version]!) {
      try {
        db.exec(statement);
      } catch (error) {
        // A fresh database already has these columns from SCHEMA, so "duplicate column" is
        // the expected outcome there rather than a fault. Anything else is real.
        if (!String(error).includes("duplicate column")) throw error;
      }
    }
  }

  db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
}

export function openDb(path: string = process.env.TOLLGATE_DB ?? DEFAULT_PATH): DatabaseSync {
  mkdirSync(dirname(path), {recursive: true});
  const db = new DatabaseSync(path);

  // WAL lets the API read while the indexer writes. Without it the two block each other and
  // a page load can stall behind a backfill.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** In-memory, for tests. Same schema, same code paths, no file to clean up. */
export function openMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}
