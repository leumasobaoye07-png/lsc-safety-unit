// api/push.js — Vercel Serverless Function
// Receives push requests from the app and sends Web Push notifications

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT;

// Minimal Web Push implementation (no npm needed on Vercel)
// Uses the Web Push Protocol directly with fetch

async function uint8ArrayToBase64Url(array) {
  const base64 = Buffer.from(array).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function base64UrlToUint8Array(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = Buffer.from(base64, "base64");
  return new Uint8Array(raw);
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = Buffer.from(base64, "base64");
  return new Uint8Array(rawData);
}

async function generateVapidAuthHeader(audience, subject, publicKey, privateKey) {
  const crypto = globalThis.crypto || require("crypto").webcrypto;

  const now = Math.floor(Date.now() / 1000);
  const exp = now + 12 * 3600; // 12 hours

  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud: audience, exp, sub: subject };

  const encHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${encHeader}.${encPayload}`;

  // Import private key
  const privateKeyBytes = urlBase64ToUint8Array(privateKey);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    privateKeyBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  ).catch(async () => {
    // Try ECDSA for signing
    return crypto.subtle.importKey(
      "pkcs8",
      privateKeyBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
  });

  const signingKey = await crypto.subtle.importKey(
    "raw",
    privateKeyBytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  ).catch(() => null);

  if (!signingKey) throw new Error("Could not import VAPID private key");

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signingKey,
    Buffer.from(signingInput)
  );

  const encSignature = Buffer.from(signature).toString("base64url");
  const jwt = `${signingInput}.${encSignature}`;
  const pubKeyBase64 = publicKey.replace(/-/g, "+").replace(/_/g, "/");

  return `vapid t=${jwt}, k=${publicKey}`;
}

async function sendPushNotification(subscription, payload) {
  const endpoint = subscription.endpoint;
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;

  let authHeader;
  try {
    authHeader = await generateVapidAuthHeader(
      audience,
      VAPID_SUBJECT,
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );
  } catch (e) {
    // Fallback: use web-push package if available
    console.error("VAPID auth failed:", e.message);
    throw e;
  }

  const payloadStr = JSON.stringify(payload);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/json",
      "TTL": "86400",
    },
    body: payloadStr,
  });

  return res;
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { subscriptions, payload, type } = req.body;

  if (!subscriptions || !Array.isArray(subscriptions)) {
    return res.status(400).json({ error: "subscriptions array required" });
  }

  if (!payload) {
    return res.status(400).json({ error: "payload required" });
  }

  const results = { sent: 0, failed: 0, expired: [] };

  for (const sub of subscriptions) {
    try {
      const pushRes = await sendPushNotification(sub, payload);

      if (pushRes.status === 201 || pushRes.status === 200) {
        results.sent++;
      } else if (pushRes.status === 410 || pushRes.status === 404) {
        // Subscription expired — client should delete it
        results.expired.push(sub.endpoint);
        results.failed++;
      } else {
        console.error("Push failed:", pushRes.status, await pushRes.text());
        results.failed++;
      }
    } catch (e) {
      console.error("Push error:", e.message);
      results.failed++;
    }
  }

  return res.status(200).json(results);
}

