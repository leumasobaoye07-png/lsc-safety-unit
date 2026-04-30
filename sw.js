// LSC Safety Unit — Service Worker v4
// Handles: caching, push notifications, notification clicks

const CACHE_NAME = 'lsc-safety-v4';
const CACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js',
];

// ── INSTALL ──────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(CACHE_URLS.map(url => cache.add(url).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH (cache-first, skip Supabase) ───────────────────────────────────────
self.addEventListener('fetch', event => {
  if (event.request.url.includes('supabase.co')) return;
  if (event.request.url.includes('/api/')) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        if (event.request.destination === 'document') {
          return caches.match('/index.html');
        }
      });
    })
  );
});

// ── PUSH RECEIVED ─────────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'LSC Safety', body: event.data ? event.data.text() : 'New notification' };
  }

  const isEmergency = data.type === 'emergency';

  const options = {
    body: data.body || 'New notification',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || (isEmergency ? 'emergency' : 'general'),
    renotify: isEmergency,
    requireInteraction: isEmergency,
    silent: false,
    vibrate: isEmergency ? [400, 100, 400, 100, 400, 100, 600] : [200, 100, 200],
    data: {
      url: data.url || '/',
      type: data.type || 'general',
      timestamp: Date.now(),
    },
    actions: isEmergency
      ? [{ action: 'open', title: '🚨 Open App' }]
      : [{ action: 'open', title: 'View' }],
  };

  event.waitUntil(
    self.registration.showNotification(
      isEmergency ? '🚨 EMERGENCY ALERT — LSC Safety' : (data.title || 'LSC Safety Unit'),
      options
    )
  );
});

// ── NOTIFICATION CLICK ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Focus existing window if open
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.postMessage({ type: 'NOTIFICATION_CLICK', data: event.notification.data });
          return client.focus();
        }
      }
      // Otherwise open new window
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// ── PUSH SUBSCRIPTION CHANGE ──────────────────────────────────────────────────
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: event.oldSubscription?.options?.applicationServerKey,
    }).then(subscription => {
      // Notify all clients to re-save subscription
      return clients.matchAll().then(clientList => {
        clientList.forEach(client => {
          client.postMessage({ type: 'SUBSCRIPTION_CHANGED', subscription: subscription.toJSON() });
        });
      });
    }).catch(e => console.error('pushsubscriptionchange failed:', e))
  );
});
