# Funding Tollgate for testing

Everything on Arc testnet is free, but three different addresses need money for three
different reasons, and topping up the wrong one is the usual way a demo stalls.

Run this first, always:

```sh
pnpm balances
```

It reads the chain and tells you whether you can demo right now, naming the blocker if not.
It exits non-zero when something is wrong, so it also works as a pre-recording gate.

---

## The faucet

**https://faucet.circle.com** — select **Arc Testnet**, paste an address, request.

- **20 USDC per request**
- **One request per network every 2 hours**, per address
- **No login, no wallet connection.** Paste an address and go

The rate limit is per address, so three addresses can be funded in the same two-hour window.

## The one Arc fact that makes this simple

On Arc, **USDC is both the gas token and the thing you spend.** Native USDC (18 decimals) pays
fees; the ERC-20 interface at `0x3600…0000` (6 decimals) is what `transferFrom` moves. Same
balance, two views.

So one faucet drip funds both gas and spending for an address. There is no separate "get some
ETH first" step, which is exactly why this project is on Arc.

> The two decimal scales are the single most dangerous number in this codebase. `pnpm balances`
> prints gas at 18 and spendable USDC at 6 deliberately — if a number ever looks a trillion
> times off, that is what happened.

---

## Who needs what

| Address | Spends on | Drains? | Fund it |
|---|---|---|---|
| **Owner** | Every payment the agent makes | **Yes, permanently** | Before every demo session |
| **Agent** | Gas only, ~$0.0007 per payment | Barely | Once, lasts thousands of payments |
| **Payee** | Nothing — it only receives | Never | Never |

**The owner is the one that empties.** Money leaves the owner's wallet and stays with the
payee. One drip of 20 USDC covers roughly a full demo run at the current caps.

The agent is the opposite: 20 USDC buys about **5,500 payments** of gas. Fund it once and
forget it. If a run dies and `check_gas` says the agent is empty, something is wrong beyond
funding.

---

## Recovering what you already spent

Your payee address has accumulated real testnet USDC from previous runs. If you hold its
private key, send it back to the owner rather than waiting on the faucet cooldown — it is the
same money going round the loop again.

If you do not hold that key, the funds are stranded. That is worth knowing before you point a
demo at an address you cannot drain: for a repeatable demo, use a payee whose key you control.

---

## Owner signing now happens in your browser

Since ADR 0008 the dashboard no longer signs with a server key, which means **the wallet you
connect must be the policy owner** or the contract will refuse every change. `PolicyEngine`
keys everything on `msg.sender`.

`OWNER_ADDRESS` in `.env` is currently the address derived from `DEPLOYER_PRIVATE_KEY`. Two
ways to line that up with the wallet extension you actually use:

**Import the existing key** (keeps all on-chain history, fastest)
: In your wallet, "Import account" → paste `DEPLOYER_PRIVATE_KEY` from `.env`. You are now
connected as the existing owner and every past payment stays in the audit log.

**Start a policy owned by your own account** (cleaner, loses the history)
: Set `OWNER_ADDRESS` in `.env` to your wallet's address, restart the dashboard, and create a
policy from the Policy page. The dashboard does the `approve` and the `createPolicy` for you.

The wallet bar at the top of every page tells you which situation you are in — it names the
connected account and warns when it is not the owner.

> Adding Arc to your wallet is automatic. If the wallet has never seen Arc testnet, the
> dashboard offers `wallet_addEthereumChain` on connect rather than making you enter the RPC
> details by hand.

---

## A demo-day checklist

```sh
pnpm balances          # must print "ready to demo"
pnpm contracts:test    # 47 tests
pnpm test              # 99 TypeScript tests
pnpm dashboard         # http://localhost:3000
```

Then, in order:

1. **Fund the owner** at the faucet if `pnpm balances` says so. Wait for it to land — it is
   usually seconds.
2. **Load the dashboard once before you record.** The first load after a restart walks the
   contract's full history; after that it is cached to disk and every load is about a second.
3. **Connect your wallet** and confirm the bar says *Signing as …* rather than warning.
4. **Check the caps suit the story.** A $2.00 per-payment cap and a $4.00 burst make refusals
   easy to trigger on camera, which is the part worth showing.

---

## When something goes wrong

| What you see | What it means |
|---|---|
| `INSUFFICIENT_BALANCE` | The owner's wallet is empty. Faucet. |
| `INSUFFICIENT_ALLOWANCE` | The owner has money but has not approved enough. Policy page → allowance. |
| `EXCEEDS_VELOCITY` | Working as designed. The bucket refills; the agent waits. |
| `NOT_AGENT` | `AGENT_PRIVATE_KEY` does not match the agent bound to the policy. |
| Agent reports empty gas | Fund the **agent** address, not the owner. |
| Dashboard says "Cannot reach Arc" | The public RPC is rate-limiting. Wait and reload; nothing has changed on chain. |

## References

- `agent/src/balances.ts` — the preflight
- ADR 0008 — why the owner signs in the browser
- `docs/outcomes.md` — every outcome of a payment, enumerated
- `shared/src/chain.ts` — the 6-vs-18 decimal rule
