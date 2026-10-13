import {z} from "zod";
import type {TollgateClient} from "./client.ts";
import {createTools} from "./tools.ts";
import type {Address} from "viem";

/**
 * Tollgate tools for Glove (https://glove.dterminal.net).
 *
 * Each entry has the shape Glove's `.fold()` documents: `name`, `description`, a Zod
 * `inputSchema` and an async `do`. There is deliberately no import of `glove-core` here, so
 * the SDK has no dependency on it and these definitions can be used with anything that takes
 * the same shape.
 *
 *   const agent = new Glove({...});
 *   for (const t of gloveTools(client)) agent.fold(t);
 *
 * UNVERIFIED against a live Glove install: the shape comes from Glove's public getting-started
 * page, and its docs only say that whatever `do` returns is fed back to the model. The
 * `{status, data}` envelope below follows the page's server-side example; if a Glove version
 * wants something else, this is the one place to change.
 */
export function gloveTools(client: TollgateClient, owner?: Address) {
  return createTools(client, owner).map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: z.object(def.shape),
    async do(input: never) {
      const result = await def.run(input);
      return {status: result.ok ? ("success" as const) : ("error" as const), data: {message: result.text}};
    },
  }));
}
