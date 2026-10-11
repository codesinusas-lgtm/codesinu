const CACHE = 'sinucode-shell-v3';
const SHELL = ['/', '/login', '/trabajador', '/admin', '/offline.html', '/manifest.json', '/icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async path => {
      try {
        const response = await fetch(path, { cache: 'reload' });
        if (!response.ok) return;
        const copy = response.clone();
        await cache.put(new URL(path, self.location.origin), response);

        if (path === '/' || path === '/login' || path === '/trabajador' || path === '/admin') {
          const markup = await copy.text();
          const assets = new Set([...markup.matchAll(/(?:src|href)="(\/\_next\/static\/[^"?#]+)"/g)].map(match => match[1]));
          await Promise.all([...assets].map(async asset => {
            try {
              const assetResponse = await fetch(asset, { cache: 'reload' });
              if (assetResponse.ok) await cache.put(new URL(asset, self.location.origin), assetResponse);
            } catch { /* A shell page can still be cached if one optional asset failed. */ }
          }));
        }
      } catch { /* Cache available pages independently; one route must not abort install. */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith('sinucode-shell-') && key !== CACHE)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
        return response;
      } catch {
        return (await caches.match(request)) || (await caches.match(new URL(url.pathname, self.location.origin))) || (await caches.match(new URL('/offline.html', self.location.origin)));
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
        return response;
      } catch {
        return new Response('Recurso no disponible sin conexión.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  if (url.pathname === '/manifest.json' || url.pathname === '/icon.svg') {
    event.respondWith((async () => (await caches.match(request)) || fetch(request))());
  }
});
