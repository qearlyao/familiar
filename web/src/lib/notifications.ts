import { fetchPushKey, removePushSubscription, savePushSubscription } from "./api";

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

const supported = (): boolean =>
  typeof Notification !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;

export function initNotifications(): void {
  if (!supported()) return;
  registrationPromise = navigator.serviceWorker.register("/sw.js").catch(() => null);
}

const getRegistration = (): Promise<ServiceWorkerRegistration | null> =>
  registrationPromise ?? Promise.resolve(null);

export type NotificationState = "on" | "off" | "denied" | "unsupported";

/** The push subscription itself is the per-device source of truth. */
export async function notificationState(): Promise<NotificationState> {
  const registration = await getRegistration();
  if (!registration) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const subscription = await registration.pushManager.getSubscription();
  return subscription && Notification.permission === "granted" ? "on" : "off";
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Call from a user gesture (the settings toggle) — Safari requires one to prompt. */
export async function setNotificationsEnabled(on: boolean): Promise<NotificationState> {
  const registration = await getRegistration();
  if (!registration) return "unsupported";
  if (!on) {
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await removePushSubscription(subscription.endpoint).catch(() => undefined);
      await subscription.unsubscribe();
    }
    return notificationState();
  }
  // Permission prompt first — it must stay inside the click's user activation.
  if (Notification.permission === "default") await Notification.requestPermission();
  if (Notification.permission !== "granted") return notificationState();
  const { key } = await fetchPushKey();
  // A subscription made under a previous server key makes subscribe() throw — drop it first.
  const stale = await registration.pushManager.getSubscription();
  if (stale) await stale.unsubscribe();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
  try {
    await savePushSubscription(subscription.toJSON());
  } catch (error) {
    await subscription.unsubscribe();
    throw error;
  }
  return notificationState();
}
