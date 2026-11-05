/* Only public app-shell files are cached. API responses and map tiles never enter CacheStorage. */
const SHELL_CACHE = "nexora-shell-v2";
const SHELL_FILES = [
  "/",
  "/index.html",
  "/customer.html",
  "/freight.html",
  "/driver.html",
  "/admin.html",
  "/ops.html",
  "/help.html",
  "/privacy.html",
  "/terms.html",
  "/offline.html",
  "/brand.css",
  "/portal.css",
  "/customer.css",
  "/driver.css",
  "/workspace.css",
  "/network.js",
  "/native-driver.js",
  "/ui.js",
  "/home.js",
  "/session.js",
  "/notifications.js",
  "/customer.js",
  "/freight.js",
  "/driver.js",
  "/workspace.js",
  "/admin.js",
  "/ops.js",
  "/availability.js",
  "/assets/icons.svg",
  "/assets/route.svg",
  "/assets/ride.svg",
  "/assets/delivery.svg",
  "/assets/map-unavailable.svg",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith("nexora-shell-") && name !== SHELL_CACHE)
          await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});
function shellPath(path) {
  if (SHELL_FILES.includes(path)) return path;
  if (SHELL_FILES.includes(path + ".html")) return path + ".html";
  return null;
}
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const path = shellPath(url.pathname);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    !path
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const response = await fetch(event.request);
        if (!response.ok) throw new Error("Unavailable");
        await cache.put(path, response.clone());
        return response;
      } catch {
        return (
          (await cache.match(path)) ||
          (event.request.mode === "navigate"
            ? await cache.match("/offline.html")
            : Response.error())
        );
      }
    })(),
  );
});
self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data.json();
  } catch {
    return;
  }
  const url = ["/customer.html", "/driver.html"].includes(data.url)
    ? data.url
    : "/";
  event.waitUntil(
    self.registration.showNotification(String(data.title || "Nexora"), {
      body: String(data.body || "You have an update."),
      tag: String(data.tag || "nexora"),
      data: { url },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin)
    .href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing = windows.find(
        (client) =>
          new URL(client.url).pathname.replace(/\.html$/, "") ===
          new URL(url).pathname.replace(/\.html$/, ""),
      );
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })(),
  );
});
