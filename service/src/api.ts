import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import {isAddress, type Address} from "viem";
import type {ApprovalRow, Store} from "./store.ts";

/**
 * The read API the phone talks to.
 *
 * Built on `node:http` with a small router rather than a framework, because the surface is
 * eight endpoints and none of them needs middleware. Fewer dependencies in the thing that
 * sits next to money is a feature.
 *
 * **This API cannot authorise anything.** It serves indexed history, accepts approval
 * requests, and registers devices. Every action that changes policy or moves money is a
 * signed transaction from the owner's own key — from the browser today, from the phone's
 * Keystore next. If this service is compromised, the attacker gets a read replica and a
 * notification channel. They do not get the ability to spend, pause, or allowlist anything.
 * That property is the reason the whole system is shaped the way it is, and it is worth not
 * quietly giving away the first time an endpoint would be convenient.
 */

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

/** JSON, with bigint rendered as a decimal string rather than throwing. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    // The phone and the dashboard are separate origins. Reads are public data — every row
    // here is already on a public chain — so there is nothing to protect by refusing them.
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A request body this large is not one of ours.
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export interface ApiConfig {
  store: Store;
  owner: Address;
  engine: Address;
  /** Reports how far the indexer has got, so a client can tell fresh data from stale. */
  head?: () => Promise<bigint | null>;
  /** Called after an approval request is filed, so the owner hears about it. Never blocks the reply. */
  onApprovalRequested?: (approval: ApprovalRow) => Promise<unknown> | void;
}

export function createApi(config: ApiConfig): Server {
  const {store, owner, engine} = config;
  const routes: Route[] = [];

  function route(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" +
        path.replace(/:([A-Za-z]+)/g, (_match, key: string) => {
          keys.push(key);
          return "([^/]+)";
        }) +
        "/?$",
    );
    routes.push({method, pattern, keys, handler});
  }

  /**
   * Health, and honestly.
   *
   * `indexedThrough` is the important field. A client that cannot tell how stale this data is
   * has to assume it is current, and assuming a spend limit is current when it is an hour old
   * is the exact failure ADR 0007 forbids on the phone. Serving the cursor lets the app say
   * "as of 3 minutes ago" instead of implying "now".
   */
  route("GET", "/health", async (_req, res) => {
    const head = config.head ? await config.head() : null;
    json(res, 200, {
      ok: true,
      engine,
      owner,
      indexedThrough: store.lastIndexedBlock(),
      chainHead: head,
      events: store.eventCount(),
    });
  });

  route("GET", "/activity", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
    json(res, 200, {
      indexedThrough: store.lastIndexedBlock(),
      entries: store.activityFor(owner, limit),
    });
  });

  route("GET", "/approvals", (_req, res) => {
    json(res, 200, {approvals: store.openApprovals(owner)});
  });

  route("GET", "/approvals/:id", (_req, res, params) => {
    const approval = store.approvalById(params.id ?? "");
    if (!approval) return json(res, 404, {error: "no such approval"});
    json(res, 200, approval);
  });

  /** The agent asks for a payee it cannot pay. The only escalation path out of the allowlist. */
  route("POST", "/approvals", async (req, res) => {
    const body = await readJson(req);
    const payee = String(body.payee ?? "");
    if (!isAddress(payee, {strict: false})) return json(res, 400, {error: "payee is not an address"});

    const approval = store.requestApproval({
      owner,
      serviceId: String(body.serviceId ?? "direct"),
      serviceName: String(body.serviceName ?? "Direct payment"),
      payee: payee as Address,
      amount: String(body.amount ?? "0"),
      why: String(body.why ?? ""),
    });
    json(res, 201, approval);
    // After replying: the agent must not wait on a push provider to learn its ask was filed.
    if (approval.resolvedAt === null) {
      void Promise.resolve(config.onApprovalRequested?.(approval)).catch((error) =>
        console.error("approval notification failed:", error),
      );
    }
  });

  /**
   * Record that a human decided.
   *
   * Worth being explicit, because the endpoint name invites the wrong assumption: this grants
   * nothing. Allowlisting a payee is `setPayee` signed by the owner. This closes the request
   * so it stops appearing in the queue and on the phone.
   */
  route("POST", "/approvals/:id/resolve", async (req, res, params) => {
    const body = await readJson(req);
    const outcome = body.outcome === "approved" ? "approved" : "declined";
    const ok = store.resolveApproval(params.id ?? "", outcome);
    if (!ok) return json(res, 404, {error: "no such open approval"});
    json(res, 200, {ok: true, outcome});
  });

  route("POST", "/devices", async (req, res) => {
    const body = await readJson(req);
    const token = String(body.token ?? "");
    if (!token) return json(res, 400, {error: "token required"});
    store.registerDevice({
      token,
      owner,
      platform: String(body.platform ?? "android"),
    });
    json(res, 201, {ok: true});
  });

  route("POST", "/devices/forget", async (req, res) => {
    const body = await readJson(req);
    store.forgetDevice(String(body.token ?? ""));
    json(res, 200, {ok: true});
  });

  return createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return json(res, 204, {});

      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      for (const candidate of routes) {
        if (candidate.method !== req.method) continue;
        const match = candidate.pattern.exec(path);
        if (!match) continue;

        const params: Record<string, string> = {};
        candidate.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(match[index + 1] ?? "");
        });
        return await candidate.handler(req, res, params);
      }

      json(res, 404, {error: "not found"});
    } catch (error) {
      console.error("request failed:", error);
      json(res, 500, {error: error instanceof Error ? error.message : "internal error"});
    }
  });
}
