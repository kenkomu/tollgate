#!/usr/bin/env node
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import type {Address, Hex} from "viem";
import {TollgateClient} from "./client.ts";
import {createMcpServer} from "./mcp.ts";

/**
 * Run Tollgate as a stdio MCP server.
 *
 *   POLICY_ENGINE_ADDRESS  the deployed PolicyEngine
 *   AGENT_PRIVATE_KEY      the agent's session key (never the owner's)
 *   ARC_RPC_URL            optional; ARC_CHAIN_ID=5042 selects mainnet
 *
 * Logs go to stderr: stdout belongs to the protocol.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`tollgate-mcp: missing ${name}`);
    process.exit(1);
  }
  return value;
}

const client = new TollgateClient({
  engine: required("POLICY_ENGINE_ADDRESS") as Address,
  agentPrivateKey: required("AGENT_PRIVATE_KEY") as Hex,
  rpcUrl: process.env.ARC_RPC_URL,
});

await createMcpServer(client).connect(new StdioServerTransport());
console.error("tollgate-mcp: ready on stdio");
