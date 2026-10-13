import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {TollgateClient} from "./client.ts";
import {createTools} from "./tools.ts";
import type {Address} from "viem";

/**
 * Expose Tollgate as an MCP server.
 *
 * Any MCP-speaking agent (Claude, Cursor, Glove's MCP bridge) can then spend through the
 * leash. The server holds the *agent's* key, which is the key the policy contract already
 * distrusts by design: it can ask to spend, and nothing more.
 */
export function createMcpServer(client: TollgateClient, owner?: Address): McpServer {
  const server = new McpServer({name: "tollgate", version: "0.1.0"});

  for (const def of createTools(client, owner)) {
    server.registerTool(def.name, {description: def.description, inputSchema: def.shape}, async (input: Record<string, unknown>) => {
      const result = await def.run(input as never);
      return {content: [{type: "text" as const, text: result.text}], isError: !result.ok};
    });
  }

  return server;
}
