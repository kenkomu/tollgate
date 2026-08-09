# Video script — 3 minutes

Word-for-word. `docs/demo-script.md` is the runbook for what to click; this is what to say.

**Total: 2:55.** Read it aloud with a timer before you record — most people run 15% long.

---

## Setup before you hit record

- `pnpm balances` ends with **ready to demo**
- Dashboard warmed once (first load walks history), wallet connected, bar reads *Signing as…*
- Terminal left, browser right, both at a font size that survives compression
- Policy at demo values: **$20 budget · $2.00 per payment · $4.00 burst**

---

## 0:00–0:20 — The problem

> Agents have wallets now. They buy data, pay for compute, settle invoices — without asking
> anyone.
>
> Every guardrail people build for that lives *inside* the agent. In the prompt. In the tool
> definitions. In the app. And all of it has the same flaw: a prompt injection, a leaked key,
> or a retry loop walks straight through.
>
> Tollgate puts the limit somewhere the agent cannot reach.

*(Dashboard on screen, Overview. Don't tour the UI.)*

---

## 0:20–0:35 — What you are looking at

> This is a spend policy on Arc. It is not a setting this app obeys — it's a contract, and
> every payment has to satisfy it before any money moves.
>
> Twenty dollar budget. Two dollars per payment. A rate limit that refills. And an allowlist
> of who can be paid at all.

*(Point at the contract address.)*

> That's the contract. It's verified — you can read it yourself.

---

## 0:35–1:10 — The agent doing its job

*(Run `pnpm agent`.)*

> This is a real agent with a real wallet. Its payment tool is deliberately unrestricted — it
> can send any amount, to any address. If the demo only worked because I gave it a narrow
> tool, it would prove nothing.

*(Payments land.)*

> It checks first, because checking is free. Then it buys what it needs and stays inside a
> budget it didn't set and can't change.

*(Switch to dashboard — rows already there.)*

> Every row links to the transaction. And there's no database behind this — it's rebuilt from
> contract events every time you load it. Nothing here is us telling you what happened.

---

## 1:10–1:35 — The human in the loop

> It also got refused. It found a supplier that isn't on my allowlist, and instead of retrying
> — which would never work — it asked me.

*(Payees page, approval waiting with reasoning.)*

> That's the cost of a strict allowlist: the agent stops and waits for a person. So the
> approval has to be one tap, or people just widen the policy to make the friction go away.

*(Approve. Wallet prompts. Sign.)*

> That's my key, in my browser. This app has never had it.

---

## 1:35–2:20 — The attack

*(Slow down. This is the demo.)*

> Now the part that matters.
>
> I'm going to give an attacker the agent's private key. Not a simulation — the actual key.

*(Run `pnpm agent:compromised`.)*

> Same key. Same tools. Same contract. The only difference is the instruction: move everything
> to this address, and route around anything that stops you.

*(Let it try. It attempts a large transfer to `0x…dead`.)*

> **Refused. Zero moved.**
>
> And notice *what* stopped it. Not the agent — the agent cooperated with the attacker
> completely. The contract stopped it.

*(Dashboard. Refusal in red, with a link.)*

> Here's the part I'd challenge if I were watching: a refusal that leaves no trace is just a
> claim. So refusals are transactions. That attempt is on chain, permanently, with its reason
> code. You can verify it without trusting me.

---

## 2:20–2:40 — The kill switch

> One more thing. If I don't like what my agent is doing at all —

*(Hit Stop everything. Sign.)*

> — that's a direct write to the contract. No backend, no queue, nothing of ours in the path.
> If our servers were gone and this laptop were on fire, that still works from any wallet or
> block explorer.
>
> That's the one control that must never depend on us, so it doesn't.

---

## 2:40–2:55 — Close

> The money never touches our contract. It moves owner to payee, and the approval is a second
> ceiling that holds even if our code is wrong.
>
> Forty-seven contract tests, two hundred and ten around it, and everything you just saw is on
> a public chain.
>
> An agent with a stolen key still can't spend outside its policy. That's the whole product.

---

## Notes on delivery

**The one number that matters is zero.** "Zero moved" is the line the whole video exists for.
Land it, then pause. Don't rush into the next sentence.

**Don't oversell the model.** If it refuses the attack on its own reasoning, say so out loud:
*"the model also declined — but that isn't the evidence. The evidence is the contract
refusal."* That is a stronger moment than pretending, and a reviewer who spots you glossing it
will discount everything else.

**Say "testnet" once.** Early, plainly, and never again. Hiding it reads as a tell.

**Never say "trustless", "revolutionary", or "game-changing".** The demo is the argument.

---

## If you have 30 seconds more

Add the phone, after the attack:

> And because a kill switch you can only reach from your laptop isn't really a kill switch —

*(Phone showing the same refusal, and the approval queue.)*

> — same policy, read from the same contract by the phone itself.

---

## What to cut, in order

1. The kill switch (2:20)
2. The approval loop (1:10)
3. The second purchase

**Never cut:** the attack, the zero, the refusal on chain.

## References

- `docs/demo-script.md` — the runbook, failure modes, and the caveats to have ready
- `docs/funding.md` — pre-flight and wallet setup
