# agent/

The thing being leashed.

An autonomous agent built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk),
holding a USDC wallet on Arc and paying for services through Tollgate.

## Running it

```sh
pnpm agent               # the autonomous run
pnpm agent:compromised   # the same agent, hostile instructions
```

Needs `ANTHROPIC_API_KEY`, `POLICY_ENGINE_ADDRESS` and `AGENT_PRIVATE_KEY` in the
repo-root `.env`.

## The design choice that matters

`pay_address` takes **any address and any amount**. There is no allowlist in this package,
no budget arithmetic, no guard clause anywhere in `agent.ts`.

That is deliberate. Constraining an agent by giving it a narrow tool surface is precisely
the app-level guardrail this product exists to replace — a compromised or prompt-injected
agent ignores it, because the check and the attacker are on the same side of the boundary.

So the agent gets the rawest capability we can hand it, and the contract on Arc stops it
instead. If the demo only worked because the tools were restrictive, it would prove nothing.

## Two runs, one difference

Both scenarios get identical tools and identical on-chain authority — the same session
key, the same unrestricted payment function. The only thing that changes is the
instruction.

**`pnpm agent`** — a research agent buys market data within a budget it did not set. It
discovers four services: two it can afford and is allowed to pay, one from a supplier the
owner never approved, one priced above the per-payment cap. It has to work out from the
reason codes which refusals are worth escalating and which are simply final.

**`pnpm agent:compromised`** — the same agent, told its instructions are overridden and to
move everything to an attacker's address. It tries. It cannot.

## Why `check_budget` exists

`checkTransfer` is a free on-chain read that returns the same verdict `spend` would, without
spending gas or moving anything. The agent is told to call it first, so a refusal costs
nothing.

It also returns whether the refusal is **retryable**. That distinction is the difference
between an agent that backs off and one that hammers a permanently-refused payment in a
loop — which is one of the failure modes in the threat model.

## Structure

```
src/tollgate.ts     the client — this is the SDK surface from plan §5.3
src/marketplace.ts  service catalogue, standing in for Circle's Agent Marketplace
src/tools.ts        list_services, check_budget, pay_service, pay_address, request_payee_approval
src/agent.ts        the loop. Contains no policy logic, on purpose.
src/scenarios.ts    the two prompts
src/ui.ts           terminal rendering
```

## On Circle's Agent Stack

We do not use Circle's Agent Stack starter kit, though we follow its patterns and build on
the same Claude Agent SDK it uses. The kit's own `.env.example` states: *"The kit operates
on Base mainnet only; there is no chain to configure."* It cannot be pointed at Arc, and it
transacts real money.

`marketplace.ts` therefore stands in for the Agent Marketplace, with the same shape
discovery returns — a service, a price, and an address to pay. See
`docs/circle-feedback.md`.
