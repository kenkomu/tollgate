import assert from "node:assert/strict";
import {beforeEach, describe, it} from "node:test";
import type {Address} from "viem";
import {Reason, usdc} from "@tollgate/shared";
import {openMemoryDb} from "../src/db.ts";
import {Store, type StoredEvent} from "../src/store.ts";

const OWNER = "0x8dEa7F60FB144Ea127F6806302E6a83913348B69" as Address;
const PAYEE = "0x3333333333333333333333333333333333333333" as Address;
const PAYEE_B = "0x4444444444444444444444444444444444444444" as Address;

let store: Store;

beforeEach(() => {
  store = new Store(openMemoryDb());
});

function event(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    key: `0xaaa:0`,
    kind: "paid",
    owner: OWNER,
    blockNumber: 100n,
    timestamp: 1_700_000_000,
    txHash: "0xaaa",
    amount: usdc("1"),
    payee: PAYEE,
    ...overrides,
  };
}

describe("idempotent ingestion", () => {
  it("writes an event once", () => {
    assert.equal(store.putEvents([event()]), 1);
    assert.equal(store.eventCount(), 1);
  });

  it("ignores a replay of the same event", () => {
    /**
     * §3.5 requires ingestion keyed by tx_hash + log_index. This is the property that makes
     * recovery from a crashed backfill "run it again" — and the one that stops a reorg or a
     * replayed read from double-counting a payment.
     */
    store.putEvents([event()]);
    assert.equal(store.putEvents([event()]), 0, "a replay must write nothing");
    assert.equal(store.eventCount(), 1);
  });

  it("separates two events from the same transaction", () => {
    store.putEvents([event({key: "0xaaa:0"}), event({key: "0xaaa:1"})]);
    assert.equal(store.eventCount(), 2);
  });

  it("keeps amounts exact through a round trip", () => {
    // Stored as TEXT precisely so this holds. A value above 2^53 in a JS number, or above
    // 2^63 in SQLite's INTEGER, would round — and rounding money is not a display bug.
    const huge = 123_456_789_012_345_678n;
    store.putEvents([event({amount: huge, spentTotal: huge})]);
    const [row] = store.activityFor(OWNER);
    assert.equal(row!.amount, huge);
    assert.equal(row!.spentTotal, huge);
  });

  it("does not leak another owner's events", () => {
    const other = "0x9999999999999999999999999999999999999999" as Address;
    store.putEvents([event(), event({key: "0xbbb:0", owner: other, txHash: "0xbbb"})]);
    assert.equal(store.activityFor(OWNER).length, 1);
    assert.equal(store.activityFor(other).length, 1);
  });

  it("returns newest first", () => {
    store.putEvents([
      event({key: "0xa:0", txHash: "0xa", blockNumber: 10n}),
      event({key: "0xc:0", txHash: "0xc", blockNumber: 30n}),
      event({key: "0xb:0", txHash: "0xb", blockNumber: 20n}),
    ]);
    assert.deepEqual(
      store.activityFor(OWNER).map((e) => e.blockNumber),
      [30n, 20n, 10n],
    );
  });

  it("preserves the refusal reason", () => {
    store.putEvents([event({kind: "refused", reason: Reason.PAYEE_NOT_ALLOWED})]);
    const [row] = store.activityFor(OWNER);
    assert.equal(row!.kind, "refused");
    assert.equal(row!.reason, Reason.PAYEE_NOT_ALLOWED);
  });
});

describe("the indexer cursor", () => {
  it("reports nothing before the first pass", () => {
    // Must be null, not zero. A caller that reads 0 as "start here" would begin at genesis;
    // one that reads it as "already done" would skip all of history.
    assert.equal(store.lastIndexedBlock(), null);
  });

  it("round-trips and advances", () => {
    store.setLastIndexedBlock(55_621_174n);
    assert.equal(store.lastIndexedBlock(), 55_621_174n);
    store.setLastIndexedBlock(55_700_000n);
    assert.equal(store.lastIndexedBlock(), 55_700_000n);
  });
});

describe("block timestamps", () => {
  it("lists blocks still missing a time, then stops listing them", () => {
    store.putEvents([event({timestamp: 0})]);
    assert.deepEqual(store.blocksMissingTime(), [100n]);

    store.setBlockTime(100n, 1_700_000_500);
    assert.deepEqual(store.blocksMissingTime(), []);
    assert.equal(store.activityFor(OWNER)[0]!.timestamp, 1_700_000_500);
  });
});

describe("approvals", () => {
  const request = {
    owner: OWNER,
    serviceId: "weather",
    serviceName: "Weather feed",
    payee: PAYEE,
    amount: "$1.50",
    why: "needed for the forecast bundle",
  };

  it("files a request and lists it as open", () => {
    const filed = store.requestApproval(request);
    assert.ok(filed.id);
    assert.equal(store.openApprovals(OWNER).length, 1);
  });

  it("does not queue the same payee twice", () => {
    // An agent that asks again should not produce a second decision for the owner to make.
    const first = store.requestApproval(request);
    const second = store.requestApproval({...request, why: "asking again"});
    assert.equal(first.id, second.id);
    assert.equal(store.openApprovals(OWNER).length, 1);
  });

  it("resolves out of the queue but stays retrievable by id", () => {
    // The phone deep-links to an id from a notification. That link must still resolve after
    // the request is handled, or tapping a stale notification 404s.
    const filed = store.requestApproval(request);
    assert.equal(store.resolveApproval(filed.id, "approved"), true);
    assert.equal(store.openApprovals(OWNER).length, 0);

    const found = store.approvalById(filed.id);
    assert.equal(found?.outcome, "approved");
    assert.ok(found?.resolvedAt);
  });

  it("cannot be resolved twice", () => {
    const filed = store.requestApproval(request);
    assert.equal(store.resolveApproval(filed.id, "approved"), true);
    assert.equal(store.resolveApproval(filed.id, "declined"), false, "a second resolve must not win");
    assert.equal(store.approvalById(filed.id)?.outcome, "approved");
  });

  it("allows a new request for a different payee", () => {
    store.requestApproval(request);
    store.requestApproval({...request, payee: PAYEE_B});
    assert.equal(store.openApprovals(OWNER).length, 2);
  });
});

describe("devices and the notification cursor", () => {
  it("registers a device and finds it by owner", () => {
    store.registerDevice({token: "abc", owner: OWNER, platform: "android"});
    assert.deepEqual(
      store.devicesFor(OWNER).map((d) => d.token),
      ["abc"],
    );
  });

  it("re-registering the same token does not duplicate it", () => {
    store.registerDevice({token: "abc", owner: OWNER, platform: "android"});
    store.registerDevice({token: "abc", owner: OWNER, platform: "android"});
    assert.equal(store.devicesFor(OWNER).length, 1);
  });

  it("forgets a device", () => {
    store.registerDevice({token: "abc", owner: OWNER, platform: "android"});
    store.forgetDevice("abc");
    assert.equal(store.devicesFor(OWNER).length, 0);
  });

  it("claims an event for a channel exactly once", () => {
    /**
     * The property the whole service exists for. Without it, a restart re-reads the chain,
     * finds the same refusals, and alerts the owner about them again — and a channel that
     * repeats itself gets muted, which means it misses the next real thing.
     */
    assert.equal(store.claimNotification("0xaaa:0", "push"), true);
    assert.equal(store.claimNotification("0xaaa:0", "push"), false);
  });

  it("treats channels independently", () => {
    // The same event can legitimately go to push and to email; one must not suppress the other.
    assert.equal(store.claimNotification("0xaaa:0", "push"), true);
    assert.equal(store.claimNotification("0xaaa:0", "email"), true);
  });
});

describe("owner policy changes survive the round trip", () => {
  it("keeps the label and the values", () => {
    // These arrived after the first schema, so this is also the migration's proof.
    store.putEvents([
      event({
        kind: "caps-changed",
        amount: undefined,
        payee: undefined,
        detail: {label: "budget / per-payment", values: [usdc("20"), usdc("2")]},
      }),
    ]);

    const [row] = store.activityFor(OWNER);
    assert.equal(row!.kind, "caps-changed");
    assert.equal(row!.detail?.label, "budget / per-payment");
    assert.deepEqual(row!.detail?.values, [usdc("20"), usdc("2")]);
  });

  it("keeps caps exact rather than rounding them", () => {
    const odd = 20_000_001n;
    store.putEvents([event({kind: "caps-changed", detail: {label: "x", values: [odd]}})]);
    assert.deepEqual(store.activityFor(OWNER)[0]!.detail?.values, [odd]);
  });

  it("keeps the retired key on a rotation", () => {
    store.putEvents([event({kind: "agent-rotated", previousAgent: PAYEE, payee: undefined})]);
    assert.equal(store.activityFor(OWNER)[0]!.previousAgent?.toLowerCase(), PAYEE.toLowerCase());
  });

  it("leaves detail absent on events that have none", () => {
    store.putEvents([event()]);
    assert.equal(store.activityFor(OWNER)[0]!.detail, undefined);
  });
});

describe("many agents per owner (ADR 0010)", () => {
  const request = {owner: OWNER, serviceId: "s", serviceName: "S", payee: PAYEE, amount: "$1", why: "w"};

  it("keeps one open request per payee per policy, not per owner", () => {
    const a = store.requestApproval({...request, policyId: "1"});
    const again = store.requestApproval({...request, policyId: "1"});
    const b = store.requestApproval({...request, policyId: "2"});
    assert.equal(again.id, a.id, "the same agent asking twice is one decision");
    assert.notEqual(b.id, a.id, "another agent wanting the same payee is another decision");
    assert.equal(store.approvalById(b.id)?.policyId, "2");
  });

  it("stores the policy on every event and reads it back", () => {
    store.putEvents([event({policyId: 3n})]);
    assert.equal(store.activityFor(OWNER)[0]?.policyId, 3n);
  });

  it("drops the index, and only the index, when pointed at another contract", () => {
    assert.equal(store.bindEngine(ENGINE_A), false, "a fresh store has nothing to drop");
    store.putEvents([event()]);
    store.setLastIndexedBlock(10n);
    store.requestApproval(request);
    store.registerDevice({token: "t", owner: OWNER, platform: "android"});

    assert.equal(store.bindEngine(ENGINE_A), false, "same contract: nothing changes");
    assert.equal(store.eventCount(), 1);

    assert.equal(store.bindEngine(ENGINE_B), true);
    assert.equal(store.eventCount(), 0, "the old contract's history is gone");
    assert.equal(store.lastIndexedBlock(), null, "and the walk restarts from the new deployment");
    assert.equal(store.openApprovals(OWNER).length, 1, "requests are kept");
    assert.equal(store.devicesFor(OWNER).length, 1, "devices are kept");
  });

  it("resets a pre-existing index that never recorded its contract", () => {
    store.putEvents([event()]);
    assert.equal(store.bindEngine(ENGINE_A), true);
    assert.equal(store.eventCount(), 0);
  });
});

const ENGINE_A = "0x00000000000000000000000000000000000000e1" as Address;
const ENGINE_B = "0x00000000000000000000000000000000000000e2" as Address;
