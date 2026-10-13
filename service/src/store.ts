import type {DatabaseSync} from "node:sqlite";
import type {Address} from "viem";
import type {Activity, ActivityKind, Reason} from "@tollgate/shared";

/**
 * Every read and write, in one place.
 *
 * The rest of the service talks to this and never to SQLite directly, which is what makes
 * ADR 0009's "swapping to Postgres is a driver change" claim true rather than aspirational.
 * It is also where the bigint-as-TEXT convention is enforced: amounts cross this boundary as
 * bigint and are stored as decimal strings, so no arithmetic ever happens in a type that can
 * round money.
 */

export interface StoredEvent extends Activity {
  owner: Address;
}

export interface ApprovalRow {
  id: string;
  owner: Address;
  serviceId: string;
  serviceName: string;
  payee: Address;
  amount: string;
  why: string;
  /** Which policy (agent) the payee is wanted for. Null on requests filed before ADR 0010. */
  policyId: string | null;
  agent: Address | null;
  requestedAt: number;
  resolvedAt: number | null;
  outcome: "approved" | "declined" | null;
}

export interface DeviceRow {
  token: string;
  owner: Address;
  platform: string;
}

const asBigint = (value: unknown): bigint | undefined =>
  value === null || value === undefined ? undefined : BigInt(String(value));

const asText = (value: bigint | undefined): string | null =>
  value === undefined ? null : value.toString();

export class Store {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /*//////////////////////////////////////////////////////////////
                              INDEXING
  //////////////////////////////////////////////////////////////*/

  /**
   * Insert events, ignoring ones already present.
   *
   * `INSERT OR IGNORE` against the `(tx_hash, log_index)` primary key is the whole
   * idempotency story. Re-running the backfill over a range already indexed is a no-op, which
   * means recovery from a crash mid-walk is "run it again" rather than "work out where it
   * stopped".
   */
  putEvents(events: readonly StoredEvent[]): number {
    if (events.length === 0) return 0;

    const insert = this.#db.prepare(`
      INSERT OR IGNORE INTO events
        (tx_hash, log_index, kind, owner, agent, payee, amount, spent_total, reason,
         detail_label, detail_values, previous_agent, policy_id, block_number, block_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let written = 0;
    // One transaction for the batch. Twenty thousand single-row commits is how a backfill
    // takes minutes instead of seconds.
    this.#db.exec("BEGIN");
    try {
      for (const event of events) {
        const [txHash = "", logIndexRaw = "0"] = event.key.split(":");
        const result = insert.run(
          txHash,
          Number(logIndexRaw),
          event.kind,
          event.owner.toLowerCase(),
          event.agent?.toLowerCase() ?? null,
          event.payee?.toLowerCase() ?? null,
          asText(event.amount),
          asText(event.spentTotal),
          event.reason ?? null,
          event.detail?.label ?? null,
          // Comma-separated decimal strings, for the same reason amounts are TEXT: these are
          // caps and rates, and a type that can round is not one money goes in.
          event.detail ? event.detail.values.map(String).join(",") : null,
          event.previousAgent?.toLowerCase() ?? null,
          asText(event.policyId),
          Number(event.blockNumber),
          event.timestamp,
        );
        written += Number(result.changes);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }

    return written;
  }

  /** Backfill timestamps for blocks indexed before their time was known. */
  setBlockTime(blockNumber: bigint, timestamp: number): void {
    this.#db
      .prepare("UPDATE events SET block_time = ? WHERE block_number = ? AND block_time = 0")
      .run(timestamp, Number(blockNumber));
  }

  /**
   * Distinct blocks still missing a timestamp.
   *
   * A log does not carry its block's time, so rows land with 0 and are filled afterwards.
   * Bounded because a large backfill would otherwise issue one RPC call per block in a single
   * pass and get rate-limited; the remainder is picked up on the next poll.
   */
  blocksMissingTime(limit = 200): bigint[] {
    const rows = this.#db
      .prepare(
        "SELECT DISTINCT block_number FROM events WHERE block_time = 0 ORDER BY block_number DESC LIMIT ?",
      )
      .all(limit) as {block_number: number}[];
    return rows.map((row) => BigInt(row.block_number));
  }

  activityFor(owner: Address, limit = 200): Activity[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM events WHERE owner = ? ORDER BY block_number DESC, log_index DESC LIMIT ?`,
      )
      .all(owner.toLowerCase(), limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      key: `${String(row.tx_hash)}:${Number(row.log_index)}`,
      kind: String(row.kind) as ActivityKind,
      blockNumber: BigInt(Number(row.block_number)),
      timestamp: Number(row.block_time),
      txHash: String(row.tx_hash),
      amount: asBigint(row.amount),
      payee: (row.payee as Address | null) ?? undefined,
      agent: (row.agent as Address | null) ?? undefined,
      spentTotal: asBigint(row.spent_total),
      reason: row.reason === null ? undefined : (Number(row.reason) as Reason),
      detail:
        row.detail_label === null || row.detail_label === undefined
          ? undefined
          : {
              label: String(row.detail_label),
              values: String(row.detail_values ?? "")
                .split(",")
                .filter((part) => part.length > 0)
                .map((part) => BigInt(part)),
            },
      previousAgent: (row.previous_agent as Address | null) ?? undefined,
      policyId: asBigint(row.policy_id),
    }));
  }

  /**
   * Point the index at a contract, dropping everything indexed from a different one.
   *
   * The events table and cursor describe one deployment. After a redeploy (ADR 0010 was
   * one) the old rows would mix two contracts' histories and the cursor would sit past the
   * new contract's first block, silently skipping it. Both are rebuildable from chain, so they
   * are dropped; approvals, devices and delivery records are ours alone and are kept.
   *
   * Returns true when the index was reset.
   */
  bindEngine(engine: Address): boolean {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'engine'").get() as {value: string} | undefined;
    const next = engine.toLowerCase();
    if (row?.value === next) return false;

    const hadHistory = row !== undefined || this.eventCount() > 0 || this.lastIndexedBlock() !== null;
    this.#db.exec("BEGIN");
    try {
      if (hadHistory) {
        this.#db.exec("DELETE FROM events");
        this.#db.exec("DELETE FROM cursor");
      }
      this.#db
        .prepare(
          `INSERT INTO meta (key, value) VALUES ('engine', ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        )
        .run(next);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return hadHistory;
  }

  eventCount(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM events").get() as {n: number};
    return Number(row.n);
  }

  /*//////////////////////////////////////////////////////////////
                              CURSOR
  //////////////////////////////////////////////////////////////*/

  /**
   * How far the indexer has walked.
   *
   * Deliberately conservative on read: a missing cursor returns null and the caller starts
   * from the deployment block. Guessing a later start would silently skip history, which is
   * the failure this project has already been bitten by once.
   */
  lastIndexedBlock(): bigint | null {
    const row = this.#db.prepare("SELECT last_block FROM cursor WHERE id = 1").get() as
      | {last_block: number}
      | undefined;
    return row ? BigInt(row.last_block) : null;
  }

  setLastIndexedBlock(block: bigint): void {
    this.#db
      .prepare(
        `INSERT INTO cursor (id, last_block) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET last_block = excluded.last_block`,
      )
      .run(Number(block));
  }

  /*//////////////////////////////////////////////////////////////
                             APPROVALS
  //////////////////////////////////////////////////////////////*/

  openApprovals(owner: Address): ApprovalRow[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM approvals WHERE owner = ? AND resolved_at IS NULL ORDER BY requested_at ASC`,
      )
      .all(owner.toLowerCase()) as Record<string, unknown>[];
    return rows.map(toApproval);
  }

  approvalById(id: string): ApprovalRow | null {
    const row = this.#db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toApproval(row) : null;
  }

  /**
   * File a request, or return the one already open for this payee.
   *
   * An agent that asks twice must not queue twice — the owner should see one decision to
   * make, not a growing list of the same one.
   */
  requestApproval(
    request: Omit<ApprovalRow, "id" | "requestedAt" | "resolvedAt" | "outcome" | "policyId" | "agent"> & {
      policyId?: string | null;
      agent?: Address | null;
    },
  ): ApprovalRow {
    const input = {...request, policyId: request.policyId ?? null, agent: request.agent ?? null};
    // One open request per payee *per policy*: two agents wanting the same supplier are two
    // decisions, because allowlists are per policy (ADR 0010).
    const existing = this.#db
      .prepare(
        `SELECT * FROM approvals
         WHERE owner = ? AND payee = ? AND COALESCE(policy_id, '') = ? AND resolved_at IS NULL LIMIT 1`,
      )
      .get(input.owner.toLowerCase(), input.payee.toLowerCase(), input.policyId ?? "") as
      | Record<string, unknown>
      | undefined;
    if (existing) return toApproval(existing);

    // The policy is part of the id: two agents can ask for the same payee in the same
    // millisecond, and those are two requests.
    const id = `${Date.now().toString(36)}-${input.payee.slice(2, 10).toLowerCase()}${input.policyId ? `-p${input.policyId}` : ""}`;
    const requestedAt = Date.now();

    this.#db
      .prepare(
        `INSERT INTO approvals
           (id, owner, service_id, service_name, payee, amount, why, policy_id, agent, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.owner.toLowerCase(),
        input.serviceId,
        input.serviceName,
        input.payee.toLowerCase(),
        input.amount,
        input.why,
        input.policyId,
        input.agent?.toLowerCase() ?? null,
        requestedAt,
      );

    return {...input, id, requestedAt, resolvedAt: null, outcome: null};
  }

  /**
   * Close a request.
   *
   * Note what this does *not* do: allowlist anybody. The allowlist is on chain and only the
   * owner's signature changes it. This records that a human made a decision; the decision
   * itself is a transaction.
   */
  resolveApproval(id: string, outcome: "approved" | "declined"): boolean {
    const result = this.#db
      .prepare("UPDATE approvals SET resolved_at = ?, outcome = ? WHERE id = ? AND resolved_at IS NULL")
      .run(Date.now(), outcome, id);
    return Number(result.changes) > 0;
  }

  /*//////////////////////////////////////////////////////////////
                        DEVICES + NOTIFICATIONS
  //////////////////////////////////////////////////////////////*/

  registerDevice(device: DeviceRow): void {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO devices (token, owner, platform, registered_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (token) DO UPDATE SET owner = excluded.owner, last_seen_at = excluded.last_seen_at`,
      )
      .run(device.token, device.owner.toLowerCase(), device.platform, now, now);
  }

  devicesFor(owner: Address): DeviceRow[] {
    const rows = this.#db
      .prepare("SELECT token, owner, platform FROM devices WHERE owner = ?")
      .all(owner.toLowerCase()) as Record<string, unknown>[];
    return rows.map((row) => ({
      token: String(row.token),
      owner: row.owner as Address,
      platform: String(row.platform),
    }));
  }

  forgetDevice(token: string): void {
    this.#db.prepare("DELETE FROM devices WHERE token = ?").run(token);
  }

  /**
   * Claim an event for delivery on a channel.
   *
   * Returns false if it was already claimed. This is the whole reason the service exists:
   * without it, every restart re-reads the chain, finds the same refusals, and notifies the
   * owner about them again. Waking someone at 3am to tell them about a payment that was
   * blocked last Tuesday is how a product gets its notifications turned off.
   */
  claimNotification(eventKey: string, channel: string): boolean {
    const result = this.#db
      .prepare("INSERT OR IGNORE INTO notified (event_key, channel, sent_at) VALUES (?, ?, ?)")
      .run(eventKey, channel, Date.now());
    return Number(result.changes) > 0;
  }
}

function toApproval(row: Record<string, unknown>): ApprovalRow {
  return {
    id: String(row.id),
    owner: row.owner as Address,
    serviceId: String(row.service_id),
    serviceName: String(row.service_name),
    payee: row.payee as Address,
    amount: String(row.amount),
    why: String(row.why),
    policyId: row.policy_id === null || row.policy_id === undefined ? null : String(row.policy_id),
    agent: (row.agent as Address | null) ?? null,
    requestedAt: Number(row.requested_at),
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    outcome: (row.outcome as "approved" | "declined" | null) ?? null,
  };
}
