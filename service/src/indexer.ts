import {createPublicClient, http, parseEventLogs, type Address, type PublicClient} from "viem";
import {
  ARC_POLLING_INTERVAL_MS,
  MAX_LOG_BLOCK_RANGE,
  readLogsSplitting,
  POLICY_ENGINE_DEPLOY_BLOCK,
  activeChain,
  planWindows,
  policyEngineAbi,
  projectAuditLog,
  type EngineLog,
} from "@tollgate/shared";
import type {Store, StoredEvent} from "./store.ts";

/**
 * Chain into the projection.
 *
 * This is the only writer of event rows, and it is deliberately dumb: read logs, decode them
 * with the same `projectAuditLog` the dashboard uses, insert, advance the cursor. It computes
 * nothing the chain did not already say.
 *
 * Sharing the projection with the dashboard is the point. Two implementations of "what does
 * this event mean" would eventually disagree, and the disagreement would surface as the
 * indexed history quietly differing from what a direct chain read shows — which is exactly
 * the mirror-drift ADR 0006 warns about, reintroduced by copy-paste.
 */

export interface IndexerConfig {
  engine: Address;
  owner: Address;
  store: Store;
  rpcUrl?: string;
  client?: PublicClient;
  /** How far behind the tip a block must be before its logs are treated as final. */
  confirmations?: bigint;
}

export class Indexer {
  readonly engine: Address;
  readonly owner: Address;

  #store: Store;
  #client: PublicClient;
  #confirmations: bigint;

  constructor(config: IndexerConfig) {
    this.engine = config.engine;
    this.owner = config.owner;
    this.#store = config.store;
    this.#confirmations = config.confirmations ?? 64n;
    this.#client =
      config.client ??
      (createPublicClient({
        chain: activeChain,
        transport: http(config.rpcUrl, {timeout: 20_000, retryCount: 4, retryDelay: 400}),
        pollingInterval: ARC_POLLING_INTERVAL_MS,
      }) as PublicClient);
  }

  /**
   * Walk from wherever we stopped to the current safe tip.
   *
   * Returns the number of rows actually written, which is what the tests assert on and what
   * makes "run it twice, the second is a no-op" observable rather than assumed.
   */
  async catchUp(): Promise<{from: bigint; to: bigint; written: number}> {
    const head = await this.#client.getBlockNumber();

    /**
     * Only index what can no longer change.
     *
     * Indexing the unconfirmed tip would mean storing rows that a reorg can invalidate, and
     * this store has no deletion path by design. Stopping short of the tip keeps the
     * invariant simple: everything in the table is final. The dashboard covers the gap by
     * reading the last few blocks straight from chain.
     */
    const safeTip = head > this.#confirmations ? head - this.#confirmations : 0n;

    const deployed = BigInt(process.env.POLICY_ENGINE_DEPLOY_BLOCK ?? POLICY_ENGINE_DEPLOY_BLOCK);
    const resume = this.#store.lastIndexedBlock();
    const from = resume === null ? deployed : resume + 1n;

    if (from > safeTip) return {from, to: safeTip, written: 0};

    let written = 0;
    const windows = planWindows(from, safeTip, safeTip, MAX_LOG_BLOCK_RANGE);

    for (const [position, window] of windows.entries()) {
      // Paced. A cold start is two dozen `eth_getLogs` calls, and firing them back to back is
      // what earns the -32005 that then stalls the whole backfill. A short gap between windows
      // costs seconds once, on a walk that only ever happens once.
      if (position > 0) await new Promise((resolve) => setTimeout(resolve, 250));

      const events = await this.#readWindow(window.from, window.to);
      written += this.#store.putEvents(events);

      // Advanced per window, not once at the end. A crash halfway through a long backfill
      // resumes from the last completed window instead of starting over.
      this.#store.setLastIndexedBlock(window.to);
    }

    await this.#fillBlockTimes();
    return {from, to: safeTip, written};
  }

  async #readWindow(from: bigint, to: bigint): Promise<StoredEvent[]> {
    const logs = await readLogsSplitting(
      (fromBlock, toBlock) => this.#client.getLogs({address: this.engine, fromBlock, toBlock}),
      from,
      to,
    );
    const decoded = parseEventLogs({abi: policyEngineAbi, logs, strict: false});
    const audit = projectAuditLog(decoded as unknown as EngineLog[], this.owner);
    return audit.entries.map((entry) => ({...entry, owner: this.owner}));
  }

  /**
   * Timestamps, once per block.
   *
   * Rows land with `block_time = 0` because a log does not carry its block's time. Filling it
   * here rather than during the walk keeps the walk to one request per window; a block's
   * timestamp never changes, so each is fetched exactly once ever.
   */
  async #fillBlockTimes(): Promise<void> {
    const pending = this.#store.blocksMissingTime(200);
    for (const blockNumber of pending) {
      try {
        const block = await this.#client.getBlock({blockNumber});
        this.#store.setBlockTime(blockNumber, Number(block.timestamp));
      } catch {
        // A missing timestamp degrades the display, never the record. Try again next pass.
      }
    }
  }

  /** Poll forever. Arc settles in under a second; there is no point being cleverer than this. */
  async run(intervalMs = 5_000, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      try {
        const result = await this.catchUp();
        if (result.written > 0) {
          console.log(`indexed ${result.written} event(s) up to block ${result.to}`);
        }
      } catch (error) {
        // Never let a bad poll kill the loop. The chain is the authority and it will still
        // be there next time; an indexer that exits on a rate limit is worse than a slow one.
        console.error("index pass failed:", error instanceof Error ? error.message : error);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
