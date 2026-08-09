import assert from "node:assert/strict";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, before, describe, it} from "node:test";

/**
 * The on-disk log cache.
 *
 * Worth testing for one reason: it serialises **bigints through JSON**, which has no bigint.
 * Every amount in this system is one, and the failure mode of getting this wrong is not a
 * crash — it is a payment silently reading back as a string, or as a rounded number, in the
 * component that renders the audit log. Money that round-trips through the wrong type is the
 * class of bug this whole project is careful about.
 *
 * The cache resolves its path from `process.cwd()`, so these tests run it from a temporary
 * directory rather than touching the real one.
 */

let dir: string;
let cwd: string;
let loadWindows: <T>() => Promise<Map<string, T>>;
let saveWindows: <T>(windows: Map<string, T>) => Promise<void>;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tollgate-logcache-"));
  cwd = process.cwd();
  // The module resolves `../.tollgate/logcache.json` from cwd, so it needs a level to go up.
  const nested = join(dir, "app");
  mkdtempSync(join(dir, "x"));
  writeFileSync(join(dir, "marker"), "");
  process.chdir(dir);
  const fs = await import("node:fs");
  fs.mkdirSync(nested, {recursive: true});
  process.chdir(nested);

  ({loadWindows, saveWindows} = await import("./logcache.ts"));
});

after(() => {
  process.chdir(cwd);
  rmSync(dir, {recursive: true, force: true});
});

describe("bigint survives the round trip", () => {
  it("returns bigints as bigints, not strings", async () => {
    const windows = new Map([["1:2", [{blockNumber: 55_621_174n, amount: 1_500_000n}]]]);
    await saveWindows(windows);

    const loaded = await loadWindows<{blockNumber: bigint; amount: bigint}[]>();
    const entry = loaded.get("1:2")![0]!;

    assert.equal(typeof entry.blockNumber, "bigint", "a bigint came back as something else");
    assert.equal(entry.blockNumber, 55_621_174n);
    assert.equal(entry.amount, 1_500_000n);
  });

  it("keeps a value too large for a JS number exact", async () => {
    // Above Number.MAX_SAFE_INTEGER. A naive round trip through Number silently rounds here,
    // and the result still looks like a plausible amount.
    const huge = 9_007_199_254_740_993n;
    await saveWindows(new Map([["k", [{amount: huge}]]]));

    const loaded = await loadWindows<{amount: bigint}[]>();
    assert.equal(loaded.get("k")![0]!.amount, huge);
  });

  it("leaves ordinary values alone", async () => {
    await saveWindows(new Map([["k", [{eventName: "Spent", logIndex: 3, removed: false}]]]));
    const loaded = await loadWindows<{eventName: string; logIndex: number; removed: boolean}[]>();
    const entry = loaded.get("k")![0]!;

    assert.equal(entry.eventName, "Spent");
    assert.equal(entry.logIndex, 3);
    assert.equal(entry.removed, false);
  });

  it("round-trips every window key", async () => {
    const windows = new Map([
      ["55621174:55641173", [{n: 1n}]],
      ["55641174:55661173", []],
    ]);
    await saveWindows(windows);

    const loaded = await loadWindows<{n: bigint}[]>();
    assert.deepEqual([...loaded.keys()].sort(), [...windows.keys()].sort());
    assert.deepEqual(loaded.get("55641174:55661173"), []);
  });
});

describe("failing to read is not failing", () => {
  it("returns an empty map when there is no cache", async () => {
    // No cache means "read from chain", which is always correct — never an error.
    const fresh = mkdtempSync(join(tmpdir(), "tollgate-empty-"));
    const here = process.cwd();
    try {
      const fs = await import("node:fs");
      fs.mkdirSync(join(fresh, "app"), {recursive: true});
      process.chdir(join(fresh, "app"));
      const mod = await import(`./logcache.ts?fresh=${Date.now()}`);
      assert.equal((await mod.loadWindows()).size, 0);
    } finally {
      process.chdir(here);
      rmSync(fresh, {recursive: true, force: true});
    }
  });

  it("returns an empty map rather than throwing on a corrupt cache", async () => {
    /**
     * A truncated write, a half-flushed file, a manual edit. Any of them must degrade to a
     * slow page load, never to a dashboard that will not render — the cache is an optimisation
     * and the chain is still the authority.
     */
    writeFileSync(join(dir, ".tollgate", "logcache.json"), "{not json");
    assert.equal((await loadWindows()).size, 0);
  });
});
