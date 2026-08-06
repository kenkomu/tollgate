# Every outcome of `spend()`

What can happen when an agent asks to move money, and what each case means for the
owner, the agent, and the audit log.

Measured on Arc testnet against `PolicyEngine` at
`0x7Fa88da4FD0a86Af9c9567f0c317be6FBa1a376D`.

---

## The short version

There are exactly four places a payment can end up:

| | Money moved? | Agent knows? | Costs gas? |
|---|---|---|---|
| **Refused before sending** | No | Yes, with a reason code | No |
| **Refused on chain** | No | Yes, with a reason code | Yes |
| **Settled** | Yes | Yes, with a receipt | Yes |
| **Unresolved** | **Unknown** | **No** | Yes |

The fourth row is the dangerous one, and the only one that is genuinely hard. Everything
else is a clean answer.

---

## 1. Never reaches the chain

### 1.1 Pre-flight refusal — the normal case

The agent calls `check_budget` first, which is `checkTransfer` — a `view`. It returns one
of twelve reason codes and costs nothing. A refusal here costs the agent no gas, no time,
and no transaction.

This is the path the demo takes: three of the four services are refused before a
transaction is ever constructed.

### 1.2 Simulation refusal

If the agent skips the check, `spend()` still simulates before sending. The simulation
reverts with `PolicyViolation(reason)` and no transaction is broadcast. Same outcome,
one wasted RPC round trip.

### 1.3 RPC unreachable

Network error. Nothing was submitted. Safe to retry — this is the one failure where
retrying is unambiguously correct.

### 1.4 The agent cannot pay for gas

On Arc, **gas is USDC**. The agent's key needs its own balance, entirely separate from
the owner's budget. An agent with a $20 policy and an empty key cannot transact at all.

This is a real operational trap: the owner's allowance and the agent's gas are two
different pots, and only one of them is visible on the dashboard.

---

## 2. Submitted but does not confirm — **stuck**

### 2.1 The cause

Arc enforces a **minimum base fee of 20 Gwei**. The docs are explicit that a transaction
below the floor "may remain pending indefinitely or fail outright."

`shared/src/chain.ts` has carried `MIN_GAS_PRICE_WEI` since the start — and until today it
was wired into nothing. Fees were left to viem's estimator. Now the floor is applied
explicitly in `TollgateClient.#fees()`, doubled for base-fee headroom, and settled *before*
simulating so the simulated and submitted transactions are the same shape.

### 2.2 What the agent does about it

`waitForTransactionReceipt` is bounded at 90 seconds. On expiry the client throws
`PaymentInFlightError`, and the tool converts it into this, verbatim:

> PAYMENT STATUS UNKNOWN. Do NOT retry this payment.

This wording is deliberate. A model handed a raw timeout stack trace does the
reasonable-looking thing and tries again — and for an unresolved payment that is exactly
how the same invoice gets paid twice.

**A timeout is not proof of failure.** The transaction may still be in the mempool and may
still land.

### 2.3 Resolving it

`TollgateClient.verify(txHash)` returns `{settled, succeeded}` read from chain. Three
answers, all honest:

- `settled: true, succeeded: true` — it landed. Do not resend.
- `settled: true, succeeded: false` — it reverted. Nothing moved.
- `settled: false` — still pending, or dropped. Still unknown; do not guess.

### 2.4 Clearing a genuinely stuck transaction

Replace it by sending a new transaction with the **same nonce** and a higher fee — either
the same payment repriced, or a zero-value self-send to cancel. This is an owner/operator
action today; automating it is in the backlog.

### 2.5 The blast radius is bounded

Worth stating plainly: even if the agent did double-pay, the policy caps still hold. The
budget, the per-payment cap and the velocity bucket all apply to the second payment
exactly as they did to the first. A double payment is an agent bookkeeping bug, **not a
failure of the leash**.

---

## 3. Mined and reverted

The simulation passed, then state changed underneath it before execution. Causes:

- The owner hit the kill switch in the intervening blocks
- The owner revoked the payee
- The owner's USDC balance or allowance dropped
- Enough time passed that the velocity bucket no longer covers it

Gas is consumed. **No money moves. No `Spent` event is emitted**, so nothing appears in the
audit log — which is correct, because nothing happened.

The client raises `PaymentRevertedError`, distinct from the in-flight case, because the
correct response differs: this one is safe to reassess and retry, the other is not.

> **This is why `checkTransfer` is advisory and only `spend` is authoritative.** The gap
> between checking and executing is real, and the contract is the only thing that closes it.

---

## 4. Settled

`Spent(owner, agent, payee, amount, spentTotal, availableAfter)` is emitted, `spent`
increases, the velocity bucket is decremented, and USDC moves **owner → payee**. It never
touches the PolicyEngine's own balance.

The audit log keys each entry on `txHash + logIndex`, so a re-read or a reorg cannot
double-count a payment.

---

## 5. The payee is wrong

Three different questions hide in "what if the payee is incorrect".

### 5.1 The payee is not allowlisted

Refused with `PAYEE_NOT_ALLOWED`. This is the rule the compromised-agent demo hits. The
refusal is **amount-independent** — the attacker verified this itself by dropping from
$1,000 to $1.00 and getting the identical code.

### 5.2 The payee is allowlisted but is the wrong address

**Tollgate cannot help you.** If the owner approved `0xBAD`, then `0xBAD` is authorised and
the payment is valid by every rule the contract knows.

This is the honest limit of the design and it is in the threat model: Tollgate constrains
**how much, how fast, and to whom** — it has no opinion on whether the counterparty
deserves it. The approvals queue exists to slow that decision down and put the agent's
own justification in front of a human, which is mitigation, not prevention.

USDC transfers are irreversible. There is no clawback.

### 5.3 The payee is a contract that cannot move tokens

ERC-20 `transferFrom` calls no hook on the recipient, so the transfer succeeds and the
funds are stranded at that address forever.

**Known footgun:** nothing currently stops an owner from allowlisting the PolicyEngine
itself, which has no withdraw function — funds sent there are unrecoverable. `setPayee`
should reject `address(this)`. It is a one-line fix, it is in the backlog, and it is *not*
being applied before submission because redeploying would invalidate the verified contract
and every proof link in the demo. Documented rather than silently carried.

---

## 6. Race conditions and reorgs

| Situation | Outcome |
|---|---|
| Two payments from one agent | Sequential nonces serialise them. `nonReentrant` guards re-entry. |
| Two agents on one policy | Impossible — one agent per policy, one policy per owner. |
| Owner changes policy mid-flight | Execution wins. See §3. |
| Confirmed then reorged out | The `Spent` event disappears; the audit log self-heals on the next read, since it is rebuilt from chain rather than stored. The agent may have already acted on a receipt. Arc's sub-second finality makes this very unlikely; settled-history caching stays 64 blocks behind the tip for exactly this reason. |
| `spent` overflows `uint128` | Cannot happen. `_evaluate` rejects anything that would push `spent` past `budgetCap`, and `budgetCap` is itself `uint128`. |

---

## 7. Micro-payments

**Yes, $0.10–$0.50 works.** Verified on chain, not reasoned about.

`checkTransfer` returns `OK` all the way down to **1 unit — $0.000001**, the smallest USDC
can express. Only `0` is rejected, as `AMOUNT_ZERO`. There is no minimum in the contract.

A real $0.10 payment:
[`0x4652d28f…33ff4`](https://testnet.arcscan.app/tx/0x4652d28f3a9194a275a3a734306ad4fab30dcfdfefb15c2e69fe209d61433ff4)

```
gas used   99,535 @ 20.20 Gwei
gas cost   0.002011 USDC
overhead   2.01% of a $0.10 payment
```

**Gas is flat at ~$0.002 regardless of amount** — a $0.10 payment and a $2.00 payment cost
the same to execute. So the only thing that changes with size is the overhead ratio:

| Payment | Fee overhead | Verdict |
|---|---|---|
| $2.00 | 0.10% | negligible |
| $0.50 | 0.40% | comfortable |
| $0.20 | 1.0% | the break-even most people would accept |
| $0.10 | 2.0% | workable |
| $0.05 | 4.0% | marginal |
| $0.01 | 20% | don't |

**Practical floor: about $0.05.** Below that, the answer is not a smaller payment — it is
batching, or off-chain settlement against a Circle Gateway balance, which is precisely the
gap ADR 0005 documents: per-call x402 payments settle off-chain where an on-chain policy
cannot see them.

### What the velocity bucket does to small payments

The bucket is a *rate* limit, so it does not care about payment size — only throughput.
With the demo's settings (capacity $4.00, refill 1,111 units/sec = $4/hour):

- **Burst:** 40 payments of $0.10 back to back, then the bucket is empty.
- **Sustained:** one $0.10 payment every 90 seconds, ~40/hour.
- A $0.50 payment needs 450 seconds of refill.

For a high-frequency micro-payment agent you would raise the refill rate and lower the
per-payment cap — the two knobs are independent, which is the point of having both.
