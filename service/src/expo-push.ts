import type {Channel, Notification} from "./notifications.ts";
import type {Store} from "./store.ts";

/**
 * Delivery over Expo's push service.
 *
 * Chosen over talking to FCM directly because it is one HTTP POST with no service-account
 * key to hold: Expo brokers to FCM and APNs, and the credentials live in the owner's Expo
 * account rather than in this process. For a service whose whole claim is that compromising
 * it gains an attacker nothing, one fewer credential on disk is worth having.
 *
 * https://docs.expo.dev/push-notifications/sending-notifications/
 */

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** Expo's documented limit. Larger batches are rejected rather than truncated. */
const MAX_PER_REQUEST = 100;

interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: {error?: string};
}

export class ExpoPushChannel implements Channel {
  readonly name = "expo-push";

  #store: Store;
  #fetch: typeof fetch;

  constructor(store: Store, fetchImpl: typeof fetch = fetch) {
    this.#store = store;
    this.#fetch = fetchImpl;
  }

  async send(tokens: readonly string[], notification: Notification): Promise<void> {
    if (tokens.length === 0) return;

    for (let i = 0; i < tokens.length; i += MAX_PER_REQUEST) {
      const batch = tokens.slice(i, i + MAX_PER_REQUEST);

      const messages = batch.map((to) => ({
        to,
        title: notification.title,
        body: notification.body,
        data: {url: notification.deepLink},
        sound: "default",
        // Android channel created by the app. Without it a high-priority alert is delivered
        // silently on Android 8+, which for this product means the one message that matters
        // arrives as a badge nobody looks at.
        channelId: "blocked",
        priority: notification.urgency === "high" ? "high" : "normal",
      }));

      const response = await this.#fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {"content-type": "application/json", accept: "application/json"},
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        throw new Error(`Expo push rejected the batch: ${response.status} ${response.statusText}`);
      }

      const body = (await response.json()) as {data?: ExpoTicket[]};
      this.#reap(batch, body.data ?? []);
    }
  }

  /**
   * Forget tokens Expo says are dead.
   *
   * `DeviceNotRegistered` means the app was uninstalled or the token rotated. Keeping it
   * means every future alert wastes a request on a device that will never receive it, and
   * — worse — a delivery failure that looks like a transport problem when it is not.
   *
   * Only this specific error removes a token. A transient failure must never be read as
   * "this device is gone", or one bad network moment quietly unsubscribes the owner.
   */
  #reap(tokens: readonly string[], tickets: readonly ExpoTicket[]): void {
    tickets.forEach((ticket, index) => {
      if (ticket.status !== "error") return;
      const token = tokens[index];
      if (!token) return;

      if (ticket.details?.error === "DeviceNotRegistered") {
        this.#store.forgetDevice(token);
        console.log(`dropped dead push token ${token.slice(0, 24)}…`);
      } else {
        console.error(`push failed for ${token.slice(0, 24)}…: ${ticket.message ?? "unknown"}`);
      }
    });
  }
}
