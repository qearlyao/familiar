import { fetchPushKey, removePushSubscription, savePushSubscription } from "./api";

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
const DESIRED_KEY = "familiar.notifications.enabled";
export const NOTIFICATIONS_CHANGED_EVENT = "familiar:notifications-changed";

const supported = (): boolean =>
  typeof Notification !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;

export function initNotifications(): void {
  if (!supported()) return;
  registrationPromise = navigator.serviceWorker
    .register("/sw.js")
    .then((registration) => {
      void reconcileSubscription(registration)
        .then(() => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT)))
        .catch((error: unknown) => {
          console.error("web push subscription reconciliation failed:", error);
        });
      return registration;
    })
    .catch((error: unknown) => {
      console.error("web push initialization failed:", error);
      return null;
    });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void getRegistration().then((registration) => {
      if (!registration) return;
      return reconcileSubscription(registration);
    })
      .then(() => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT)))
      .catch((error: unknown) => {
        console.error("web push foreground reconciliation failed:", error);
      });
  });
}

const getRegistration = (): Promise<ServiceWorkerRegistration | null> =>
  registrationPromise ?? Promise.resolve(null);

export type NotificationState = "on" | "off" | "denied" | "unsupported";

/** The browser subscription and this installation's explicit opt-out are local state. */
export async function notificationState(): Promise<NotificationState> {
  const registration = await getRegistration();
  if (!registration) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const subscription = await registration.pushManager.getSubscription();
  if (localStorage.getItem(DESIRED_KEY) === "off") return "off";
  if (subscription && Notification.permission === "granted") {
    localStorage.setItem(DESIRED_KEY, "on");
    return "on";
  }
  return "off";
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function reconcileSubscription(registration: ServiceWorkerRegistration): Promise<void> {
  const subscription = await registration.pushManager.getSubscription();
  if (Notification.permission !== "granted") return;
  if (subscription && localStorage.getItem(DESIRED_KEY) !== "off") {
    localStorage.setItem(DESIRED_KEY, "on");
    await savePushSubscription(subscription.toJSON());
    return;
  }
  if (localStorage.getItem(DESIRED_KEY) === "off") return;
  const { key } = await fetchPushKey();
  const renewed = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
  await savePushSubscription(renewed.toJSON());
}

/** Call from a user gesture (the settings toggle) — Safari requires one to prompt. */
export async function setNotificationsEnabled(on: boolean): Promise<NotificationState> {
  const registration = await getRegistration();
  if (!registration) return "unsupported";
  if (!on) {
    localStorage.setItem(DESIRED_KEY, "off");
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await removePushSubscription(subscription.endpoint).catch((error: unknown) => {
        console.error("web push subscription removal failed:", error);
      });
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
    localStorage.setItem(DESIRED_KEY, "on");
  } catch (error) {
    await subscription.unsubscribe();
    throw error;
  }
  return notificationState();
}
