/* تخزين غلاف التطبيق والبيانات الناجحة، مع إبقاء طلب الشبكة هو المصدر
   الأول لملفات السوق. رقم النسخة يغيّر عند تغيير بنية الملفات. */
const SHELL = "marsad-shell-v3", DATA = "marsad-data-v3";
const CORE = ["./", "./index.html", "./config.js", "./scans.js", "./plan.js", "./evaluate.js", "./pro.css", "./pro.js"];
self.addEventListener("install", e => e.waitUntil(caches.open(SHELL).then(c => c.addAll(CORE)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => ![SHELL,DATA].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim())));
const clean = req => { const u = new URL(req.url); u.searchParams.delete("t"); return new Request(u.toString(), req); };
async function trim(cache, max = 150) { const keys = await cache.keys(); if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k))); }
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const u = new URL(e.request.url), json = /\.json$/.test(u.pathname);
  if (json) {
    e.respondWith((async () => {
      const c = await caches.open(DATA), key = clean(e.request);
      try { const r = await fetch(e.request); if (r.ok) { await c.put(key, r.clone()); await trim(c); } return r; }
      catch (err) { const old = await c.match(key); if (old) return old; throw err; }
    })());
    return;
  }
  if (u.origin === self.location.origin) e.respondWith(caches.match(e.request).then(old => old || fetch(e.request).then(async r => { if (r.ok) (await caches.open(SHELL)).put(e.request, r.clone()); return r; })));
});
