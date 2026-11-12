/* 考公脑库 · Service Worker
 *
 * 两件事，必须同时成立：
 *
 * 1) **不吃旧版本**（原有职责）。页面曾被下发 Cache-Control: public, max-age=86400，
 *    浏览器和 CDN 边缘节点会把旧版留 24 小时，出现"改完代码打开还是旧界面"。
 *    所以导航请求一律网络优先、带 cache:'reload' 回源；js/css 由服务端自动加
 *    ?v=<指纹>，URL 一变浏览器就必须重新取，天然穿透缓存。
 *
 * 2) **离线能打开**（PWA 壳）。地铁里没网也能翻出已缓存的界面继续做题 ——
 *    但只缓存「壳」（html/js/css/图标），**绝不缓存 /api/**：题目与学习记录
 *    必须实时，缓存出来的进度会让人误以为背过。
 *
 * 缓存名带版本号，activate 时把旧版本整批删掉，不会越滚越大。
 */
const SW_VER = '__APP_VER__';
const CACHE = 'kg-shell-' + SW_VER;

/* 预缓存清单。js/css 的 URL 必须带 ?v=，与 index.html 里的引用逐字一致，
   否则 cache.match 命中不了（多一个 query 就是另一个 URL）。 */
const SHELL = [
  '/index.html',
  '/static/style.css?v=' + SW_VER,
  '/static/app.js?v=' + SW_VER,
  '/static/manifest.webmanifest',
  '/static/icon-192.png',
  '/static/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 逐个加：某个资源 404 不该让整个 SW 装不上
    await Promise.all(SHELL.map(u => c.add(u).catch(() => { })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;
  // 业务数据一律走网络：缓存的题会误导人
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ops/')) return;

  const isNav = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') >= 0;

  if (isNav) {
    // 网络优先：在线永远拿最新；断网才用壳
    e.respondWith((async () => {
      try {
        const r = await fetch('/index.html?v=' + SW_VER, { cache: 'reload' });
        if (r && r.ok) return r;
      } catch (err) { }
      const hit = await caches.match('/index.html');
      if (hit) return hit;
      try { return await fetch(req); } catch (err) {
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>离线</title>' +
          '<body style="font:16px/1.8 system-ui;padding:40px;color:#333">' +
          '<h1>暂时离线</h1><p>本地服务没连上。题库和学习记录都在服务端，' +
          '联网后刷新即可继续。</p></body>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  // 静态资源：带 ?v= 的可以放心 cache-first（内容变了 URL 就变）
  if (url.pathname.startsWith('/static/')) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const r = await fetch(req);
        if (r && r.ok && url.search.indexOf('v=') >= 0) {
          const c = await caches.open(CACHE);
          c.put(req, r.clone());
        }
        return r;
      } catch (err) {
        return new Response('', { status: 504 });
      }
    })());
  }
});
