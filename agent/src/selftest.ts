/**
 * Integration check for the four hardening behaviours.
 *
 * SPENDS REAL TESTNET MONEY. Not part of `pnpm test` for that reason — run it deliberately
 * with `pnpm --filter @tollgate/agent selftest` against a policy you are happy to drain.
 *
 * These are the paths that unit tests cannot honestly cover, because each one is a claim
 * about how a live chain behaves: that concurrent submissions do not collide on a nonce,
 * that a rate-limited payment waits rather than failing, that an empty key is reported as
 * empty rather than as a refusal, and that a stuck transaction can be resolved without
 * becoming a second payment.
 */

import {formatUsdc} from "@tollgate/shared";
import {TollgateClient, VelocityWaitTooLongError} from "./tollgate.ts";
import type {Address, Hex} from "viem";

const engine = process.env.POLICY_ENGINE_ADDRESS as Address;
const agentKey = process.env.AGENT_PRIVATE_KEY as Hex;
const payee = process.env.PAYEE_ADDRESS as Address;

if (!engine || !agentKey || !payee) {
  console.error("Need POLICY_ENGINE_ADDRESS, AGENT_PRIVATE_KEY and PAYEE_ADDRESS.");
  process.exit(1);
}

const client = new TollgateClient({engine, agentPrivateKey: agentKey});

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`        ${detail}`);
  if (!ok) failures++;
}

console.log("\n── gas health ──\n");

const health = await client.gasHealth();
check(
  "agent key gas is reported separately from the owner's budget",
  !health.empty,
  `${health.paymentsLeft} payments affordable, low=${health.low}, empty=${health.empty}`,
);

console.log("\n── nonce serialisation + velocity back-off ──\n");

const owner = await client.owner();
const before = await client.getPolicy(owner);

// Derived from the live policy rather than hardcoded, so the test stays meaningful when
// the bucket is retuned. Three payments at 40% of capacity demand 120% of it, which the
// bucket can only cover if the refill outruns them — and that is exactly what we want to
// force. An earlier fixed $1.50 quietly stopped testing anything once the refill was
// raised, and reported a pass for a wait that never happened.
const amount = (before.bucketCapacity * 2n) / 5n;

console.log(`  bucket ${formatUsdc(before.bucketCapacity)}, refill ${before.refillPerSecond}/sec`);
console.log(`  firing 3 concurrent payments of ${formatUsdc(amount)} — 120% of the bucket\n`);

const started = Date.now();
const results = await Promise.allSettled([
  client.spend(payee, amount),
  client.spend(payee, amount),
  client.spend(payee, amount),
]);
const elapsed = Math.round((Date.now() - started) / 1000);

const settled = results.filter((r) => r.status === "fulfilled");
const hashes = new Set(settled.map((r) => (r as PromiseFulfilledResult<{txHash: string}>).value.txHash));

check(
  "three concurrent submissions produce three distinct transactions",
  hashes.size === settled.length,
  `${settled.length} settled, ${hashes.size} unique hashes — a nonce collision would drop one`,
);

const waited = settled
  .map((r) => (r as PromiseFulfilledResult<{waitedSeconds?: number}>).value.waitedSeconds ?? 0)
  .filter((s) => s > 0);

check(
  "a payment past the burst ceiling waits for refill instead of failing",
  waited.length > 0,
  waited.length > 0
    ? `${waited.length} payment(s) waited ${waited.join(", ")}s; whole batch took ${elapsed}s`
    : `NO WAIT OCCURRED — the refill outran the payments, so this proved nothing. ` +
      `Lower refillPerSecond and re-run. ${settled.length}/3 settled in ${elapsed}s`,
);

for (const r of results) {
  if (r.status === "rejected") {
    const tooLong = r.reason instanceof VelocityWaitTooLongError;
    console.log(
      `  note: one payment ${tooLong ? "declined to wait" : "failed"} — ${String(r.reason).split("\n")[0]}`,
    );
  }
}

const after = await client.getPolicy(owner);
check(
  "lifetime spend matches what settled",
  after.spent - before.spent === BigInt(settled.length) * amount,
  `spent went ${formatUsdc(before.spent)} → ${formatUsdc(after.spent)}, ` +
    `expected ${settled.length} × ${formatUsdc(amount)}`,
);

console.log("\n── stuck-transaction recovery ──\n");

const known = settled[0] as PromiseFulfilledResult<{txHash: Hex}> | undefined;
if (known) {
  const outcome = await client.unstick(known.value.txHash);
  check(
    "resolving an already-settled payment does not resend it",
    outcome.outcome === "already-settled",
    `reported "${outcome.outcome}" — the dangerous bug here is creating a second payment`,
  );
} else {
  check("stuck recovery", false, "no settled transaction to resolve against");
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
