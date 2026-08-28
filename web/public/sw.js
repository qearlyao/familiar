// ponytail: notification-only service worker — no fetch handler, no caching.
// No caches to migrate, so take over immediately instead of waiting for all tabs to close.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function syncSubscription(subscription) {
  const response = await fetch("/api/web/push/subscriptions", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!response.ok) throw new Error(`push subscription sync failed: ${response.status}`);
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      if (event.newSubscription) await syncSubscription(event.newSubscription);
    })().catch((error) => console.error("push subscription change failed:", error)),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* malformed payload — show the fallback */
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      // The app is front and center — the message is already on screen.
      if (wins.some((win) => win.visibilityState === "visible" && win.focused)) return;
      return self.registration.showNotification(data.title || "new message", {
        body: data.body || "",
        tag: data.tag || undefined,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
      });
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const win = wins[0];
      return win ? win.focus() : self.clients.openWindow("/");
    }),
  );
});
