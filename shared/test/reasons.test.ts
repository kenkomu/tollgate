import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  REASONS,
  Reason,
  explainToAgent,
  explainToOwner,
  isAllowed,
  isRetryable,
  reasonKind,
  reasonName,
} from "../src/reasons.ts";

/**
 * The reason codes are an ABI, not a convenience.
 *
 * `Reason` in TypeScript and `Reason` in Solidity are the same wire format: the contract
 * returns a `uint8` and every consumer reads it through this table. If the two ever drift,
 * nothing throws — the dashboard simply shows the wrong explanation for a real refusal, and
 * the agent makes the wrong retry decision. That is a silent failure in the part of the
 * system whose entire job is telling the truth about why money did not move.
 *
 * So the first test reads the Solidity source directly rather than trusting a copy.
 */

const SOLIDITY = fileURLToPath(new URL("../../enforcement/src/PolicyEngine.sol", import.meta.url));

function solidityReasonOrder(): string[] {
  const source = readFileSync(SOLIDITY, "utf8");
  const block = /enum\s+Reason\s*\{([^}]*)\}/.exec(source);
  assert.ok(block, "could not find `enum Reason` in PolicyEngine.sol");
  return block[1]!
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim().replace(/,$/, ""))
    .filter((line) => line.length > 0);
}

describe("reason codes mirror the contract", () => {
  it("has the same members, in the same order, as the Solidity enum", () => {
    // Order is the ABI. Appending is safe; reordering or deleting silently remaps every
    // historical event ever emitted.
    assert.deepEqual(Object.keys(Reason), solidityReasonOrder());
  });

  it("assigns each member the index Solidity would", () => {
    solidityReasonOrder().forEach((name, index) => {
      assert.equal(
        Reason[name as keyof typeof Reason],
        index,
        `${name} must be ${index} to match the contract`,
      );
    });
  });

  it("explains every code the contract can return", () => {
    for (const [name, code] of Object.entries(Reason)) {
      const info = REASONS[code];
      assert.ok(info, `${name} has no entry in REASONS`);
      assert.ok(info.owner.length > 0, `${name} has no owner-facing text`);
      assert.ok(info.agent.length > 0, `${name} has no agent-facing text`);
    }
  });
});

describe("retry classification", () => {
  /**
   * The agent branches on this. Marking a `needs-owner` refusal retryable produces exactly
   * the looping agent this product exists to contain — it would hammer the chain paying gas
   * for a call that can never succeed until a human acts.
   */
  it("treats EXCEEDS_VELOCITY as the only retryable refusal", () => {
    const retryable = Object.values(Reason).filter((code) => isRetryable(code));
    assert.deepEqual(retryable, [Reason.EXCEEDS_VELOCITY]);
  });

  it("classifies OK as allowed and nothing else", () => {
    const allowed = Object.values(Reason).filter((code) => isAllowed(code));
    assert.deepEqual(allowed, [Reason.OK]);
    assert.equal(reasonKind(Reason.OK), "ok");
  });

  it("never reports OK as retryable", () => {
    assert.equal(isRetryable(Reason.OK), false);
  });

  it("falls back to needs-owner for a code it does not recognise", () => {
    // A contract deployed ahead of this package returns a code we have never seen. The safe
    // default is "a human must look at this", never "keep trying".
    const future = 99 as Reason;
    assert.equal(reasonKind(future), "needs-owner");
    assert.equal(isRetryable(future), false);
  });
});

describe("explanations", () => {
  it("names every known code", () => {
    assert.equal(reasonName(Reason.PAYEE_NOT_ALLOWED), "PAYEE_NOT_ALLOWED");
  });

  it("degrades to the raw code rather than throwing on an unknown one", () => {
    const future = 99 as Reason;
    assert.match(reasonName(future), /99/);
    assert.match(explainToOwner(future), /99/);
    assert.match(explainToAgent(future), /99/);
  });

  it("keeps owner text free of contract jargon", () => {
    // The owner reads this in an audit log; they should never see an enum name.
    for (const code of Object.values(Reason)) {
      const owner = explainToOwner(code);
      assert.doesNotMatch(owner, /_|revert|0x/, `owner text for ${reasonName(code)} leaks jargon`);
    }
  });
});
