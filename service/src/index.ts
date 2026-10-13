import {createPublicClient, http, type Address} from "viem";
import {ARC_POLLING_INTERVAL_MS, activeChain} from "@tollgate/shared";
import {createApi} from "./api.ts";
import {openDb} from "./db.ts";
import {ExpoPushChannel} from "./expo-push.ts";
import {Indexer} from "./indexer.ts";
import {Notifier, consoleChannel} from "./notifications.ts";
import {Store} from "./store.ts";

/**
 * The service: index, notify, serve.
 *
 * One process doing three things, which is the right shape at this size. When any one of them
 * needs to scale independently they separate cleanly — they already share nothing but the
 * store.
 *
 * Nothing here is on the path of a payment. If this process never starts, the agent still
 * pays, the contract still refuses, and the dashboard still reads chain directly. That is not
 * an accident of the design; it is the constraint the design is built to keep.
 */

const engine = process.env.POLICY_ENGINE_ADDRESS as Address | undefined;
const owner = process.env.OWNER_ADDRESS as Address | undefined;
const port = Number(process.env.PORT ?? 4000);

if (!engine || !owner) {
  console.error("Need POLICY_ENGINE_ADDRESS and OWNER_ADDRESS in .env");
  process.exit(1);
}

const db = openDb();
const store = new Store(db);
const indexer = new Indexer({engine, owner, store, rpcUrl: process.env.ARC_RPC_URL});
/**
 * Real push when a device has registered, the log otherwise.
 *
 * Deliberately decided per run rather than by configuration: registering a device is the
 * event that makes remote delivery possible, so it is the right thing to key on. The console
 * channel is not a stub — it exercises the same delivery decision and the same once-only
 * cursor, which is where the bugs live.
 */
const pushable = store.devicesFor(owner).length > 0;
const notifier = new Notifier(store, pushable ? new ExpoPushChannel(store) : consoleChannel);

const client = createPublicClient({
  chain: activeChain,
  transport: http(process.env.ARC_RPC_URL, {timeout: 20_000, retryCount: 4}),
  pollingInterval: ARC_POLLING_INTERVAL_MS,
});

const api = createApi({
  store,
  owner,
  engine,
  head: () => client.getBlockNumber().catch(() => null),
  onApprovalRequested: (approval) => notifier.notifyApproval(owner, approval),
});

const controller = new AbortController();

/**
 * Notification is not conditional on indexing succeeding.
 *
 * The obvious shape — index, and if anything was written, notify — has a failure mode that a
 * live run found immediately: Arc rate-limited a pass *after* it had written rows and before
 * it returned, so the notify step never ran, and the four refusals it should have reported
 * were never mentioned again. Every later pass wrote nothing and skipped notification too.
 * The alert was lost to a transient network error, permanently and silently, which is the
 * worst way for an alerting system to fail.
 *
 * So notification reads the store rather than a return value. The claim table already makes
 * it idempotent, so running it on every tick costs one indexed query and cannot double-send.
 */
async function tick(): Promise<void> {
  let indexError: unknown;
  try {
    const result = await indexer.catchUp();
    if (result.written > 0) {
      console.log(`indexed ${result.written} event(s) through block ${result.to}`);
    }
  } catch (error) {
    indexError = error;
  }

  // Runs whether or not the index pass completed, and whether or not it wrote anything.
  const sent = await notifier.notifyNew(owner!, store.activityFor(owner!, 100));
  if (sent > 0) console.log(`sent ${sent} notification(s)`);

  if (indexError) throw indexError;
}

/**
 * Poll, backing off when the endpoint pushes back.
 *
 * Arc's public RPC rate-limits, and a fixed interval turns that into a tight loop of failing
 * requests that makes the limit worse. Backoff is capped so the indexer always recovers on
 * its own, and the repeated-error log is collapsed so one outage does not produce a thousand
 * identical lines nobody will read.
 */
async function loop(): Promise<void> {
  const BASE_MS = 10_000;
  const MAX_MS = 120_000;
  let delay = BASE_MS;
  let lastError = "";
  let repeats = 0;

  while (!controller.signal.aborted) {
    try {
      await tick();
      delay = BASE_MS;
      if (repeats > 0) {
        console.log(`recovered after ${repeats} failed pass(es)`);
        repeats = 0;
        lastError = "";
      }
    } catch (error) {
      // Never exit the loop. The chain will still be there next time, and an indexer that
      // dies on a rate limit is worse than one that is briefly behind.
      const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
      if (message === lastError) {
        repeats++;
      } else {
        console.error(`index pass failed: ${message}`);
        lastError = message;
        repeats = 1;
      }
      delay = Math.min(delay * 2, MAX_MS);
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

api.listen(port, () => {
  console.log(`\n  tollgate service`);
  console.log(`    api      http://localhost:${port}`);
  console.log(`    contract ${engine}`);
  console.log(`    owner    ${owner}`);
  console.log(`    indexed  ${store.lastIndexedBlock() ?? "nothing yet"}\n`);
});

void loop();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    controller.abort();
    api.close();
    db.close();
    process.exit(0);
  });
}
