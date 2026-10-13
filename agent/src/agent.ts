import {createSdkMcpServer, query} from "@anthropic-ai/claude-agent-sdk";
import type {Address} from "viem";
import {createTollgateTools, type EventSink} from "./tools.ts";
import type {TollgateClient} from "@tollgate/sdk";

const SERVER_NAME = "tollgate";

/** MCP exposes tools as mcp__<server>__<tool>. */
const TOOL_NAMES = [
  "list_services",
  "check_budget",
  "pay_service",
  "pay_address",
  "request_payee_approval",
].map((t) => `mcp__${SERVER_NAME}__${t}`);

export interface RunOptions {
  client: TollgateClient;
  owner: Address;
  prompt: string;
  systemPrompt: string;
  emit: EventSink;
  maxTurns?: number;
  model?: string;
}

/**
 * Runs the agent loop.
 *
 * Note what is NOT here: any check on what the agent is about to do. There is no
 * allowlist in this file, no budget arithmetic, no guard clause. Every constraint lives
 * in the contract on Arc. That is the entire argument — enforcement below the model,
 * where a compromised model cannot reach it.
 */
export async function runAgent(options: RunOptions): Promise<string> {
  const {client, owner, prompt, systemPrompt, emit, maxTurns = 24, model} = options;

  const server = createSdkMcpServer({
    name: SERVER_NAME,
    version: "0.1.0",
    instructions:
      "Tollgate governs every payment you make. check_budget is free and never moves money; " +
      "use it before paying. A refusal is final unless it says retrying could help.",
    tools: createTollgateTools(client, owner, emit),
  });

  const response = query({
    prompt,
    options: {
      systemPrompt,
      mcpServers: {[SERVER_NAME]: server},
      allowedTools: TOOL_NAMES,
      // The agent gets its tools and nothing else — no file system, no shell.
      disallowedTools: ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch"],
      permissionMode: "bypassPermissions",
      // Don't inherit the host's CLAUDE.md or settings; this agent runs clean.
      settingSources: [],
      maxTurns,
      ...(model ? {model} : {}),
    },
  });

  let final = "";
  for await (const message of response) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          emit({kind: "thinking", text: block.text.trim()});
        }
      }
    } else if (message.type === "result") {
      final = message.subtype === "success" ? message.result : `ended: ${message.subtype}`;
    }
  }
  return final;
}
