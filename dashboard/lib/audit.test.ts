import assert from "node:assert/strict";
import {describe as suite, it} from "node:test";
import type {Address} from "viem";
import {MAX_LOG_BLOCK_RANGE, Reason, usdc} from "@tollgate/shared";
import {describe, planWindows, projectAuditLog, reasonText, type EngineLog} from "./audit.ts";

const OWNER = "0x8dEa7F60FB144Ea127F6806302E6a83913348B69" as Address;
const OTHER = "0x1111111111111111111111111111111111111111" as Address;
const AGENT = "0x2222222222222222222222222222222222222222" as Address;
const PAYEE_A = "0x3333333333333333333333333333333333333333" as Address;
const PAYEE_B = "0x4444444444444444444444444444444444444444" as Address;

let logIndex = 0;
function log(eventName: string, args: Record<string, unknown>, blockNumber: bigint): EngineLog {
  return {
    eventName,
    args: {owner: OWNER, ...args},
    blockNumber,
    transactionHash: `0x${String(blockNumber).padStart(64, "0")}`,
    logIndex: logIndex++,
  };
}

suite("planWindows", () => {
  const DEPLOY = 1_000_000n;

  it("covers the whole range from deployment to head", () => {
    const head = DEPLOY + MAX_LOG_BLOCK_RANGE * 3n;
    const windows = planWindows(DEPLOY, head);

    assert.equal(windows[0]!.from, DEPLOY);
    assert.equal(windows.at(-1)!.to, head, "the last window must reach the head");

    // No gaps: each window starts exactly one block after the previous one ends. A gap here
    // silently drops payments out of the owner's history and nothing errors.
    for (let i = 1; i < windows.length; i++) {
      assert.equal(windows[i]!.from, windows[i - 1]!.to + 1n, `gap before window ${i}`);
    }
  });

  it("never asks for more blocks than Arc will serve", () => {
    const windows = planWindows(DEPLOY, DEPLOY + MAX_LOG_BLOCK_RANGE * 5n + 77n);
    for (const w of windows) {
      assert.ok(w.to - w.from < MAX_LOG_BLOCK_RANGE, `window ${w.from}-${w.to} is too wide`);
      assert.ok(w.to >= w.from, "window is inverted");
    }
  });

  it("clamps the final window to the head rather than reading past it", () => {
    const head = DEPLOY + 500n;
    const windows = planWindows(DEPLOY, head);
    assert.equal(windows.length, 1);
    assert.deepEqual(windows[0], {from: DEPLOY, to: head});
  });

  it("keeps window bounds stable as the head advances", () => {
    /**
     * The cache key is `from:to`. Anchoring the grid to the moving head instead of the
     * deployment block would renumber every window each time Arc produced a block — which at
     * sub-second finality means the cache never hits and every load re-reads all of history.
     */
    const first = planWindows(DEPLOY, DEPLOY + MAX_LOG_BLOCK_RANGE * 2n);
    const later = planWindows(DEPLOY, DEPLOY + MAX_LOG_BLOCK_RANGE * 2n + 3_000n);

    for (let i = 0; i < first.length - 1; i++) {
      assert.deepEqual(later[i], first[i], `window ${i} moved when the head advanced`);
    }
  });

  it("drops windows entirely outside the history horizon", () => {
    // Beyond the horizon, reading history on every page load stops being reasonable; the
    // answer is the indexer, and until it exists the UI shows recent history and says so.
    const maxHistory = MAX_LOG_BLOCK_RANGE * 2n;
    const head = DEPLOY + MAX_LOG_BLOCK_RANGE * 10n;
    const windows = planWindows(DEPLOY, head, maxHistory);

    assert.ok(windows.length <= 4, `expected a bounded walk, got ${windows.length} windows`);
    for (const w of windows) {
      assert.ok(w.to >= head - maxHistory, "kept a window with nothing inside the horizon");
    }
  });

  it("returns nothing when the contract is newer than the head", () => {
    assert.deepEqual(planWindows(DEPLOY, DEPLOY - 1n), []);
  });
});

suite("projectAuditLog", () => {
  it("ignores events belonging to another owner", () => {
    const logs: EngineLog[] = [
      log("Spent", {agent: AGENT, payee: PAYEE_A, amount: usdc("1")}, 10n),
      {...log("Spent", {agent: AGENT, payee: PAYEE_A, amount: usdc("99")}, 11n), args: {owner: OTHER}},
    ];
    const audit = projectAuditLog(logs, OWNER);
    assert.equal(audit.entries.length, 1);
    assert.equal(audit.entries[0]!.amount, usdc("1"));
  });

  it("matches an owner regardless of address casing", () => {
    const logs = [log("Spent", {owner: OWNER.toLowerCase(), amount: usdc("1")}, 10n)];
    assert.equal(projectAuditLog(logs, OWNER).entries.length, 1);
  });

  it("carries the reason through on a refusal", () => {
    // The product's central claim is that it stops things. This is where the evidence for
    // that claim is assembled, so losing the reason code would hollow it out.
    const logs = [
      log("Refused", {agent: AGENT, payee: PAYEE_A, amount: usdc("5"), reason: Reason.PAYEE_NOT_ALLOWED}, 10n),
    ];
    const entry = projectAuditLog(logs, OWNER).entries[0]!;
    assert.equal(entry.kind, "refused");
    assert.equal(entry.reason, Reason.PAYEE_NOT_ALLOWED);
    assert.equal(reasonText(entry.reason!), "Payee is not on your allowlist");
  });

  it("orders newest first", () => {
    const logs = [
      log("Spent", {amount: usdc("1")}, 10n),
      log("Spent", {amount: usdc("2")}, 30n),
      log("Spent", {amount: usdc("3")}, 20n),
    ];
    const blocks = projectAuditLog(logs, OWNER).entries.map((e) => e.blockNumber);
    assert.deepEqual(blocks, [30n, 20n, 10n]);
  });

  it("gives every entry a distinct idempotency key", () => {
    // §3.5: keyed by tx_hash + log_index, so a reorg or replayed read cannot double-count.
    const logs = [
      log("Spent", {amount: usdc("1")}, 10n),
      log("Spent", {amount: usdc("1")}, 10n),
    ];
    const keys = projectAuditLog(logs, OWNER).entries.map((e) => e.key);
    assert.equal(new Set(keys).size, 2);
  });

  suite("allowlist folding", () => {
    it("keeps only payees whose last event allowed them", () => {
      const logs = [
        log("PayeeSet", {payee: PAYEE_A, allowed: true}, 10n),
        log("PayeeSet", {payee: PAYEE_B, allowed: true}, 11n),
        log("PayeeSet", {payee: PAYEE_A, allowed: false}, 12n),
      ];
      assert.deepEqual(projectAuditLog(logs, OWNER).allowedPayees, [PAYEE_B]);
    });

    it("re-adds a payee that was removed and approved again", () => {
      const logs = [
        log("PayeeSet", {payee: PAYEE_A, allowed: true}, 10n),
        log("PayeeSet", {payee: PAYEE_A, allowed: false}, 11n),
        log("PayeeSet", {payee: PAYEE_A, allowed: true}, 12n),
      ];
      assert.deepEqual(projectAuditLog(logs, OWNER).allowedPayees, [PAYEE_A]);
    });

    it("records both the approval and the removal in the feed", () => {
      const logs = [
        log("PayeeSet", {payee: PAYEE_A, allowed: true}, 10n),
        log("PayeeSet", {payee: PAYEE_A, allowed: false}, 11n),
      ];
      const kinds = projectAuditLog(logs, OWNER).entries.map((e) => e.kind);
      assert.deepEqual(kinds, ["payee-removed", "payee-allowed"]);
    });
  });

  suite("pause state", () => {
    it("reflects the most recent pause event", () => {
      const logs = [
        log("PauseSet", {paused: true}, 10n),
        log("PauseSet", {paused: false}, 11n),
      ];
      assert.equal(projectAuditLog(logs, OWNER).paused, false);
    });

    it("is paused when the last event paused it", () => {
      const logs = [
        log("PauseSet", {paused: false}, 10n),
        log("PauseSet", {paused: true}, 11n),
      ];
      assert.equal(projectAuditLog(logs, OWNER).paused, true);
    });

    it("defaults to running when nothing ever paused it", () => {
      assert.equal(projectAuditLog([], OWNER).paused, false);
    });
  });

  it("ignores an event type it does not know", () => {
    // A contract deployed ahead of this dashboard emits events we have no case for. Dropping
    // them is correct; throwing would take the whole audit log down over a cosmetic gap.
    const logs = [log("SomethingNew", {value: 1n}, 10n), log("Spent", {amount: usdc("1")}, 11n)];
    const audit = projectAuditLog(logs, OWNER);
    assert.equal(audit.entries.length, 1);
    assert.equal(audit.entries[0]!.kind, "paid");
  });

  it("leaves timestamps for the caller to fill", () => {
    const audit = projectAuditLog([log("Spent", {amount: usdc("1")}, 10n)], OWNER);
    assert.equal(audit.entries[0]!.timestamp, 0);
  });
});

suite("describe", () => {
  it("has plain English for every kind, with no jargon", () => {
    const kinds = [
      "paid",
      "refused",
      "payee-allowed",
      "payee-removed",
      "paused",
      "resumed",
      "policy-created",
    ] as const;

    for (const kind of kinds) {
      const text = describe({kind, key: "", blockNumber: 0n, timestamp: 0, txHash: "0x"});
      assert.ok(text.length > 0, `${kind} has no description`);
      assert.doesNotMatch(text, /_|0x|revert/, `${kind} leaks jargon: ${text}`);
    }
  });
});
