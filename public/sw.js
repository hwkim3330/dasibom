// 다시봄 — 최소 서비스워커 (오프라인 셸 + 홈 화면 설치용)
const CACHE = "dasibom-v1";
const SHELL = ["/", "/app.css", "/cam", "/view", "/wall", "/icon.svg"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) =>
    Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.pathname.startsWith("/api/")) return; // 실시간 API는 캐시 금지
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
