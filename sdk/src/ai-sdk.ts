import {z} from "zod";
import type {TollgateClient} from "./client.ts";
import {createTools, type ToolOptions} from "./tools.ts";

/**
 * Tollgate tools for the Vercel AI SDK.
 *
 *   import {generateText} from "ai";
 *   const result = await generateText({model, tools: aiSdkTools(client), prompt});
 *
 * Returns the record shape `generateText` / `streamText` take for `tools`: each entry has a
 * `description`, a Zod `inputSchema` and an async `execute`. The AI SDK's `tool()` helper only
 * adds types around this shape, so no dependency on `ai` is needed here.
 *
 * Written against AI SDK v5's field names (`inputSchema`, `execute`); v4 called the schema
 * `parameters`, and `legacy: true` emits that as well. Not yet run against a live install.
 */
export function aiSdkTools(client: TollgateClient, options: ToolOptions & {legacy?: boolean} = {}) {
  const out: Record<
    string,
    {description: string; inputSchema: z.ZodTypeAny; parameters?: z.ZodTypeAny; execute: (input: never) => Promise<string>}
  > = {};

  for (const def of createTools(client, options)) {
    const schema = z.object(def.shape);
    out[def.name] = {
      description: def.description,
      inputSchema: schema,
      ...(options.legacy ? {parameters: schema} : {}),
      // The model reads a string; refusals and failures are normal results it must act on,
      // not exceptions that would end the run.
      execute: async (input: never) => (await def.run(input)).text,
    };
  }

  return out;
}
