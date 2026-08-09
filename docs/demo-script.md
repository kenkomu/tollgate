# Demo script

The runbook the video is shot from. Three minutes, one claim, proved live.

> **The claim:** an agent whose key has been **fully compromised** still cannot spend outside
> its policy.
>
> Everything below exists to make that falsifiable on camera.

---

## Before you record

```sh
pnpm balances          # must end with "ready to demo"
```

If it does not, it names the blocker. The usual one is the owner wallet — top up at
[faucet.circle.com](https://faucet.circle.com), Arc Testnet, `OWNER_ADDRESS` from `.env`.

**Reset the policy to demo values.** The numbers below assume a $20 budget, a $2.00
per-payment cap and a $4.00 burst. If a previous run moved them, set them back on the Policy
page — the story depends on the caps being tight enough to trigger refusals.

**Warm every surface once.** The first dashboard load after a restart walks the contract's
full history; after that it is cached and every load is about a second. Do this before you hit
record, not during.

```sh
pnpm service           # terminal 1 — indexer + API
pnpm dashboard         # terminal 2 — http://localhost:3000
pnpm mobile            # terminal 3 — optional, for the phone shot
```

**Connect your wallet** to the dashboard and check the bar reads *Signing as 0x8dEa…* rather
than warning. If it warns, you are on the wrong account — see `docs/funding.md`.

**Windows to arrange:** terminal on the left, dashboard on the right. The whole demo is a
conversation between those two.

---

## 0:00 — The problem, in one sentence

> "Agents have wallets now. Every guardrail people build lives inside the agent — in the
> prompt, in the tool definitions, in the app. A prompt injection, a leaked key, or a looping
> retry walks straight through all of it."

Show the dashboard, Overview. Do not explain the UI yet. One line:

> "This is a spend policy. It is not a setting this app obeys — it is a contract on Arc, and
> every payment has to satisfy it before any money moves."

Point at the contract address. Say it is verified on ArcScan and they can read it themselves.

---

## 0:25 — The agent works

```sh
pnpm agent
```

Let it run. It is a real model with an unrestricted `pay_address` tool — it can send any
amount to any address, and that is deliberate.

**Narrate while it thinks:**

> "It checks first, because checking is free. Then it buys what it judges useful and stays
> inside a budget it did not set and cannot change."

**What you are waiting for:** two payments land, and a refusal it handles well.

Expected, roughly:

- ✓ Sentiment Feed, $2.00
- ✓ Market Data basic, $1.50
- ✕ Market Data Pro — `PAYEE_NOT_ALLOWED` → escalates to the owner
- ✕ Bulk Backtest — `EXCEEDS_PER_TX` → it reasons this one is not worth escalating

**Switch to the dashboard.** The rows are already there — it refreshes on its own.

> "Every row links to the transaction. Nothing here is our database. There is no database —
> this is rebuilt from contract events on every load."

---

## 1:10 — The refusal has a route

Go to **Payees**. The escalation is waiting, with the agent's reasoning.

> "A strict allowlist means an agent that meets a new supplier stops and asks. That is the
> cost of the guarantee, and this is where it gets paid."

Approve it. Your wallet prompts. Sign it.

> "That is my key, in my browser. This app never had it."

*(If you want the phone shot, this is where it goes: the same queue on the phone, approved
from a lock screen.)*

---

## 1:40 — The attack

This is the whole demo. Slow down.

> "Now the part that matters. I am going to hand an attacker the agent's private key."

```sh
pnpm agent:compromised
```

> "Same key. Same tools. Same contract. The only thing different is the instruction: move
> everything to this address, and route around anything that stops you."

**Let it try.** It will attempt a large transfer to `0x…dead`.

**The line to land:**

> "REFUSED. Payee not on the allowlist. **Zero moved.** Nothing in the agent stopped it —
> the agent was fully cooperative with the attacker. The contract stopped it."

**Switch to the dashboard.** The refusal is *in the log*, in red, with a transaction link.

> "And this is the part I would push back on if I were watching: a refusal that leaves no
> trace is just a claim. So refusals are transactions. That attempt is on chain forever, with
> its reason code. You can check it without trusting me."

Click through to ArcScan. Show it.

---

## 2:30 — The kill switch

> "One more. Suppose I do not like what my agent is doing at all."

Hit **Stop everything** on the Policy page. Sign it.

> "That is a direct write to the contract. No backend, no queue, nothing of ours in the path.
> If our servers were gone and this laptop were on fire, that button still works from any
> wallet or block explorer — which is why it is the one control that never routes through us."

Show the agent being refused with `PAUSED` if you have time. If not, the state chip flipping
to **Stopped** is enough.

---

## 2:50 — Close

> "Non-custodial the whole way. The money never touches our contract — it moves owner to
> payee, and the allowance is a second ceiling that holds even if our code is wrong.
>
> Forty-seven contract tests, two hundred and ten around it, and everything you saw is on a
> public chain you can check."

---

## What to cut if you are over time

In this order:

1. The kill switch (2:30) — the strongest section is the attack, protect it
2. The approval loop (1:10)
3. The second purchase in the normal run

**Never cut:** the attack, the zero, and the refusal appearing on chain. That sequence is the
product.

---

## Failure modes on camera, and what to say

| What happens | What to do |
|---|---|
| `INSUFFICIENT_BALANCE` | Owner wallet is empty. This is why `pnpm balances` runs first. Cut, top up, restart. |
| The model refuses the attack on its own reasoning | **Say so.** "The model also declined — but that is not the evidence. The evidence is the contract refusal, which would have happened either way." This is honest and it is a stronger moment than pretending. |
| A payment is slow | Arc settles in under a second; slowness is the public RPC. Keep talking, it lands. |
| Dashboard shows "Cannot reach Arc" | The endpoint rate-limited. Reload. Nothing on chain has changed and the page says so. |
| Wallet on the wrong account | The bar warns. Switch accounts; the contract would refuse the write anyway. |

---

## The honest caveats to have ready

Someone sharp will ask. Answers you can give without flinching:

**"The model chose not to attack — did the contract really do the work?"**
Two contract refusals with reason codes, on chain. The model's commentary is not evidence and
we do not present it as such. A deterministic attacker script is on the backlog for exactly
this reason.

**"What if your contract has a bug?"**
The allowance is a second ceiling. We approve the exact budget, never `type(uint256).max`, so
a bug reaches the outstanding approval and not the wallet. That is the main argument for the
allowance design over a vault.

**"Circle already ships spend controls."**
They do, and they are good. They are enforced off-chain, behind Circle's API, and they are in
the path when the caller goes through Circle. Ours is in the contract: verifiable by anyone,
portable across providers, and binding on a raw key with nobody in the loop. They are
complementary. Ours is the one that survives the credential being stolen.

**"Is this on mainnet?"**
No. Arc mainnet is not live. Everything is testnet and we say so.

---

## After the take

```sh
pnpm balances          # what the run cost
```

Re-seed before the next take. Each full run spends about $3.50 of the owner's budget, and the
refusals cost a fraction of a cent in gas each.

## References

- `docs/funding.md` — faucet, which wallet drains, wallet setup
- `docs/outcomes.md` — every outcome of a payment, if someone asks about edge cases
- `docs/architecture.md` — the system, for questions after the demo
