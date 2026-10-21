/*
 * Freeze Pipe ERP service worker (hand-written, no Workbox).
 *
 * - Navigations: network-first; the last good HTML shell is cached as
 *   /index.html and served when the network is down.
 * - /assets/*: cache-first. Vite hashes these file names and vercel.json
 *   marks them immutable, so a cached copy is never stale.
 * - Same-origin GETs only. Supabase, Sentry and anything cross-origin pass
 *   straight through.
 *
 * VERSION is stamped at build time (vite.config.ts) with a hash of
 * the bundle, so every deploy ships a byte-different worker. The browser
 * installs it as "waiting"; the page shows a "New version available" toast
 * and posts SKIP_WAITING when the user taps Reload.
 */
const VERSION = "__SW_VERSION__";
const SHELL_CACHE = `fp-shell-${VERSION}`;
const ASSET_CACHE = `fp-assets-${VERSION}`;
const KEEP = [SHELL_CACHE, ASSET_CACHE];
const SHELL_URL = "/index.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.add(new Request(SHELL_URL, { cache: "reload" })))
      .catch(() => undefined),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("fp-") && !KEEP.includes(key))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstShell(request));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
  }
});

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    const type = response.headers.get("content-type") || "";
    // Every SPA route rewrites to index.html; only cache real HTML so a
    // directly-opened image or file never poisons the shell.
    if (response.ok && response.type === "basic" && type.includes("text/html")) {
      await cache.put(SHELL_URL, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(SHELL_URL);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    await cache.put(request, response.clone());
  }
  return response;
}
