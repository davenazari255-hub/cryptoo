// Returns the current status of a Paymento payment, so the frontend can show
// live progress. Replacement for api/check-payment.js (NOWPayments).
//
// Uses Paymento's Verify Payment API. Crediting is handled by the webhook
// (api/paymento-webhook.js), NOT here — this is read-only status for the UI.
//
// Authenticated: the caller must prove Telegram identity AND own the payment
// (recorded by api/paymento-create.js under pay:token:<token>).
// Self-contained for reliable Vercel bundling.
const crypto = require('crypto');

const PAYMENTO_BASE = 'https://api.paymento.io/v1';

// ── Upstash REST helper (best-effort: returns null on any failure) ──
async function upstash(args) {
  const URL = process.env.UPSTASH_REDIS_REST_URL, TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!URL || !TOKEN) return null;
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    return data && !data.error ? data.result : null;
  } catch { return null; }
}

// ── Telegram initData verification (inlined) ──
function verifyTelegram(initData) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !initData || typeof initData !== 'string') return null;
  let params;
  try { params = new URLSearchParams(initData); } catch { return null; }
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const pairs = [];
  for (const [k, v] of params) pairs.push(`${k}=${v}`);
  pairs.sort();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calc = crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  try {
    const a = Buffer.from(calc, 'hex'), b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch { return null; }
  const authDate = parseInt(params.get('auth_date'), 10);
  if (authDate && Date.now() / 1000 - authDate > 86400) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? user : null;
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.PAYMENTO_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Payment provider not configured' });

  const body = req.body || {};

  const user = verifyTelegram(body.initData);
  if (!user) return res.status(401).json({ error: 'Telegram authentication failed' });
  const userId = `tg_${user.id}`;

  const token = body.token || body.paymentToken;
  if (!token) return res.status(400).json({ error: 'token is required' });

  // Authorise: this payment token must have been created by this user.
  const owner = await upstash(['GET', `pay:token:${token}`]);
  if (!owner) return res.status(404).json({ error: 'Payment not found' });
  if (String(owner) !== userId) return res.status(403).json({ error: 'Not your payment' });

  try {
    const r = await fetch(`${PAYMENTO_BASE}/payment/verify`, {
      method: 'POST',
      headers: { 'Api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const t = await r.text();
    let data = null; try { data = JSON.parse(t); } catch {}

    if (!r.ok || !data) {
      return res.status(r.status || 502).json({ error: 'Could not fetch payment status' });
    }

    // Paymento's verify response wraps the payload in `body` on success.
    const p = data.body || data;

    return res.status(200).json({
      token,
      orderId: p.orderId || p.OrderId || null,
      // Normalised status the frontend understands. Paymento's own status field
      // name may vary; expose the raw value too so the client can map it.
      status: p.orderStatus || p.OrderStatus || p.status || (data.success ? 'ok' : 'unknown'),
      raw: p,
      success: data.success !== false,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
};
