import assert from "node:assert/strict";
import {after, before, beforeEach, describe, it} from "node:test";
import type {AddressInfo} from "node:net";
import type {Server} from "node:http";
import type {Address} from "viem";
import {Reason, usdc} from "@tollgate/shared";
import {createApi} from "../src/api.ts";
import {openMemoryDb} from "../src/db.ts";
import {Store, type StoredEvent} from "../src/store.ts";

const OWNER = "0x8dEa7F60FB144Ea127F6806302E6a83913348B69" as Address;
const ENGINE = "0x8168eb562496A966f339a4bD165B924EeDce9873" as Address;
const PAYEE = "0x3333333333333333333333333333333333333333" as Address;

let store: Store;
let server: Server;
let base: string;

before(async () => {
  store = new Store(openMemoryDb());
  server = createApi({store, owner: OWNER, engine: ENGINE, head: async () => 56_000_000n});
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  // Fresh store per test, same server. The API holds no state of its own, which is the
  // property being relied on here — and worth having a test depend on.
  store = new Store(openMemoryDb());
  server.removeAllListeners("request");
  const fresh = createApi({store, owner: OWNER, engine: ENGINE, head: async () => 56_000_000n});
  for (const listener of fresh.listeners("request")) {
    server.on("request", listener as never);
  }
});

async function get(path: string) {
  const response = await fetch(`${base}${path}`);
  return {status: response.status, body: (await response.json()) as Record<string, unknown>};
}

async function post(path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(body),
  });
  return {status: response.status, body: (await response.json()) as Record<string, unknown>};
}

function event(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    key: "0xaaa:0",
    kind: "paid",
    owner: OWNER,
    blockNumber: 100n,
    timestamp: 1_700_000_000,
    txHash: "0xaaa",
    amount: usdc("1"),
    payee: PAYEE,
    ...overrides,
  };
}

describe("GET /health", () => {
  it("reports what it is and how far it has indexed", async () => {
    store.setLastIndexedBlock(55_700_000n);
    const {status, body} = await get("/health");

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.engine, ENGINE);
    assert.equal(body.owner, OWNER);
    assert.equal(body.indexedThrough, "55700000");
  });

  it("says it has indexed nothing before the first pass", async () => {
    /**
     * `null`, never 0. A client reading 0 would either start from genesis or conclude the
     * history is empty, and one of those is a dashboard confidently showing no payments for
     * an agent that has been spending all week.
     */
    const {body} = await get("/health");
    assert.equal(body.indexedThrough, null);
  });

  it("exposes the chain head so a client can measure its own staleness", async () => {
    // ADR 0007's rule: a client that cannot tell how old this data is has to assume it is
    // current, and assuming a stale spend limit is current is the failure that matters.
    const {body} = await get("/health");
    assert.equal(body.chainHead, "56000000");
  });
});

describe("GET /activity", () => {
  it("serves indexed events newest first", async () => {
    store.putEvents([
      event({key: "0xa:0", txHash: "0xa", blockNumber: 10n}),
      event({key: "0xb:0", txHash: "0xb", blockNumber: 20n}),
    ]);

    const {status, body} = await get("/activity");
    assert.equal(status, 200);
    const entries = body.entries as Record<string, unknown>[];
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.blockNumber, "20");
  });

  it("renders bigint amounts as strings rather than failing to serialise", async () => {
    // JSON.stringify throws on a bigint. Every amount in this system is one.
    store.putEvents([event({amount: usdc("12.50")})]);
    const {body} = await get("/activity");
    assert.equal((body.entries as Record<string, unknown>[])[0]!.amount, "12500000");
  });

  it("carries the refusal reason through", async () => {
    store.putEvents([event({kind: "refused", reason: Reason.PAYEE_NOT_ALLOWED})]);
    const {body} = await get("/activity");
    const entry = (body.entries as Record<string, unknown>[])[0]!;
    assert.equal(entry.kind, "refused");
    assert.equal(entry.reason, Reason.PAYEE_NOT_ALLOWED);
  });

  it("honours a limit and caps it", async () => {
    store.putEvents(
      Array.from({length: 20}, (_, i) => event({key: `0x${i}:0`, txHash: `0x${i}`, blockNumber: BigInt(i)})),
    );
    assert.equal(((await get("/activity?limit=5")).body.entries as unknown[]).length, 5);
    // An unbounded limit is a way to ask this process to allocate everything it has.
    assert.equal(((await get("/activity?limit=99999")).body.entries as unknown[]).length, 20);
  });

  it("reports staleness alongside the data", async () => {
    store.setLastIndexedBlock(55_700_000n);
    const {body} = await get("/activity");
    assert.equal(body.indexedThrough, "55700000");
  });
});

describe("approvals", () => {
  const request = {
    serviceId: "weather",
    serviceName: "Weather feed",
    payee: PAYEE,
    amount: "$1.50",
    why: "needed for the forecast bundle",
  };

  it("accepts a request and lists it", async () => {
    const created = await post("/approvals", request);
    assert.equal(created.status, 201);
    assert.ok(created.body.id);

    const listed = await get("/approvals");
    assert.equal((listed.body.approvals as unknown[]).length, 1);
  });

  it("rejects a payee that is not an address", async () => {
    const {status, body} = await post("/approvals", {...request, payee: "not-an-address"});
    assert.equal(status, 400);
    assert.match(String(body.error), /address/);
  });

  it("resolves a request by id", async () => {
    const created = await post("/approvals", request);
    const id = String(created.body.id);

    const resolved = await post(`/approvals/${id}/resolve`, {outcome: "approved"});
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.outcome, "approved");
    assert.equal(((await get("/approvals")).body.approvals as unknown[]).length, 0);
  });

  it("still resolves the deep link after the request is handled", async () => {
    // A phone taps a notification for something already dealt with. That must show the
    // outcome, not a 404.
    const created = await post("/approvals", request);
    const id = String(created.body.id);
    await post(`/approvals/${id}/resolve`, {outcome: "declined"});

    const fetched = await get(`/approvals/${id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.outcome, "declined");
  });

  it("404s an unknown approval", async () => {
    assert.equal((await get("/approvals/nope")).status, 404);
    assert.equal((await post("/approvals/nope/resolve", {outcome: "approved"})).status, 404);
  });

  it("treats anything that is not an approval as a decline", async () => {
    // Fail closed. A malformed or hostile body must never be read as consent to pay someone.
    const created = await post("/approvals", request);
    const id = String(created.body.id);
    const resolved = await post(`/approvals/${id}/resolve`, {outcome: "yes-please"});
    assert.equal(resolved.body.outcome, "declined");
  });
});

describe("devices", () => {
  it("registers and forgets a push token", async () => {
    assert.equal((await post("/devices", {token: "abc", platform: "android"})).status, 201);
    assert.equal(store.devicesFor(OWNER).length, 1);

    await post("/devices/forget", {token: "abc"});
    assert.equal(store.devicesFor(OWNER).length, 0);
  });

  it("requires a token", async () => {
    assert.equal((await post("/devices", {platform: "android"})).status, 400);
  });
});

describe("the API cannot authorise anything", () => {
  /**
   * The load-bearing property of this service, asserted rather than assumed.
   *
   * If this process is fully compromised, the attacker gets a read replica and a notification
   * channel. They do not get to spend, pause, or allowlist. Every one of those is a signed
   * transaction from the owner's own key. The day someone adds a convenient `POST /pause`,
   * this test is what should stop them.
   */
  it("exposes no route that could move money or change policy", async () => {
    const forbidden = [
      ["POST", "/pause"],
      ["POST", "/spend"],
      ["POST", "/payees"],
      ["POST", "/policy"],
      ["POST", "/allowlist"],
    ] as const;

    for (const [, path] of forbidden) {
      const response = await fetch(`${base}${path}`, {method: "POST", body: "{}"});
      assert.equal(response.status, 404, `${path} should not exist`);
    }
  });

  it("resolving an approval does not allowlist the payee", async () => {
    // The endpoint name invites the wrong assumption. Approving here records a human
    // decision; the allowlist only changes when the owner signs setPayee.
    const created = await post("/approvals", {
      serviceId: "x",
      serviceName: "X",
      payee: PAYEE,
      amount: "$1",
      why: "test",
    });
    await post(`/approvals/${String(created.body.id)}/resolve`, {outcome: "approved"});

    // Nothing in this service holds an allowlist at all — the assertion is that no such
    // state exists to have been changed.
    const {body} = await get("/health");
    assert.equal(body.ok, true);
    assert.ok(!("allowlist" in body));
  });
});

describe("transport behaviour", () => {
  it("404s an unknown path as JSON, not HTML", async () => {
    const response = await fetch(`${base}/nope`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  });

  it("answers CORS preflight so a phone and a browser can both call it", async () => {
    const response = await fetch(`${base}/activity`, {method: "OPTIONS"});
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });

  it("never lets a client cache policy-derived data", async () => {
    // A cached spend limit is a wrong spend limit.
    const response = await fetch(`${base}/activity`);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  });

  it("survives a malformed JSON body with a 500 rather than dying", async () => {
    const response = await fetch(`${base}/approvals`, {method: "POST", body: "{not json"});
    assert.ok(response.status >= 400);
    // The process must still be answering afterwards.
    assert.equal((await get("/health")).status, 200);
  });
});

describe("the change stream", () => {
  it("delivers a changed event to a connected client", async () => {
    const {Broadcaster} = await import("../src/api.ts");
    const changes = new Broadcaster();
    const streamServer = createApi({store: new Store(openMemoryDb()), owner: OWNER, engine: ENGINE, changes});
    await new Promise<void>((resolve) => streamServer.listen(0, resolve));
    const url = `http://127.0.0.1:${(streamServer.address() as AddressInfo).port}/stream`;

    const controller = new AbortController();
    const response = await fetch(url, {signal: controller.signal});
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    // Wait until the subscription exists before publishing.
    while (changes.size === 0) await new Promise((r) => setTimeout(r, 5));
    changes.publish({block: 123n, events: 1});

    let text = "";
    while (!text.includes("event: changed")) text += decoder.decode((await reader.read()).value);
    assert.match(text, /data: \{"block":"123","events":1\}/);

    controller.abort();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(changes.size, 0, "closing the stream unsubscribes");
    streamServer.close();
  });
});
