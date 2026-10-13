import assert from "node:assert/strict";
import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {after, before, beforeEach, describe, it} from "node:test";
import type {Address} from "viem";
import {ApprovalInbox} from "../src/approvals.ts";
import type {TollgateClient} from "../src/client.ts";
import {gloveTools} from "../src/glove.ts";

const OWNER = "0x00000000000000000000000000000000000000aa" as Address;
const PAYEE = "0x00000000000000000000000000000000000000bb" as Address;

/** Only the reads the inbox uses. The allowlist is a Set we flip to play "the owner signed". */
function fakeClient(allowed: Set<string>) {
  return {
    owner: async () => OWNER,
    agentAddress: "0x00000000000000000000000000000000000a9e17" as Address,
    policyId: async () => 7n,
    isAllowedPayee: async (payee: Address, _policyId?: bigint) => allowed.has(payee.toLowerCase()),
  } as unknown as TollgateClient;
}

/** A stand-in for the Tollgate service's approvals endpoints. */
let server: Server;
let base: string;
const requests = new Map<string, {outcome: "approved" | "declined" | null}>();

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/approvals") {
        const id = `req-${requests.size + 1}`;
        requests.set(id, {outcome: null});
        res.statusCode = 201;
        return res.end(JSON.stringify({id, ...JSON.parse(body)}));
      }
      const match = /^\/approvals\/(.+)$/.exec(req.url ?? "");
      const found = match && requests.get(decodeURIComponent(match[1]!));
      if (req.method === "GET" && found) return res.end(JSON.stringify(found));
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());
beforeEach(() => requests.clear());

describe("approval inbox", () => {
  it("is pending until the chain says otherwise", async () => {
    const allowed = new Set<string>();
    const inbox = new ApprovalInbox({client: fakeClient(allowed), serviceUrl: base});
    const ticket = await inbox.request({payee: PAYEE, why: "new supplier"});
    assert.ok(ticket);
    assert.equal(await inbox.status(ticket), "pending");

    allowed.add(PAYEE.toLowerCase());
    assert.equal(await inbox.status(ticket), "approved");
  });

  it("does not believe the service: approved there but not on chain is still pending", async () => {
    const inbox = new ApprovalInbox({client: fakeClient(new Set()), serviceUrl: base});
    const ticket = (await inbox.request({payee: PAYEE, why: "x"}))!;
    requests.get(ticket.id)!.outcome = "approved";
    assert.equal(await inbox.status(ticket), "pending");
  });

  it("reports a decline from the service", async () => {
    const inbox = new ApprovalInbox({client: fakeClient(new Set()), serviceUrl: base});
    const ticket = (await inbox.request({payee: PAYEE, why: "x"}))!;
    requests.get(ticket.id)!.outcome = "declined";
    assert.equal(await inbox.status(ticket), "declined");
  });

  it("returns null rather than throwing when no service is reachable", async () => {
    const inbox = new ApprovalInbox({client: fakeClient(new Set()), serviceUrl: "http://127.0.0.1:1"});
    assert.equal(await inbox.request({payee: PAYEE, why: "x"}), null);
  });

  it("waitFor gives up at the deadline with 'pending', not an error", async () => {
    const inbox = new ApprovalInbox({client: fakeClient(new Set()), serviceUrl: base});
    const ticket = (await inbox.request({payee: PAYEE, why: "x"}))!;
    assert.equal(await inbox.waitFor(ticket, {timeoutMs: 50, intervalMs: 10}), "pending");
  });
});

describe("Glove inline approval", () => {
  const inline = (allowed: Set<string>) =>
    gloveTools(fakeClient(allowed), {serviceUrl: base, inlineWaitMs: 100}).find((t) => t.name === "approve_payee_inline")!;

  it("pushes a card with the request, and reports approval only once the chain agrees", async () => {
    const allowed = new Set<string>();
    let pushed: unknown;
    const display = {
      async pushAndWait(input: unknown) {
        pushed = input;
        allowed.add(PAYEE.toLowerCase()); // the owner signed setPayee from the card
        return {decision: "approved"};
      },
    };
    const result = await inline(allowed).do({address: PAYEE, amount: "2.00", why: "new supplier"} as never, display);
    assert.equal(result.status, "success");
    assert.match(result.data.message, /APPROVED on chain/);
    assert.deepEqual((pushed as {input: {payee: string}}).input.payee, PAYEE);
  });

  it("refuses to trust a card that says yes with no signature behind it", async () => {
    const tool = inline(new Set());
    const display = {pushAndWait: async () => ({decision: "approved"})};
    const result = await tool.do({address: PAYEE, why: "x"} as never, display);
    assert.equal(result.status, "error");
    assert.match(result.data.message, /no setPayee has landed/);
  });

  it("falls back to the inbox when nobody is in the chat", async () => {
    const result = await inline(new Set()).do({address: PAYEE, why: "x"} as never);
    assert.equal(result.status, "success");
    assert.match(result.data.message, /Request id: req-1/);
  });
});

describe("AI SDK adapter", () => {
  it("exposes every tool with a schema, and returns refusals as text rather than throwing", async () => {
    const {aiSdkTools} = await import("../src/ai-sdk.ts");
    const tools = aiSdkTools(fakeClient(new Set()), {serviceUrl: base});
    assert.ok(tools.pay && tools.check_payment && tools.request_payee_approval);
    assert.equal(tools.pay.inputSchema.safeParse({address: "0x1", amount: "1"}).success, true);
    const text = await tools.pay.execute({address: "not-an-address", amount: "1"} as never);
    assert.match(text, /Not a valid address/);
  });
});

describe("approvals name the policy", () => {
  it("files the agent's policy id with the request, so the owner approves for the right agent", async () => {
    let filed: Record<string, unknown> = {};
    const capture = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        filed = JSON.parse(body);
        res.statusCode = 201;
        res.end(JSON.stringify({id: "x"}));
      });
    });
    await new Promise<void>((resolve) => capture.listen(0, resolve));
    const url = `http://127.0.0.1:${(capture.address() as AddressInfo).port}`;
    try {
      const inbox = new ApprovalInbox({client: fakeClient(new Set()), serviceUrl: url});
      const ticket = await inbox.request({payee: PAYEE, why: "new supplier"});
      assert.equal(ticket?.policyId, 7n);
      assert.equal(filed.policyId, "7");
      assert.equal(filed.payee, PAYEE);
    } finally {
      capture.close();
    }
  });
});
