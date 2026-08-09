# Video script — 3 minutes

Written to be **said**, not read. Contractions, short clauses, sentence fragments where a
person would use one. If a line feels like an essay in your mouth, cut it — the marked-up
version below has already had that done to it once.

**Target 2:50.** Almost everyone runs 15% long on the first take.

```sh
pnpm record 180      # screen + mic → recordings/tollgate-<timestamp>.mp4
pnpm record          # or record until you press q
```

---

## Before you press record

- `pnpm balances` says **ready to demo**
- Dashboard loaded once already (first load walks history — don't do that on camera)
- Wallet connected, bar reads *Signing as…*
- Terminal left, browser right, both big enough to survive compression
- Policy at **$20 budget · $2.00 per payment · $4.00 burst**

---

## 0:00 — Open

> Agents have wallets now. They buy data, they pay for compute, they settle invoices — and
> nobody's watching each one.
>
> So people put guardrails in. In the prompt. In the tool definitions. In the app.
>
> And all of those have the same problem. They're inside the agent. A prompt injection walks
> through them. A leaked key skips them. A retry loop just… doesn't care.

*(beat)*

> Tollgate puts the limit somewhere the agent can't reach.

---

## 0:22 — What you're looking at

*(Dashboard, Overview. Don't tour it.)*

> This is a spend policy. It's on Arc, it's a contract, and it's not a setting this app obeys
> — every payment has to get past it before any money moves.
>
> Twenty dollars total. Two dollars a payment. A rate limit that refills. And a list of who
> can be paid at all.

*(point at the address)*

> That's the contract. It's verified. You can go read it.

---

## 0:38 — The agent, working

*(`pnpm agent`)*

> Real agent, real wallet. And its payment tool is deliberately wide open — any amount, any
> address.
>
> That's on purpose. If this only worked because I handed it a narrow tool, it wouldn't prove
> anything.

*(payments land — let them)*

> It checks first, because checking's free. Then it buys what it needs, inside a budget it
> didn't set and can't change.

*(switch to dashboard — rows are already there)*

> Every row links to the transaction. And there's no database behind this. It's rebuilt from
> contract events every time you load it. None of this is me telling you what happened.

---

## 1:12 — When it gets stopped

> It also got refused. Found a supplier that's not on my list — and instead of retrying,
> which was never going to work, it asked me.

*(Payees. The request is sitting there.)*

> That's what a strict allowlist costs you. The agent stops and waits for a human. So
> approving has to be quick, or people just widen the policy to make the annoyance go away.

*(approve — wallet prompts — sign)*

> That's my key. In my browser. This app's never had it.

---

## 1:36 — The attack

*(Slow down here. This is the whole video.)*

> Okay. The part that matters.
>
> I'm going to give an attacker the agent's private key. Not a pretend one. The actual key.

*(`pnpm agent:compromised`)*

> Same key, same tools, same contract. Only thing that's different is what I'm telling it:
> move everything to this address, and get around anything that stops you.

*(let it run — it goes for `0x…dead`)*

> Refused. **Zero moved.**

*(pause. let that sit.)*

> And look at what stopped it. Not the agent — the agent went along with the attacker
> completely. The contract stopped it.

*(dashboard — the refusal, in red)*

> Here's the bit I'd push back on if I were you. A refusal nobody can see is just me saying
> so. So refusals are transactions. That attempt is on chain, permanently, with the reason
> code attached. You can check it without taking my word for any of it.

---

## 2:18 — Kill switch

> One more thing. If I just don't like what my agent's doing —

*(Stop everything. Sign.)*

> — that's a direct write to the contract. No backend, no queue, nothing of mine in the way.
>
> If my servers were gone and this laptop was on fire, that still works. From any wallet.
> That's the one control that can't depend on me, so it doesn't.

---

## 2:38 — Close

> The money never touches my contract. It goes owner to payee. And the approval's a second
> ceiling — so even if my code's wrong, that's as far as it reaches.
>
> Everything you just saw is on a public chain. Testnet, to be clear — Arc mainnet isn't live
> yet.

*(beat)*

> An agent with a stolen key still can't spend outside its policy. That's the product.

---

## Saying it well

**"Zero moved" is the line.** Everything else is setup. Land it, then stop talking for a
second. The silence does more than another sentence would.

**Read the beats.** The `*(beat)*` marks are real. Rushing them is the single most common way
a good demo sounds nervous.

**Don't perform the numbers.** "Twenty dollars total. Two dollars a payment." Flat and fast.
The contrast makes `$0.00` land harder later.

**If the model refuses the attack on its own reasoning, say so.** Out loud, in the moment:

> "It's also decided on its own that this looks like a drain — but that's not the evidence.
> The evidence is the refusal from the contract, and that would've happened either way."

That's a better moment than pretending you didn't notice. Someone will spot it, and if they
catch you smoothing over it they'll discount the rest.

**Say "testnet" once**, plainly, and move on. Burying it reads as a tell.

**Words to not say:** trustless, revolutionary, game-changing, seamless, leverage, unlock.
The demo is the argument.

**If you fluff a line, keep going.** You're going to cut this anyway, and a clean second half
is worth more than a perfect first take.

---

## If you've got 30 seconds spare

After the attack:

> And a kill switch you can only reach from your laptop isn't really a kill switch —

*(phone, showing the same refusal)*

> — so the phone reads the same contract, itself. Same policy, same numbers.

---

## Cut in this order

1. Kill switch (2:18)
2. The approval bit (1:12)
3. The second purchase in the first run

**Never cut:** the attack, the zero, the refusal showing up on chain.

---

## If something breaks mid-take

| | |
|---|---|
| `INSUFFICIENT_BALANCE` | Owner's out of money. Stop, faucet, restart. This is what `pnpm balances` is for. |
| A payment hangs | It's the public RPC, not Arc. Keep talking; it lands. |
| "Cannot reach Arc" on the dashboard | Rate limited. Reload. Nothing on chain changed and the page says as much. |
| Wallet on the wrong account | The bar warns you. Switch. The contract would've refused the write anyway. |

## References

- `docs/demo-script.md` — the click-by-click runbook and the questions to have answers for
- `docs/funding.md` — pre-flight, faucet, wallet setup
