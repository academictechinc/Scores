// Bump CACHE_NAME on every release. Users must fully close and reopen the
// app to pick up a new version (same pattern as the rest of the field-tools
// suite / Logbook / Weather).
const CACHE_NAME = "scores-v1";
const SHELL = ["./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // Never cache live score/news/proxy data - always hit the network.
  if (url.includes("espn.com") || url.includes("allorigins.win") || url.includes("corsproxy.io")) {
    event.respondWith(fetch(event.request).catch(() => new Response("[]", { status: 200 })));
    return;
  }

  // App shell: cache-first, falling back to network.
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
