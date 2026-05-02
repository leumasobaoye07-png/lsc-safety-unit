// api/send-notification.js
// Vercel serverless function — sends Web Push notifications
// Requires: npm install web-push (add to package.json)

const webpush = require('web-push');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

webpush.setVapidDetails(
  'mailto:admin@lscsafety.app',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

async function getSubscriptions(filterInactive = false) {
  let url = `${SUPABASE_URL}/rest/v1/push_subscriptions?select=*`;
  
  if (filterInactive) {
    // Only get subscriptions for inactive users (last_seen > 15 seconds ago)
    const cutoff = new Date(Date.now() - 15000).toISOString();
    url = `${SUPABASE_URL}/rest/v1/push_subscriptions?select=*,members!inner(last_seen)&members.last_seen=lt.${cutoff}`;
  }

  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
    }
  });
  return res.json();
}

async function removeExpiredSubscription(endpoint) {
  await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
    }
  });
}

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Basic auth check — must include supabase anon key as bearer
  const auth = req.headers.authorization;
  if (!auth || !auth.includes(SUPABASE_ANON_KEY)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { type, title, body, data, targetAll = false } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: 'title and body required' });
  }

  const payload = JSON.stringify({
    title,
    body,
    type: type || 'general',
    data: data || {},
    timestamp: Date.now()
  });

  // Emergency alerts go to ALL users
  // Chat notifications go only to inactive users
  const isEmergency = type === 'emergency';
  const subscriptions = await getSubscriptions(!isEmergency);

  if (!subscriptions || subscriptions.length === 0) {
    return res.status(200).json({ sent: 0, message: 'No subscribers' });
  }

  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth
        }
      };

      const options = {
        TTL: isEmergency ? 86400 : 3600, // Emergency: 24h, Chat: 1h
        urgency: isEmergency ? 'high' : 'normal',
        topic: isEmergency ? 'emergency' : `chat-${Date.now()}` // deduplication tag
      };

      try {
        await webpush.sendNotification(pushSubscription, payload, options);
        return { success: true, endpoint: sub.endpoint };
      } catch (err) {
        // 410 Gone = subscription expired, remove it
        if (err.statusCode === 410 || err.statusCode === 404) {
          await removeExpiredSubscription(sub.endpoint);
        }
        return { success: false, error: err.message };
      }
    })
  );

  const sent = results.filter(r => r.status === 'fulfilled' && r.value?.success).length;
  const failed = results.length - sent;

  return res.status(200).json({ sent, failed, total: results.length });
}
