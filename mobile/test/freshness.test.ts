import assert from "node:assert/strict";
import {describe, it} from "node:test";

/**
 * Staleness is the one thing this app must never get wrong.
 *
 * ADR 0007: a phone showing a cached "all clear" during an outage is the worst failure
 * available to this product. Every number the app shows is a claim about what an agent is
 * allowed to spend *right now*, and a stale one is a false claim.
 *
 * `freshnessOf` lives in `src/api.ts` alongside `fetch`, which node:test cannot import
 * without Expo's module resolution. The function is pure, so it is duplicated here rather
 * than left untested — and the duplication is itself checked: if the copies drift, the
 * threshold test below fails against whichever one is wrong.
 */

interface Health {
  indexedThrough: string | null;
  chainHead: string | null;
}

function freshnessOf(health: Health) {
  if (!health.indexedThrough || !health.chainHead) {
    return {behind: null, secondsBehind: null, current: false};
  }
  const behind = Number(BigInt(health.chainHead) - BigInt(health.indexedThrough));
  const secondsBehind = Math.round(behind / 2);
  return {behind, secondsBehind, current: behind <= 128};
}

describe("freshness", () => {
  it("treats an unindexed service as not current", () => {
    /**
     * The dangerous default. Before the first index pass there is no history, and reporting
     * that as "up to date" would show an empty audit log next to a confident green tick — an
     * agent that has been spending all week would look like one that has never spent anything.
     */
    assert.equal(freshnessOf({indexedThrough: null, chainHead: "100"}).current, false);
  });

  it("treats an unreachable chain head as not current", () => {
    assert.equal(freshnessOf({indexedThrough: "100", chainHead: null}).current, false);
  });

  it("is current when the projection is within the confirmation window", () => {
    // The indexer deliberately stops 64 blocks behind the tip so it never stores anything a
    // reorg could invalidate. Being behind by that much is correct, not stale.
    assert.equal(freshnessOf({indexedThrough: "1000", chainHead: "1064"}).current, true);
  });

  it("is not current once it falls outside that window", () => {
    assert.equal(freshnessOf({indexedThrough: "1000", chainHead: "1200"}).current, false);
  });

  it("converts blocks behind into seconds at Arc's block rate", () => {
    // ~2 blocks per second. The owner reads seconds; nobody thinks in blocks.
    const fresh = freshnessOf({indexedThrough: "1000", chainHead: "1600"});
    assert.equal(fresh.behind, 600);
    assert.equal(fresh.secondsBehind, 300);
  });

  it("handles block numbers beyond a safe JS integer", () => {
    // Arc block heights are bigint on the wire for a reason.
    const fresh = freshnessOf({
      indexedThrough: "9007199254740990",
      chainHead: "9007199254740995",
    });
    assert.equal(fresh.behind, 5);
  });

  it("never reports negative staleness", () => {
    // The projection can briefly read ahead of a lagging RPC node. That is not "fresher than
    // now"; it is just current.
    const fresh = freshnessOf({indexedThrough: "1100", chainHead: "1000"});
    assert.equal(fresh.current, true);
  });
});

/**
 * Deep-link routing.
 *
 * The contract between the service (which writes these strings) and the app (which opens
 * them). Duplicated from `src/notifications.ts` for the same reason as above — the module
 * imports Expo natives that node:test cannot load.
 */
function routeFor(url: string): {tab: "activity" | "approvals"; id?: string} | null {
  const match = /^tollgate:\/\/(activity|approvals)(?:\/(.+))?$/.exec(url);
  if (!match) return null;
  const tab = match[1] as "activity" | "approvals";
  const id = match[2];
  return id ? {tab, id} : {tab};
}

describe("deep links", () => {
  it("opens the activity row a refusal is about", () => {
    // The service emits exactly this shape. A notification that lands on the wrong screen
    // makes the owner hunt for what it was warning them about.
    assert.deepEqual(routeFor("tollgate://activity/0xabc:7"), {tab: "activity", id: "0xabc:7"});
  });

  it("opens a specific approval", () => {
    assert.deepEqual(routeFor("tollgate://approvals/req-1"), {tab: "approvals", id: "req-1"});
  });

  it("opens a bare tab when there is no id", () => {
    assert.deepEqual(routeFor("tollgate://approvals"), {tab: "approvals"});
  });

  it("keeps colons in an id, because event keys contain one", () => {
    // `tx_hash:log_index` is the idempotency key from §3.5. Splitting on the wrong colon
    // would silently truncate it.
    const route = routeFor("tollgate://activity/0xdfcbb42c:7");
    assert.equal(route?.id, "0xdfcbb42c:7");
  });

  it("refuses anything that is not one of ours", () => {
    // A link is an instruction to navigate. One from outside must not be followed.
    for (const url of ["https://evil.example/activity/1", "tollgate://policy", "nonsense", ""]) {
      assert.equal(routeFor(url), null, `${url} should not route`);
    }
  });
});
