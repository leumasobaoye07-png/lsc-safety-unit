// api/push.js
// Vercel serverless function — sends Web Push notifications

const webpush = require('web-push');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

webpush.setVapidDetails(
  'https://lsc-safety-unit.vercel.app',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

async function getAllSubscriptions() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=*`, {
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { type, title, body, data, subscriptions: clientSubs } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: 'title and body required' });
  }

  const isEmergency = type === 'emergency';

  const payload = JSON.stringify({
    title,
    body,
    type: type || 'general',
    data: data || {},
    timestamp: Date.now()
  });

  // Use subscriptions passed from client if provided, else fetch all from DB
  let subscriptions = clientSubs;
  if (!subscriptions || !subscriptions.length) {
    subscriptions = await getAllSubscriptions();
  }

  if (!subscriptions || subscriptions.length === 0) {
    return res.status(200).json({ sent: 0, message: 'No subscribers' });
  }

  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh || sub.keys?.p256dh,
          auth: sub.auth || sub.keys?.auth
        }
      };

      const options = {
        TTL: isEmergency ? 86400 : 3600,
        urgency: isEmergency ? 'high' : 'normal',
        topic: isEmergency ? 'emergency' : 'chat'
      };

      try {
        await webpush.sendNotification(pushSubscription, payload, options);
        return { success: true };
      } catch (err) {
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
};
