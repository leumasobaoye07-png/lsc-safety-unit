// LSC Safety Unit — Service Worker v4
// Handles: caching + push notifications + notification clicks

const CACHE_NAME = 'lsc-safety-v4';
const CACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js',
];

// ── INSTALL ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(CACHE_URLS.map(url => cache.add(url).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH (cache first) ──
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

// ── PUSH RECEIVED ──
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch (e) {
    payload = { title: '🛡️ LSC Safety', body: event.data.text(), type: 'general' };
  }

  const isEmergency = payload.type === 'emergency';

  const options = {
    body: payload.body,
    icon: '/icon-192.png',
    badge: '/icon-72.png',
    vibrate: isEmergency
      ? [400, 100, 400, 100, 400, 100, 600, 100, 600]  // Strong emergency pattern
      : [200, 100, 200],                                  // Gentle chat pattern
    tag: isEmergency ? 'emergency-alert' : `chat-${payload.timestamp}`,
    requireInteraction: isEmergency, // Emergency stays until dismissed
    renotify: isEmergency,
    silent: false,
    data: {
      url: '/',
      type: payload.type,
      timestamp: payload.timestamp,
      ...payload.data
    },
    actions: isEmergency
      ? [{ action: 'open', title: '🚨 Open App NOW' }]
      : [{ action: 'open', title: 'View' }, { action: 'dismiss', title: 'Dismiss' }]
  };

  // Group chat notifications — show count instead of spam
  if (!isEmergency) {
    event.waitUntil(
      self.registration.getNotifications({ tag: 'chat-group' }).then(existing => {
        if (existing.length > 0) {
          // Update existing grouped notification
          const count = (existing[0].data?.count || 1) + 1;
          options.tag = 'chat-group';
          options.body = `${count} new messages from the team`;
          options.data = { ...options.data, count };
          existing.forEach(n => n.close());
        }
        return self.registration.showNotification(
          isEmergency ? '🚨 EMERGENCY ALERT' : '🛡️ LSC Safety Unit',
          options
        );
      })
    );
  } else {
    event.waitUntil(
      self.registration.showNotification('🚨 EMERGENCY ALERT', options)
    );
  }
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // If app already open, focus it
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open app
      return clients.openWindow('/');
    })
  );
});

// ── PUSH SUBSCRIPTION CHANGE ──
// Handles when browser rotates push subscription keys
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: self.VAPID_PUBLIC_KEY
    }).then(subscription => {
      // Re-save new subscription to Supabase
      return fetch('/api/update-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription })
      });
    })
  );
});
