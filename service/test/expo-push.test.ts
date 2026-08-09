import assert from "node:assert/strict";
import {beforeEach, describe, it} from "node:test";
import type {Address} from "viem";
import {openMemoryDb} from "../src/db.ts";
import {ExpoPushChannel} from "../src/expo-push.ts";
import {Store} from "../src/store.ts";
import type {Notification} from "../src/notifications.ts";

const OWNER = "0x8dEa7F60FB144Ea127F6806302E6a83913348B69" as Address;

const alert: Notification = {
  eventKey: "0xaaa:0",
  title: "A payment was blocked",
  body: "$19.00 to 0x0000…dead was refused: payee is not on your allowlist.",
  deepLink: "tollgate://activity/0xaaa:0",
  urgency: "high",
};

let store: Store;
let sent: unknown[];

/** Stands in for Expo's push endpoint, recording what was posted. */
function fakeExpo(tickets: (index: number) => unknown, ok = true): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const messages = JSON.parse(String(init?.body)) as unknown[];
    sent.push(...messages);
    return {
      ok,
      status: ok ? 200 : 502,
      statusText: ok ? "OK" : "Bad Gateway",
      json: async () => ({data: messages.map((_, i) => tickets(i))}),
    };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  store = new Store(openMemoryDb());
  sent = [];
});

describe("sending", () => {
  it("posts one message per token", async () => {
    const channel = new ExpoPushChannel(store, fakeExpo(() => ({status: "ok"})));
    await channel.send(["tok-a", "tok-b"], alert);

    assert.equal(sent.length, 2);
    assert.deepEqual(
      sent.map((m) => (m as {to: string}).to),
      ["tok-a", "tok-b"],
    );
  });

  it("carries the deep link so a tap opens the right thing", async () => {
    // A notification the owner cannot act on has wasted an interruption.
    const channel = new ExpoPushChannel(store, fakeExpo(() => ({status: "ok"})));
    await channel.send(["tok"], alert);
    assert.equal((sent[0] as {data: {url: string}}).data.url, "tollgate://activity/0xaaa:0");
  });

  it("sets the Android channel, or the alert arrives silently", async () => {
    /**
     * Android 8+ drops a high-priority notification to silent without a channel id. For this
     * product that means the one message worth sending lands as a badge nobody looks at.
     */
    const channel = new ExpoPushChannel(store, fakeExpo(() => ({status: "ok"})));
    await channel.send(["tok"], alert);
    assert.equal((sent[0] as {channelId: string}).channelId, "blocked");
    assert.equal((sent[0] as {priority: string}).priority, "high");
  });

  it("does nothing when no device is registered", async () => {
    const channel = new ExpoPushChannel(store, fakeExpo(() => ({status: "ok"})));
    await channel.send([], alert);
    assert.equal(sent.length, 0);
  });

  it("batches beyond Expo's per-request limit", async () => {
    // 150 tokens must not be one oversized request that Expo rejects wholesale.
    const channel = new ExpoPushChannel(store, fakeExpo(() => ({status: "ok"})));
    await channel.send(
      Array.from({length: 150}, (_, i) => `tok-${i}`),
      alert,
    );
    assert.equal(sent.length, 150);
  });

  it("throws when the endpoint itself fails, so the caller can retry", async () => {
    const channel = new ExpoPushChannel(store, fakeExpo(() => ({status: "ok"}), false));
    await assert.rejects(() => channel.send(["tok"], alert));
  });
});

describe("dead tokens", () => {
  beforeEach(() => {
    store.registerDevice({token: "live", owner: OWNER, platform: "android"});
    store.registerDevice({token: "dead", owner: OWNER, platform: "android"});
  });

  it("forgets a token Expo reports as unregistered", async () => {
    // The app was uninstalled or the token rotated. Keeping it wastes a request on every
    // future alert and makes a permanent condition look like a transient failure.
    const channel = new ExpoPushChannel(
      store,
      fakeExpo((i) =>
        i === 1
          ? {status: "error", message: "not registered", details: {error: "DeviceNotRegistered"}}
          : {status: "ok"},
      ),
    );

    await channel.send(["live", "dead"], alert);
    assert.deepEqual(
      store.devicesFor(OWNER).map((d) => d.token),
      ["live"],
    );
  });

  it("keeps a token that failed for any other reason", async () => {
    /**
     * The dangerous direction. Treating a transient error as "this device is gone" means one
     * bad network moment silently unsubscribes the owner from every future alert — and
     * nothing anywhere reports that it happened.
     */
    const channel = new ExpoPushChannel(
      store,
      fakeExpo(() => ({status: "error", message: "rate limited", details: {error: "MessageRateExceeded"}})),
    );

    await channel.send(["live", "dead"], alert);
    assert.equal(store.devicesFor(OWNER).length, 2, "a transient error must not drop a device");
  });

  it("keeps a token when the error has no details at all", async () => {
    const channel = new ExpoPushChannel(store, fakeExpo(() => ({status: "error"})));
    await channel.send(["live", "dead"], alert);
    assert.equal(store.devicesFor(OWNER).length, 2);
  });
});
