// ============================================================
// 军师 - Service Worker
// 简单缓存壳：让"已添加桌面"的 PWA 打开更快、断网也能进首页
// ============================================================

const CACHE_NAME = 'junshi-v3';
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/utils.js',
  './js/session.js',
  './js/supabase.js',
  './js/auth.js',
  './js/friends.js',
  './js/chat.js',
  './js/paywall.js',
  './js/app.js',
  './js/install-prompt.js',
  './icons/icon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.ico'
];

// 安装：预缓存静态资源
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
    );
    self.skipWaiting();
});

// 激活：清理旧版本缓存
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// 抓取：网络优先，失败回退缓存（保证又能用最新代码又不至空白）
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    // 跨域请求（Supabase / IMA / DeepSeek / CDN）直接走网络，不进缓存
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    event.respondWith(
        fetch(req)
            .then((res) => {
                // 顺手回填缓存
                const clone = res.clone();
                caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
                return res;
            })
            .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
});
