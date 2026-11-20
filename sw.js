// Офлайн: всё приложение и данные кешируются при первом открытии.
const VERSION = "v7";
const SHELL = `menu-shell-${VERSION}`;
const RUNTIME = "menu-runtime";
const OCR = "menu-ocr"; // распознавание на телефоне: ~5 МБ, кешируется один раз и не сбрасывается при обновлениях
const FILES = [
  "./", "index.html", "css/app.css", "manifest.webmanifest",
  "js/app.js", "js/data.js", "js/search.js", "js/cards.js", "js/menus.js", "js/store.js", "js/util.js", "js/config.js", "js/ocr.js",
  "vendor/claude.js",
  "data/words.json", "data/chat_menus.json", "data/menus.json",
  "icons/icon.svg", "icons/favicon-32.png", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("menu-shell-") && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(req, timeoutMs = 3000) {
  const cache = await caches.open(SHELL);
  try {
    const res = await Promise.race([
      fetch(req, { cache: "no-cache" }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(req, { ignoreSearch: true });
  const fresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return cached || (await fresh) || Response.error();
}

async function cacheFirst(req, name = RUNTIME) {
  const cache = await caches.open(name);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // Claude API, GitHub API — напрямую
  if (req.mode === "navigate") {
    e.respondWith(networkFirst(new Request("index.html"), 2500));
    return;
  }
  if (url.pathname.includes("/data/")) { e.respondWith(networkFirst(req)); return; }
  if (url.pathname.includes("/photos/")) { e.respondWith(cacheFirst(req)); return; }
  if (url.pathname.includes("/vendor/ocr/")) { e.respondWith(cacheFirst(new Request(url.origin + url.pathname), OCR)); return; }
  e.respondWith(staleWhileRevalidate(req));
});
