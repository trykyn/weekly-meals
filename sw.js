// 오프라인 지원: 네트워크 우선, 실패하면 캐시.
const CACHE = 'weekly-meals-v1';
const OK_ORIGINS = ['https://www.gstatic.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'firebase-config.js'])));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  // 앱 파일, 글꼴, Firebase 라이브러리만 처리. 데이터 연결(Firestore, 로그인)은 건드리지 않음.
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || (u.origin !== location.origin && !OK_ORIGINS.includes(u.origin))) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
