import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {readLogsSplitting} from "../src/logs.ts";

describe("readLogsSplitting", () => {
  it("splits refused ranges until the endpoint accepts them, covering every block once", async () => {
    const seen: Array<[bigint, bigint]> = [];
    const read = async (from: bigint, to: bigint) => {
      if (to - from + 1n > 1_000n) throw new Error("RPC Request failed.");
      seen.push([from, to]);
      return [from];
    };
    const out = await readLogsSplitting(read, 100n, 5_099n);
    assert.ok(seen.every(([f, t]) => t - f + 1n <= 1_000n));
    // Contiguous, ordered, no gaps or overlaps.
    for (let i = 1; i < seen.length; i++) assert.equal(seen[i]![0], seen[i - 1]![1] + 1n);
    assert.equal(seen[0]![0], 100n);
    assert.equal(seen.at(-1)![1], 5_099n);
    assert.equal(out.length, seen.length);
  });

  it("throws the real error once a range is too small to split", async () => {
    const read = async () => {
      throw new Error("endpoint down");
    };
    await assert.rejects(readLogsSplitting(read, 0n, 1_000n, 250n), /endpoint down/);
  });
});
