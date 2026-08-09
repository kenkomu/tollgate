import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after, before, describe, it} from "node:test";
import type {Address} from "viem";
import {openDb} from "../src/db.ts";
import {Store} from "../src/store.ts";

/**
 * Migrations must not destroy what cannot be rebuilt.
 *
 * The `events` table is a projection — drop it, re-index, and you are whole. `devices` and
 * `approvals` are not. A device token exists nowhere else in the world, and losing one stops a
 * phone receiving alerts with no error raised anywhere: the owner simply stops being told when
 * their agent is blocked, and finds out when they next open the app. That is the quietest
 * possible failure in a product whose job is to tell people things.
 *
 * So this walks a real v1 database through the upgrade and checks nothing was lost.
 */

const OWNER = "0x8dEa7F60FB144Ea127F6806302E6a83913348B69" as Address;
const PAYEE = "0x3333333333333333333333333333333333333333" as Address;

/** The schema exactly as v1 shipped it, before owner policy changes were recorded. */
const V1_SCHEMA = `
CREATE TABLE events (
  tx_hash      TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  owner        TEXT    NOT NULL,
  agent        TEXT,
  payee        TEXT,
  amount       TEXT,
  spent_total  TEXT,
  reason       INTEGER,
  block_number INTEGER NOT NULL,
  block_time   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE TABLE cursor (id INTEGER PRIMARY KEY CHECK (id = 1), last_block INTEGER NOT NULL);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, service_id TEXT NOT NULL,
  service_name TEXT NOT NULL, payee TEXT NOT NULL, amount TEXT NOT NULL,
  why TEXT NOT NULL, requested_at INTEGER NOT NULL, resolved_at INTEGER, outcome TEXT
);
CREATE TABLE devices (
  token TEXT PRIMARY KEY, owner TEXT NOT NULL, platform TEXT NOT NULL,
  registered_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE notified (
  event_key TEXT NOT NULL, channel TEXT NOT NULL, sent_at INTEGER NOT NULL,
  PRIMARY KEY (event_key, channel)
);
`;

let dir: string;
let path: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "tollgate-migration-"));
  path = join(dir, "v1.db");

  const old = new DatabaseSync(path);
  old.exec(V1_SCHEMA);
  old
    .prepare(
      `INSERT INTO events (tx_hash, log_index, kind, owner, payee, amount, block_number, block_time)
       VALUES ('0xaaa', 0, 'paid', ?, ?, '1000000', 100, 1700000000)`,
    )
    .run(OWNER.toLowerCase(), PAYEE.toLowerCase());
  old.prepare("INSERT INTO cursor (id, last_block) VALUES (1, 55700000)").run();
  old
    .prepare(
      `INSERT INTO devices (token, owner, platform, registered_at, last_seen_at)
       VALUES ('phone-token', ?, 'android', 1, 1)`,
    )
    .run(OWNER.toLowerCase());
  old
    .prepare(
      `INSERT INTO approvals (id, owner, service_id, service_name, payee, amount, why, requested_at)
       VALUES ('req-1', ?, 'weather', 'Weather feed', ?, '$1.50', 'because', 1)`,
    )
    .run(OWNER.toLowerCase(), PAYEE.toLowerCase());
  old.prepare("INSERT INTO notified (event_key, channel, sent_at) VALUES ('0xaaa:0', 'push', 1)").run();
  old.close();
});

after(() => {
  rmSync(dir, {recursive: true, force: true});
});

describe("upgrading a v1 database", () => {
  it("adds the new columns without touching the rows", () => {
    const db = openDb(path);

    const columns = (db.prepare("PRAGMA table_info(events)").all() as {name: string}[]).map((c) => c.name);
    assert.ok(columns.includes("detail_label"));
    assert.ok(columns.includes("detail_values"));
    assert.ok(columns.includes("previous_agent"));

    const {n} = db.prepare("SELECT COUNT(*) AS n FROM events").get() as {n: number};
    assert.equal(n, 1, "existing events must survive");
    db.close();
  });

  it("keeps the indexer cursor, so it does not re-walk all of history", () => {
    const db = openDb(path);
    assert.equal(new Store(db).lastIndexedBlock(), 55_700_000n);
    db.close();
  });

  it("keeps registered devices", () => {
    // The one that cannot be rebuilt from anywhere. Losing it is silent.
    const db = openDb(path);
    assert.deepEqual(
      new Store(db).devicesFor(OWNER).map((d) => d.token),
      ["phone-token"],
    );
    db.close();
  });

  it("keeps open approvals", () => {
    const db = openDb(path);
    assert.equal(new Store(db).openApprovals(OWNER).length, 1);
    db.close();
  });

  it("keeps the notification claims, so an upgrade does not re-alert", () => {
    // Otherwise every deploy replays the entire history of refusals at the owner.
    const db = openDb(path);
    assert.equal(new Store(db).claimNotification("0xaaa:0", "push"), false);
    db.close();
  });

  it("is idempotent — opening twice more changes nothing", () => {
    for (let i = 0; i < 2; i++) {
      const db = openDb(path);
      const {n} = db.prepare("SELECT COUNT(*) AS n FROM events").get() as {n: number};
      assert.equal(n, 1);
      db.close();
    }
  });

  it("leaves a fresh database at the same version as a migrated one", () => {
    /**
     * The trap this guards: a schema that creates the current shape, and migrations that
     * bring an old database to it, drifting apart. Both paths must end in the same place or
     * the next migration applies to only one of them.
     */
    const freshPath = join(dir, "fresh.db");
    const fresh = openDb(freshPath);
    const migrated = openDb(path);

    const version = (db: DatabaseSync) =>
      (db.prepare("PRAGMA user_version").get() as {user_version: number}).user_version;
    const columns = (db: DatabaseSync) =>
      (db.prepare("PRAGMA table_info(events)").all() as {name: string}[]).map((c) => c.name).sort();

    assert.equal(version(fresh), version(migrated));
    assert.deepEqual(columns(fresh), columns(migrated));

    fresh.close();
    migrated.close();
  });
});
