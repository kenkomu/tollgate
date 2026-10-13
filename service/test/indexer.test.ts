import assert from "node:assert/strict";
import {beforeEach, describe, it} from "node:test";
import {encodeEventTopics, type Address, type PublicClient} from "viem";
import {MAX_LOG_BLOCK_RANGE, policyEngineAbi, usdc} from "@tollgate/shared";
import {openMemoryDb} from "../src/db.ts";
import {Indexer} from "../src/indexer.ts";
import {Store} from "../src/store.ts";

const OWNER = "0x8dEa7F60FB144Ea127F6806302E6a83913348B69" as Address;
const AGENT = "0x9D5b48C4816eeE783522e4aADAaf7453940b92f1" as Address;
const ENGINE = "0x8168eb562496A966f339a4bD165B924EeDce9873" as Address;
const PAYEE = "0x3333333333333333333333333333333333333333" as Address;

const DEPLOY = 1_000_000n;

/** A `Spent` log as the node would return it, encoded so viem really decodes it. */
function spentLog(blockNumber: bigint, logIndex: number, amount: bigint) {
  const topics = encodeEventTopics({
    abi: policyEngineAbi,
    eventName: "Spent",
    args: {owner: OWNER, agent: AGENT, payee: PAYEE},
  });

  // Non-indexed args, ABI-encoded: amount, spentTotal, availableAfter.
  const word = (value: bigint) => value.toString(16).padStart(64, "0");
  return {
    address: ENGINE,
    topics,
    data: `0x${word(amount)}${word(amount)}${word(usdc("4"))}` as `0x${string}`,
    blockNumber,
    blockHash: `0x${"11".repeat(32)}` as `0x${string}`,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}` as `0x${string}`,
    transactionIndex: 0,
    logIndex,
    removed: false,
  };
}

interface StubChain {
  head: bigint;
  logs: ReturnType<typeof spentLog>[];
  /** Every getLogs range the indexer asked for, in order. */
  ranges: {from: bigint; to: bigint}[];
  blockCalls: bigint[];
}

function stubClient(chain: StubChain): PublicClient {
  return {
    getBlockNumber: async () => chain.head,
    getLogs: async ({fromBlock, toBlock}: {fromBlock: bigint; toBlock: bigint}) => {
      chain.ranges.push({from: fromBlock, to: toBlock});
      return chain.logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
    },
    getBlock: async ({blockNumber}: {blockNumber: bigint}) => {
      chain.blockCalls.push(blockNumber);
      return {timestamp: 1_700_000_000n + blockNumber};
    },
  } as unknown as PublicClient;
}

let store: Store;
let chain: StubChain;
let indexer: Indexer;

beforeEach(() => {
  process.env.POLICY_ENGINE_DEPLOY_BLOCK = String(DEPLOY);
  store = new Store(openMemoryDb());
  chain = {head: DEPLOY + 1_000n, logs: [], ranges: [], blockCalls: []};
  indexer = new Indexer({
    engine: ENGINE,
    owner: OWNER,
    store,
    client: stubClient(chain),
    confirmations: 64n,
  });
});

describe("walking the chain", () => {
  it("starts at the deployment block on a cold store", async () => {
    await indexer.catchUp();
    assert.equal(chain.ranges[0]?.from, DEPLOY);
  });

  it("indexes events it finds", async () => {
    chain.logs = [spentLog(DEPLOY + 10n, 0, usdc("1.50"))];
    const result = await indexer.catchUp();

    assert.equal(result.written, 1);
    const [entry] = store.activityFor(OWNER);
    assert.equal(entry!.kind, "paid");
    assert.equal(entry!.amount, usdc("1.50"));
    assert.equal(entry!.payee?.toLowerCase(), PAYEE.toLowerCase());
  });

  it("stops short of the unconfirmed tip", async () => {
    /**
     * Nothing in this table can be deleted, so nothing that a reorg could invalidate may go
     * in it. Stopping `confirmations` behind the head keeps the invariant simple: everything
     * stored is final. The dashboard covers the gap by reading the last blocks from chain.
     */
    await indexer.catchUp();
    const last = chain.ranges.at(-1)!;
    assert.equal(last.to, chain.head - 64n);
    assert.equal(store.lastIndexedBlock(), chain.head - 64n);
  });

  it("resumes from the cursor rather than re-reading history", async () => {
    await indexer.catchUp();
    const stoppedAt = store.lastIndexedBlock();
    assert.ok(stoppedAt !== null);

    chain.head += 500n;
    chain.ranges.length = 0;
    await indexer.catchUp();

    // Exactly one block past where the last pass finished: no gap, and no overlap.
    assert.equal(chain.ranges[0]?.from, stoppedAt + 1n);
  });

  it("does nothing when there is nothing new", async () => {
    await indexer.catchUp();
    chain.ranges.length = 0;

    const result = await indexer.catchUp();
    assert.equal(result.written, 0);
    assert.equal(chain.ranges.length, 0, "should not have asked the node anything");
  });

  it("re-indexing the same range writes nothing", async () => {
    // Recovery from a crashed backfill is "run it again". That is only true if a replay is
    // free, which is what the (tx_hash, log_index) primary key buys.
    chain.logs = [spentLog(DEPLOY + 10n, 0, usdc("1"))];
    await indexer.catchUp();

    store.setLastIndexedBlock(DEPLOY - 1n); // pretend the cursor was lost
    const second = await indexer.catchUp();

    assert.equal(second.written, 0);
    assert.equal(store.eventCount(), 1);
  });

  it("never asks for a range wider than Arc will serve", async () => {
    chain.head = DEPLOY + MAX_LOG_BLOCK_RANGE * 3n;
    await indexer.catchUp();

    for (const range of chain.ranges) {
      assert.ok(range.to - range.from < MAX_LOG_BLOCK_RANGE, `range ${range.from}-${range.to} too wide`);
    }
  });

  it("advances the cursor per window, not once at the end", async () => {
    /**
     * A crash halfway through a long backfill should resume near where it stopped. If the
     * cursor only moved at the end, a failure on the last window would throw away the whole
     * walk — which on a cold start is the entire history.
     */
    chain.head = DEPLOY + MAX_LOG_BLOCK_RANGE * 3n;
    let calls = 0;
    const failing = stubClient(chain);
    const original = failing.getLogs.bind(failing);
    // Persistent from the third call on: a one-off failure is now absorbed by splitting the
    // window (readLogsSplitting), so only an endpoint that stays down should reject the walk.
    (failing as {getLogs: unknown}).getLogs = async (args: never) => {
      if (++calls >= 3) throw new Error("rate limited");
      return original(args);
    };

    const flaky = new Indexer({engine: ENGINE, owner: OWNER, store, client: failing, confirmations: 64n});
    await assert.rejects(() => flaky.catchUp());

    assert.ok(store.lastIndexedBlock() !== null, "cursor should have advanced before the failure");
    assert.ok(store.lastIndexedBlock()! > DEPLOY);
  });

  it("survives a window the endpoint refuses, by splitting it", async () => {
    chain.head = DEPLOY + MAX_LOG_BLOCK_RANGE * 2n;
    chain.logs = [spentLog(DEPLOY + 10n, 0, usdc("1"))];
    const picky = stubClient(chain);
    const original = picky.getLogs.bind(picky);
    (picky as {getLogs: unknown}).getLogs = async (args: {fromBlock: bigint; toBlock: bigint}) => {
      if (args.toBlock - args.fromBlock + 1n > 1_000n) throw new Error("RPC Request failed.");
      return original(args as never);
    };

    const indexer = new Indexer({engine: ENGINE, owner: OWNER, store, client: picky, confirmations: 64n});
    const result = await indexer.catchUp();
    assert.equal(result.written, 1);
  });
});

describe("block timestamps", () => {
  it("fills them in and asks for each block only once", async () => {
    chain.logs = [spentLog(DEPLOY + 10n, 0, usdc("1")), spentLog(DEPLOY + 10n, 1, usdc("2"))];
    await indexer.catchUp();

    assert.deepEqual(chain.blockCalls, [DEPLOY + 10n], "one call for two events in one block");
    assert.equal(store.activityFor(OWNER)[0]!.timestamp, Number(1_700_000_000n + DEPLOY + 10n));
    assert.deepEqual(store.blocksMissingTime(), []);
  });

  it("does not lose the event when the timestamp read fails", async () => {
    // A missing timestamp degrades the display. It must never cost us the record.
    const failing = stubClient(chain);
    (failing as {getBlock: unknown}).getBlock = async () => {
      throw new Error("rate limited");
    };
    chain.logs = [spentLog(DEPLOY + 10n, 0, usdc("1"))];

    const tolerant = new Indexer({engine: ENGINE, owner: OWNER, store, client: failing, confirmations: 64n});
    await tolerant.catchUp();

    assert.equal(store.eventCount(), 1);
    assert.equal(store.activityFor(OWNER)[0]!.timestamp, 0);
    assert.deepEqual(store.blocksMissingTime(), [DEPLOY + 10n], "still queued for a later pass");
  });
});

describe("the store is rebuildable from chain", () => {
  it("produces the same rows after being dropped entirely", async () => {
    /**
     * ADR 0006's central rule, tested rather than asserted: this database is a cache, and
     * deleting it must cost nothing but time. If this ever fails, something in here has
     * become authoritative and the whole no-database argument is void.
     */
    chain.logs = [
      spentLog(DEPLOY + 10n, 0, usdc("1")),
      spentLog(DEPLOY + 20n, 0, usdc("2")),
      spentLog(DEPLOY + 30n, 0, usdc("3")),
    ];
    await indexer.catchUp();
    const before = store.activityFor(OWNER);

    const rebuilt = new Store(openMemoryDb());
    const second = new Indexer({
      engine: ENGINE,
      owner: OWNER,
      store: rebuilt,
      client: stubClient(chain),
      confirmations: 64n,
    });
    await second.catchUp();

    assert.deepEqual(rebuilt.activityFor(OWNER), before);
  });
});

describe("pacing the public endpoint", () => {
  it("does not fire every window at once", async () => {
    /**
     * Arc's public RPC answers a burst of `eth_getLogs` with -32005, and a cold start is two
     * dozen of them. Unpaced, the backfill rate-limits itself into a stall — observed on a
     * live run before this was added.
     */
    chain.head = DEPLOY + MAX_LOG_BLOCK_RANGE * 3n;
    const started = Date.now();
    await indexer.catchUp();
    const elapsed = Date.now() - started;

    assert.ok(chain.ranges.length >= 3, "expected a multi-window walk");
    assert.ok(elapsed >= (chain.ranges.length - 1) * 200, `walk took ${elapsed}ms — too fast to be paced`);
  });
});
