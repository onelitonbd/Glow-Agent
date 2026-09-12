/* Glow Agent Service Worker - Production PWA */
const CACHE_NAME = 'glow-agent-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/library.html',
  '/manifest.json',
  '/assets/css/app.css',
  '/assets/js/theme.js',
  '/assets/js/api.js',
  '/assets/js/ui.js',
  '/assets/js/markdown.js',
  '/assets/js/chat.js',
  '/assets/js/library.js',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png'
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS.map(url => new Request(url, {cache: 'reload'}))).catch(() => {
        // If some assets fail, still proceed - don't block install
        return Promise.resolve();
      });
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch: Network-first for API, Cache-first for static, Network-only for streaming
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Skip non-GET
  if (event.request.method !== 'GET') return;
  
  // API requests: network only, never cache (especially streaming)
  if (url.pathname.startsWith('/api/')) {
    return;
  }
  
  // Streaming endpoints: network only
  if (url.pathname.includes('/respond/stream') || url.pathname.includes('/regenerate/stream') || url.pathname.includes('/tests/run/stream')) {
    return;
  }
  
  // For navigation requests (HTML pages): network-first, fallback to cache, then to index.html for SPA routing (/chat/:id)
  if (event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(event.request).then((response) => {
        // Cache successful navigation responses
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(()=>{});
        }
        return response;
      }).catch(() => {
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // For /chat/<id> deep links, serve index.html
          if (url.pathname.startsWith('/chat/')) {
            return caches.match('/index.html') || caches.match('/');
          }
          return caches.match('/index.html') || caches.match('/');
        });
      })
    );
    return;
  }
  
  // Static assets: cache-first, fallback to network
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && (url.pathname.startsWith('/assets/') || url.pathname.endsWith('.png') || url.pathname.endsWith('.css') || url.pathname.endsWith('.js'))) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(()=>{});
        }
        return response;
      }).catch(() => cached);
    })
  );
});
