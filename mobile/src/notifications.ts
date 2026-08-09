import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import {Platform} from "react-native";
import {registerDevice} from "./api.ts";

/**
 * Telling the owner something was blocked, when the app is not open.
 *
 * Two delivery paths, and the distinction matters because only one of them works today
 * without an account:
 *
 *   **Local** — scheduled by this device when it notices something while running. Needs no
 *   credentials, no project, no server. It covers the case where the app is open or
 *   backgrounded, which is most of a demo and a meaningful share of real use.
 *
 *   **Remote (Expo push)** — sent by our service to a device that may be asleep for hours.
 *   This is the one that matters in production, and it needs an EAS project id plus Android
 *   FCM V1 credentials on the owner's Expo account. Expo Go on Android also dropped push in
 *   SDK 53, so it needs a development build.
 *
 * Both are wired. Local works now. Remote registers a token when the environment can produce
 * one and reports plainly when it cannot, rather than failing silently — a notification
 * system that quietly does not work is worse than one that is visibly absent, because the
 * owner stops watching for the alert that never comes.
 */

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    // A blocked payment is worth a sound. It is the one thing this app has to say.
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export type PushState =
  | {kind: "registered"; token: string}
  | {kind: "local-only"; why: string}
  | {kind: "denied"};

/**
 * Ask for permission and register for remote push.
 *
 * Returns `local-only` rather than throwing when remote push is unavailable, because that is
 * the common case in development and it is not an error — local notifications still work.
 */
export async function setUpNotifications(): Promise<PushState> {
  if (Platform.OS === "android") {
    // Android needs a channel before anything can be delivered. `MAX` because the alert this
    // app sends is "your money was stopped"; if that is not worth a heads-up display, nothing
    // this app does is.
    await Notifications.setNotificationChannelAsync("blocked", {
      name: "Blocked payments",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#d66b62",
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  const granted =
    existing.granted || (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return {kind: "denied"};

  if (!Device.isDevice) {
    return {kind: "local-only", why: "Simulators cannot receive remote push."};
  }

  const projectId =
    (Constants.expoConfig?.extra?.eas as {projectId?: string} | undefined)?.projectId ??
    Constants.easConfig?.projectId;

  if (!projectId) {
    return {
      kind: "local-only",
      why: "No EAS project id. Run `eas init` and add FCM credentials for remote push.",
    };
  }

  try {
    const token = (await Notifications.getExpoPushTokenAsync({projectId})).data;
    await registerDevice(token);
    return {kind: "registered", token};
  } catch (error) {
    return {
      kind: "local-only",
      why: error instanceof Error ? error.message : "Could not obtain a push token.",
    };
  }
}

/**
 * Raise a notification from this device, right now.
 *
 * The fallback that needs nothing. When the app is running and its poll turns up a refusal
 * the owner has not seen, this is what tells them — and it is the same content the remote
 * path sends, so the two cannot drift in what they say.
 */
export async function notifyLocally(input: {
  title: string;
  body: string;
  deepLink: string;
}): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: input.title,
      body: input.body,
      data: {url: input.deepLink},
      sound: true,
    },
    // null means "now". A blocked payment is not something to schedule.
    trigger: null,
  });
}

/**
 * What a notification should open.
 *
 * `tollgate://activity/<key>` and `tollgate://approvals/<id>`. Parsed here rather than in the
 * component so the deep-link contract has one definition shared with the service, which
 * generates these strings.
 */
export function routeFor(url: string): {tab: "activity" | "approvals"; id?: string} | null {
  const match = /^tollgate:\/\/(activity|approvals)(?:\/(.+))?$/.exec(url);
  if (!match) return null;
  const tab = match[1] as "activity" | "approvals";
  const id = match[2];
  return id ? {tab, id} : {tab};
}

export {Notifications};
