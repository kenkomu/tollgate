# @tollgate/sdk

Give any AI agent a wallet it cannot overspend. The limits live in the Tollgate contract on Arc,
so a prompt-injected model or a stolen agent key still cannot spend outside the owner's policy.

```ts
import {TollgateClient} from "@tollgate/sdk";

const client = new TollgateClient({engine, agentPrivateKey, rpcUrl});
await client.check(payee, usdc("2"));   // free dry run: allowed? why not? would waiting help?
await client.spend(payee, usdc("2"));   // the contract decides; refusals throw PolicyRefusedError
```

## Tools

`createTools(client, {owner?, serviceUrl?})` returns framework-neutral definitions (name,
description, Zod shape, `run`): `check_payment`, `pay`, `get_budget`, `check_gas`,
`resolve_payment`, `request_payee_approval`, `check_approval`. Every adapter below is built on
them, so an agent hears the same wording about refusals and unknown payments everywhere.

## MCP server

```sh
POLICY_ENGINE_ADDRESS=0x… AGENT_PRIVATE_KEY=0x… TOLLGATE_SERVICE_URL=http://localhost:8080 \
  node sdk/src/mcp-server.ts
```

Stdio transport. Works with any MCP client, including Glove's MCP bridge. Set
`ARC_CHAIN_ID=5042` for mainnet.

## Glove

```ts
import {gloveTools} from "@tollgate/sdk/glove";
for (const tool of gloveTools(client, {serviceUrl})) agent.fold(tool);
```

Includes `approve_payee_inline`: the approval request appears as a card in the conversation
(Glove's `pushAndWait`). Render the slot named `approve_payee_inline`; when the owner approves,
have them sign `setPayee` in their own wallet, then resolve `{decision: "approved"}`. The tool
then reads the on-chain allowlist and reports what the chain says, not what the card said.
With no display it falls back to the inbox below.

The Glove shapes follow Glove's public docs and have not been run against a live Glove install.

## Approval inbox

`ApprovalInbox` files a request with the Tollgate service (which pushes it to the owner's phone)
and returns an id the agent checks later. "Approved" is decided by the chain alone: a payee is
approved when `isAllowedPayee(owner, payee)` is true, whatever the service says.
