import assert from "node:assert/strict";
import {beforeEach, describe, it} from "node:test";
import type {Address} from "viem";
import {Reason, usdc, type Activity} from "@tollgate/shared";
import {openMemoryDb} from "../src/db.ts";
import {Notifier, describeForOwner, type Channel, type Notification} from "../src/notifications.ts";
import {Store} from "../src/store.ts";

const OWNER = "0x8dEa7F60FB144Ea127F6806302E6a83913348B69" as Address;
const PAYEE = "0x3333333333333333333333333333333333333333" as Address;

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    key: "0xaaa:0",
    kind: "paid",
    blockNumber: 100n,
    timestamp: 1_700_000_000,
    txHash: "0xaaa",
    amount: usdc("1"),
    payee: PAYEE,
    ...overrides,
  };
}

/** Records what it was asked to send, so delivery decisions are observable. */
function recordingChannel(name = "test"): Channel & {sent: Notification[]} {
  const sent: Notification[] = [];
  return {
    name,
    sent,
    async send(_tokens, notification) {
      sent.push(notification);
    },
  };
}

let store: Store;

beforeEach(() => {
  store = new Store(openMemoryDb());
  store.registerDevice({token: "device-1", owner: OWNER, platform: "android"});
});

describe("what is worth interrupting someone for", () => {
  it("notifies on a refusal", async () => {
    const notification = describeForOwner(
      activity({kind: "refused", reason: Reason.PAYEE_NOT_ALLOWED, amount: usdc("5")}),
    );
    assert.ok(notification);
    assert.equal(notification.urgency, "high");
    assert.match(notification.body, /\$5\.00/);
    assert.match(notification.body, /allowlist/i);
  });

  it("notifies when the agent is paused", () => {
    const notification = describeForOwner(activity({kind: "paused"}));
    assert.ok(notification);
    assert.equal(notification.urgency, "high");
  });

  it("stays silent on a successful payment", () => {
    /**
     * The judgement this module exists to make. A successful payment is what was supposed to
     * happen; reporting it is how the channel becomes noise, and a noisy channel gets muted,
     * and a muted channel misses the refusal that mattered.
     */
    assert.equal(describeForOwner(activity({kind: "paid"})), null);
  });

  it("stays silent on things the owner just did themselves", () => {
    for (const kind of ["payee-allowed", "payee-removed", "resumed", "policy-created"] as const) {
      assert.equal(describeForOwner(activity({kind})), null, `${kind} should not notify`);
    }
  });

  it("carries a deep link to the thing it is about", () => {
    // A notification a phone cannot act on is a notification that wasted an interruption.
    const notification = describeForOwner(activity({kind: "refused", reason: Reason.EXCEEDS_BUDGET}));
    assert.match(notification!.deepLink, /^tollgate:\/\/activity\/0xaaa:0$/);
  });

  it("reads sensibly when the event is missing fields", () => {
    // `strict: false` decoding means a field can genuinely be absent. The message must still
    // be a sentence rather than "undefined to undefined".
    const notification = describeForOwner(activity({kind: "refused", amount: undefined, payee: undefined}));
    assert.ok(notification);
    assert.doesNotMatch(notification.body, /undefined/);
  });
});

describe("delivering exactly once", () => {
  it("sends a refusal once and never again", async () => {
    /**
     * The property the service exists for. Without the claim table, every restart re-reads
     * the chain, finds the same refusals, and alerts about them again.
     */
    const channel = recordingChannel();
    const notifier = new Notifier(store, channel);
    const events = [activity({kind: "refused", reason: Reason.EXCEEDS_BUDGET})];

    assert.equal(await notifier.notifyNew(OWNER, events), 1);
    assert.equal(await notifier.notifyNew(OWNER, events), 0);
    assert.equal(channel.sent.length, 1);
  });

  it("stays silent when the store is rebuilt but the claims survive", async () => {
    const channel = recordingChannel();
    const notifier = new Notifier(store, channel);
    const history = [
      activity({key: "0xa:0", kind: "refused", reason: Reason.EXCEEDS_BUDGET}),
      activity({key: "0xb:0", kind: "refused", reason: Reason.PAYEE_NOT_ALLOWED}),
    ];

    await notifier.notifyNew(OWNER, history);
    channel.sent.length = 0;

    // A full re-index presents the entire history again. It must be silent.
    await notifier.notifyNew(OWNER, history);
    assert.equal(channel.sent.length, 0, "a rebuild must not re-alert");
  });

  it("treats separate channels independently", async () => {
    const push = recordingChannel("push");
    const email = recordingChannel("email");
    const events = [activity({kind: "refused", reason: Reason.EXCEEDS_BUDGET})];

    await new Notifier(store, push).notifyNew(OWNER, events);
    await new Notifier(store, email).notifyNew(OWNER, events);

    assert.equal(push.sent.length, 1);
    assert.equal(email.sent.length, 1, "one channel must not suppress another");
  });

  it("claims before sending, so a failure cannot become a loop", async () => {
    /**
     * Deliberate and counter-intuitive. Claiming first means a crash between claim and send
     * loses one alert. Sending first means a crash between send and claim re-sends forever.
     * For a security alert, a repeating channel is worse than a missed one — it gets muted,
     * and then everything after it is missed too.
     */
    const exploding: Channel = {
      name: "push",
      async send() {
        throw new Error("FCM is down");
      },
    };

    const notifier = new Notifier(store, exploding);
    await assert.rejects(() =>
      notifier.notifyNew(OWNER, [activity({kind: "refused", reason: Reason.EXCEEDS_BUDGET})]),
    );

    // The claim stands, so a retry does not stampede.
    assert.equal(store.claimNotification("0xaaa:0", "push"), false);
  });

  it("still claims when the owner has no devices registered", async () => {
    // Notifications generated before a phone exists must not all fire the moment one appears.
    const empty = new Store(openMemoryDb());
    const channel = recordingChannel();
    const notifier = new Notifier(empty, channel);

    assert.equal(await notifier.notifyNew(OWNER, [activity({kind: "refused", reason: Reason.PAUSED})]), 1);
    assert.equal(channel.sent.length, 1);
    assert.equal(channel.sent[0]!.eventKey, "0xaaa:0");
  });

  it("ignores events that are not worth sending", async () => {
    const channel = recordingChannel();
    const notifier = new Notifier(store, channel);
    const sent = await notifier.notifyNew(OWNER, [
      activity({kind: "paid"}),
      activity({key: "0xb:0", kind: "payee-allowed"}),
    ]);

    assert.equal(sent, 0);
    // And crucially, they are not claimed either — so if the policy on what is notifiable
    // ever changes, past events are still eligible.
    assert.equal(store.claimNotification("0xaaa:0", "test"), true);
  });
});
