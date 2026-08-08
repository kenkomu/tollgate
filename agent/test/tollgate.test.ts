import assert from "node:assert/strict";
import {beforeEach, describe, it} from "node:test";
import {Reason, usdc} from "@tollgate/shared";
import {
  GasExhaustedError,
  PaymentInFlightError,
  PaymentRevertedError,
  PolicyRefusedError,
  TollgateClient,
  VelocityWaitTooLongError,
} from "../src/tollgate.ts";
import {
  AGENT_KEY,
  ENGINE,
  PAYEE,
  TX_HASH,
  stubPolicy,
  stubState,
  stubTransport,
  type StubState,
} from "./stub-node.ts";

let state: StubState;
let client: TollgateClient;

beforeEach(() => {
  state = stubState();
  client = new TollgateClient({engine: ENGINE, agentPrivateKey: AGENT_KEY, transport: stubTransport(state)});
});

const AMOUNT = usdc("1");

describe("check", () => {
  it("reports a permitted payment", async () => {
    state.checkReason = Reason.OK;
    const result = await client.check(PAYEE, AMOUNT);
    assert.equal(result.allowed, true);
    assert.equal(result.reasonName, "OK");
    assert.equal(result.retryable, false);
  });

  it("reports a refusal without throwing", async () => {
    // `check` is the free planning call. If it threw, an agent could not use it to plan.
    state.checkReason = Reason.PAYEE_NOT_ALLOWED;
    const result = await client.check(PAYEE, AMOUNT);
    assert.equal(result.allowed, false);
    assert.equal(result.reasonName, "PAYEE_NOT_ALLOWED");
    assert.equal(result.retryable, false);
    assert.match(result.message, /allowlist|approved/i);
  });

  it("marks only velocity as worth retrying", async () => {
    state.checkReason = Reason.EXCEEDS_VELOCITY;
    assert.equal((await client.check(PAYEE, AMOUNT)).retryable, true);

    state.checkReason = Reason.EXCEEDS_BUDGET;
    assert.equal((await client.check(PAYEE, AMOUNT)).retryable, false);
  });

  it("never sends a transaction", async () => {
    await client.check(PAYEE, AMOUNT);
    assert.deepEqual(state.sent, []);
  });
});

describe("gas exhaustion is not a policy refusal", () => {
  it("refuses to submit when the key cannot cover a payment", async () => {
    /**
     * On Arc gas is USDC, so the agent key holds a second pot entirely separate from the
     * owner's budget. Reporting an empty key as a refusal sends everyone to look at the
     * policy, which is fine, while the actual fix is to fund a different wallet.
     */
    state.gasBalance = 1n;
    await assert.rejects(() => client.spend(PAYEE, AMOUNT), GasExhaustedError);
    assert.deepEqual(state.sent, [], "nothing may be submitted when gas cannot cover it");
  });

  it("says so in terms that cannot be mistaken for a budget problem", async () => {
    state.gasBalance = 1n;
    const error = await client.spend(PAYEE, AMOUNT).catch((e: unknown) => e);
    assert.ok(error instanceof GasExhaustedError);
    assert.match(error.message, /NOT a policy refusal/);
  });

  it("grades health by how many payments remain affordable", async () => {
    state.gasBalance = 10n ** 18n;
    const healthy = await client.gasHealth();
    assert.equal(healthy.empty, false);
    assert.equal(healthy.low, false);
    assert.ok(healthy.paymentsLeft > 100);

    // Under ten payments' worth is still working, but worth saying out loud.
    state.gasBalance = 120_000n * 30_000_000_000n * 5n;
    const low = await client.gasHealth();
    assert.equal(low.low, true);
    assert.equal(low.empty, false);
    assert.equal(low.paymentsLeft, 5);

    state.gasBalance = 0n;
    const empty = await client.gasHealth();
    assert.equal(empty.empty, true);
    assert.equal(empty.paymentsLeft, 0);
  });
});

describe("velocity back-off", () => {
  it("declines to wait longer than the caller allows, and submits nothing", async () => {
    state.checkReason = Reason.EXCEEDS_VELOCITY;
    state.policy = stubPolicy({
      available: 0n,
      refillPerSecond: usdc("0.001"),
      bucketCapacity: usdc("4"),
    });

    const error = await client
      .spend(PAYEE, AMOUNT, {maxWaitSeconds: 5})
      .catch((e: unknown) => e);

    assert.ok(error instanceof VelocityWaitTooLongError);
    assert.ok(error.seconds > 5);
    assert.deepEqual(state.sent, [], "a wait that is declined must not also submit");
  });

  it("waits out a short refill and reports how long it waited", async () => {
    state.checkReason = Reason.EXCEEDS_VELOCITY;
    state.policy = stubPolicy({
      available: AMOUNT - usdc("1"),
      refillPerSecond: AMOUNT,
      bucketCapacity: usdc("4"),
    });
    // One second of refill covers the shortfall; the client sleeps one extra second so it
    // does not wake at the exact boundary and get refused again.
    state.policy.available = 0n;

    const result = await client.spend(PAYEE, AMOUNT, {maxWaitSeconds: 30});
    assert.equal(result.waitedSeconds, 2);
    assert.equal(state.sent.length, 1);
  });

  it("submits rather than waiting when the bucket can never hold the amount", async () => {
    // Waiting forever is not back-off, it is a hang. A payment above capacity is a real
    // policy mismatch and belongs on the record where the owner can see it.
    state.checkReason = Reason.EXCEEDS_VELOCITY;
    state.simulateReason = Reason.EXCEEDS_VELOCITY;
    state.policy = stubPolicy({available: 0n, bucketCapacity: usdc("0.5"), refillPerSecond: usdc("1")});

    await assert.rejects(() => client.spend(PAYEE, usdc("100"), {maxWaitSeconds: 1}), PolicyRefusedError);
    assert.equal(state.sent.length, 1, "the refusal should have been recorded on chain");
  });

  it("skips the pre-check entirely when asked not to wait", async () => {
    await client.spend(PAYEE, AMOUNT, {waitForVelocity: false});
    assert.equal(state.sent.length, 1);
  });
});

describe("refusals reach the chain", () => {
  it("throws PolicyRefusedError with proof, after submitting", async () => {
    /**
     * The reverting variant would be cheaper — a refused attempt costs no gas. It would also
     * leave the owner with a log of every payment the agent made and no trace of what it was
     * stopped from making, which is the wrong trade for the party at risk.
     */
    state.simulateReason = Reason.PAYEE_NOT_ALLOWED;

    const error = await client.spend(PAYEE, AMOUNT).catch((e: unknown) => e);

    assert.ok(error instanceof PolicyRefusedError);
    assert.equal(error.reason, Reason.PAYEE_NOT_ALLOWED);
    assert.equal(error.retryable, false);
    assert.equal(error.txHash, TX_HASH);
    assert.match(error.explorerUrl, /testnet\.arcscan\.app\/tx\//);
    assert.equal(state.sent.length, 1, "the refusal must be on the record");
  });

  it("marks a velocity refusal retryable", async () => {
    state.checkReason = Reason.OK; // passes the pre-check, refused at execution
    state.simulateReason = Reason.EXCEEDS_VELOCITY;
    const error = await client.spend(PAYEE, AMOUNT).catch((e: unknown) => e);
    assert.ok(error instanceof PolicyRefusedError);
    assert.equal(error.retryable, true);
  });
});

describe("the three failure shapes stay distinct", () => {
  it("a mined revert says nothing moved", async () => {
    state.receiptStatus = "reverted";
    const error = await client.spend(PAYEE, AMOUNT).catch((e: unknown) => e);
    assert.ok(error instanceof PaymentRevertedError);
    assert.match(error.message, /Nothing moved/);
  });

  it("an unresolved payment says the outcome is unknown, not that it failed", async () => {
    /**
     * The dangerous collapse. "Reverted" means the money definitely did not move; "in
     * flight" means we do not know. An agent told the second as though it were the first
     * retries, and that is how one invoice gets paid twice.
     */
    state.receiptStatus = null;
    const error = await client.spend(PAYEE, AMOUNT, {timeoutMs: 250}).catch((e: unknown) => e);
    assert.ok(error instanceof PaymentInFlightError);
    assert.equal(error.txHash, TX_HASH);
    assert.match(error.message, /may still land|Do not retry/);
    assert.doesNotMatch(error.message, /Nothing moved/);
  });

  it("returns lifetime spend read from chain on success", async () => {
    state.policy = stubPolicy({spent: usdc("42")});
    const result = await client.spend(PAYEE, AMOUNT);
    assert.equal(result.txHash, TX_HASH);
    assert.equal(result.spentTotal, usdc("42"));
    assert.equal(result.waitedSeconds, undefined);
  });
});

describe("nonce management", () => {
  it("serialises concurrent payments so each gets its own nonce", async () => {
    /**
     * Three purchases in parallel is the obvious way to write an agent loop, not an exotic
     * case. Unserialised, all three read the same pending nonce and two are dropped as
     * replacements — or worse, one silently replaces another.
     */
    const results = await Promise.all([
      client.spend(PAYEE, AMOUNT),
      client.spend(PAYEE, AMOUNT),
      client.spend(PAYEE, AMOUNT),
    ]);

    assert.equal(results.length, 3);
    assert.deepEqual(
      state.sent.map((s) => s.nonce),
      [0, 1, 2],
      "three payments must occupy three consecutive nonces",
    );
    assert.equal(state.peakConcurrentSubmissions, 1, "submissions overlapped — that is a nonce race");
  });

  it("keeps the queue alive after a failure", async () => {
    // One failed payment must not stall every later one behind a rejected promise.
    state.gasBalance = 1n;
    await assert.rejects(() => client.spend(PAYEE, AMOUNT), GasExhaustedError);

    state.gasBalance = 10n ** 18n;
    const result = await client.spend(PAYEE, AMOUNT);
    assert.equal(result.txHash, TX_HASH);
  });
});

describe("resolving an unknown outcome", () => {
  it("reports a settled payment as settled", async () => {
    state.receiptStatus = "success";
    assert.deepEqual(await client.verify(TX_HASH), {settled: true, succeeded: true});
  });

  it("reports a mined failure as settled but unsuccessful", async () => {
    // Settled and succeeded are different questions. A reverted transaction is resolved —
    // it definitively did not move money — and must not be confused with one still pending.
    state.receiptStatus = "reverted";
    assert.deepEqual(await client.verify(TX_HASH), {settled: true, succeeded: false});
  });

  it("does not guess when there is no receipt", async () => {
    // Absence of a receipt is not evidence of absence of a payment.
    state.receiptStatus = null;
    assert.deepEqual(await client.verify(TX_HASH), {settled: false, succeeded: false});
  });

  it("never resends a payment that already settled", async () => {
    /**
     * The one genuinely dangerous bug in stuck-transaction recovery: resolving a payment
     * that already went through by sending a second one.
     */
    state.receiptStatus = "success";
    const outcome = await client.unstick(TX_HASH);
    assert.equal(outcome.outcome, "already-settled");
    assert.deepEqual(state.sent, [], "an already-settled payment must not be resent");
  });

  it("replaces a stuck payment at the same nonce", async () => {
    state.receiptStatus = null;
    const pending = client.unstick(TX_HASH, "speed-up");
    // The replacement lands once the node starts answering with a receipt.
    setTimeout(() => {
      state.receiptStatus = "success";
    }, 50);
    const outcome = await pending;

    assert.equal(outcome.outcome, "replaced");
    assert.equal(state.sent.length, 1, "a replacement is one transaction, not a second payment");
  });
});
