import {explainToOwner, formatUsdc, type Activity} from "@tollgate/shared";
import type {ApprovalRow, Store} from "./store.ts";

/**
 * Telling the owner something happened.
 *
 * The thing worth getting right here is not the transport — it is deciding *what is worth
 * interrupting someone for*. A notification layer that reports every event trains its
 * recipient to ignore it, and the two events this product exists to surface are exactly the
 * two that get buried: a refusal, and an agent stuck waiting on a human.
 *
 * So the rule is narrow and stated once: **notify when the owner can do something about it,
 * or when something was stopped.** A successful payment is not news; it is what was supposed
 * to happen. It lands in the audit log and nowhere else.
 */

export interface Notification {
  eventKey: string;
  title: string;
  body: string;
  /** Where a phone should land when this is tapped. */
  deepLink: string;
  urgency: "high" | "normal";
}

/** Something a notification can be sent over. FCM implements this; so does the log. */
export interface Channel {
  readonly name: string;
  send(tokens: readonly string[], notification: Notification): Promise<void>;
}

/**
 * The default channel until FCM credentials exist.
 *
 * Deliberately real rather than a stub that throws: the delivery *decision* — what is worth
 * sending, and the cursor that stops it being sent twice — is the part with the bugs in it,
 * and it is fully exercised by writing to stdout. Swapping in FCM later changes one class and
 * nothing about when a notification fires.
 */
export const consoleChannel: Channel = {
  name: "console",
  async send(tokens, notification) {
    console.log(
      `[notify:${notification.urgency}] ${notification.title} — ${notification.body} ` +
        `(${tokens.length} device(s)) ${notification.deepLink}`,
    );
  },
};

/** What a refusal or an escalation should say to a human, in a sentence they can act on. */
export function describeForOwner(event: Activity): Notification | null {
  switch (event.kind) {
    case "refused":
      return {
        eventKey: event.key,
        title: "A payment was blocked",
        body:
          `${event.amount === undefined ? "A payment" : formatUsdc(event.amount)} to ` +
          `${short(event.payee)} was refused: ` +
          `${event.reason === undefined ? "policy violation" : explainToOwner(event.reason).toLowerCase()}.`,
        deepLink: `tollgate://activity/${event.key}`,
        urgency: "high",
      };

    case "paused":
      return {
        eventKey: event.key,
        title: "Agent stopped",
        body: "Every payment is now being refused until you resume.",
        deepLink: "tollgate://policy",
        urgency: "high",
      };

    /**
     * Not notified, deliberately:
     *
     *   paid            — the expected case. Reporting it is how the channel becomes noise.
     *   payee-allowed   — the owner just did this themselves.
     *   payee-removed   — same.
     *   resumed         — same.
     *   policy-created  — same.
     */
    default:
      return null;
  }
}

/**
 * The agent is blocked on the owner. This is the second of the two things worth interrupting
 * someone for, and until now it reached the phone only if the owner happened to open the app:
 * the request sat in the queue while the agent waited on a human who did not know.
 */
export function describeApproval(approval: ApprovalRow): Notification {
  return {
    eventKey: `approval:${approval.id}`,
    title: "Your agent is waiting on you",
    body:
      `It wants to pay ${short(approval.payee)}${approval.amount ? ` ${approval.amount}` : ""}` +
      `${approval.why ? `: ${approval.why}` : "."}`,
    deepLink: `tollgate://approvals/${approval.id}`,
    urgency: "high",
  };
}

function short(address?: string): string {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "an address";
}

/**
 * Deliver anything new, exactly once.
 *
 * The claim/send order matters and is the opposite of what feels natural. Claiming first
 * means a crash between claim and send loses a notification; sending first means a crash
 * between send and claim sends it again on the next pass, forever, until it succeeds. For a
 * security alert the second is worse: a channel that repeats itself gets muted, and a muted
 * channel misses the next real thing.
 */
export class Notifier {
  #store: Store;
  #channel: Channel;

  constructor(store: Store, channel: Channel = consoleChannel) {
    this.#store = store;
    this.#channel = channel;
  }

  async notifyNew(owner: `0x${string}`, events: readonly Activity[]): Promise<number> {
    const devices = this.#store.devicesFor(owner);
    let sent = 0;

    for (const event of events) {
      const notification = describeForOwner(event);
      if (!notification) continue;

      // Claimed before sending. Losing one alert beats an alert loop.
      if (!this.#store.claimNotification(notification.eventKey, this.#channel.name)) continue;

      await this.#channel.send(
        devices.map((device) => device.token),
        notification,
      );
      sent++;
    }

    return sent;
  }

  /** One push per request, however many times the agent asks. Claimed by request id. */
  async notifyApproval(owner: `0x${string}`, approval: ApprovalRow): Promise<boolean> {
    const notification = describeApproval(approval);
    if (!this.#store.claimNotification(notification.eventKey, this.#channel.name)) return false;
    await this.#channel.send(
      this.#store.devicesFor(owner).map((device) => device.token),
      notification,
    );
    return true;
  }
}
