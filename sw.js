// 오프라인 지원: 네트워크 우선, 실패하면 캐시.
// 앱 파일은 매번 서버에 "바뀌었나요?"를 물어봄(cache: 'no-cache'). GitHub Pages가 붙이는 10분 저장 표시 때문에
// 홈 화면 앱이 껐다 켜도 예전 화면을 보여 주는 일을 막음. 안 바뀌었으면 서버가 짧게 "그대로"라고만 답함.
const CACHE = 'weekly-meals-v2';
const OK_ORIGINS = ['https://www.gstatic.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'firebase-config.js'])));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('weekly-meals-v') && k !== CACHE) await caches.delete(k); // 예전 버전 정리
  await self.clients.claim();
})()));
self.addEventListener('fetch', (e) => {
  // 앱 파일, 글꼴, Firebase 라이브러리만 처리. 데이터 연결(Firestore, 로그인)은 건드리지 않음.
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || (u.origin !== location.origin && !OK_ORIGINS.includes(u.origin))) return;
  const own = u.origin === location.origin;
  e.respondWith(
    (own ? fetch(u.href, { cache: 'no-cache' }) : fetch(e.request)).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: own }))
  );
});
