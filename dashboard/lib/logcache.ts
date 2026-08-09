import {readFile, writeFile, mkdir} from "node:fs/promises";
import {dirname, resolve} from "node:path";

/**
 * Settled log windows, persisted across restarts.
 *
 * The in-process memo already means a block more than 64 confirmations behind the tip is
 * read once per server lifetime. This extends "once per lifetime" to "once, ever", because
 * the first load after a restart was walking the entire history again — 45 seconds against
 * a rate-limited public endpoint, which is a long time to look at a blank dashboard and an
 * unacceptable way to open a demo.
 *
 * This stays inside the rules ADR 0006 sets for any off-chain store:
 *
 *   - The chain remains the authority. Nothing is read from here that was not decoded from
 *     a contract event.
 *   - It is droppable. Delete the file and the next load rebuilds it from chain.
 *   - Only *settled* windows land here. Current policy state is never cached, because a
 *     cached view of a spend limit is a wrong view of a spend limit.
 *
 * It is a cache, not a mirror. It cannot disagree with the chain about what happened,
 * because it holds only blocks whose contents can no longer change.
 */

const FILE = resolve(process.cwd(), "..", ".tollgate", "logcache.json");

/** JSON has no bigint. Tag them so a round trip is lossless rather than lossy-and-quiet. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? {$bigint: value.toString()} : value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "$bigint" in value) {
    return BigInt((value as {$bigint: string}).$bigint);
  }
  return value;
}

export async function loadWindows<T>(): Promise<Map<string, T>> {
  try {
    const raw = await readFile(FILE, "utf8");
    return new Map(Object.entries(JSON.parse(raw, reviver) as Record<string, T>));
  } catch {
    // No cache, or an unreadable one. Both mean "read from chain", which is always correct.
    return new Map();
  }
}

export async function saveWindows<T>(windows: Map<string, T>): Promise<void> {
  try {
    await mkdir(dirname(FILE), {recursive: true});
    await writeFile(FILE, JSON.stringify(Object.fromEntries(windows), replacer));
  } catch {
    // A cache that cannot be written is a slow dashboard, not a broken one. Never let it
    // take down a request.
  }
}
