// Lightweight deposit-status poll for the in-app deposit sheet.
//
// Crediting happens in api/blockbee-webhook.js. This endpoint does NOT call
// BlockBee — it reads our own record of what the webhook has already processed
// for this user's address, so the UI can flip from "waiting" to "received"
// without spending BlockBee/Upstash calls on a third-party status lookup.
//
// The webhook writes a per-address marker (bbseen:<address>) describing the
// latest credited deposit; this returns it if it belongs to the caller.
//
// Authenticated: Telegram identity + ownership of the address.
// Self-contained for reliable Vercel bundling.
const crypto = require('crypto');

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

  const body = req.body || {};
  const user = verifyTelegram(body.initData);
  if (!user) return res.status(401).json({ error: 'Telegram authentication failed' });
  const userId = `tg_${user.id}`;

  const address = String(body.address || '').trim();
  if (!address) return res.status(400).json({ error: 'address is required' });
  const lc = address.toLowerCase();

  // Authorise: this address must belong to this user.
  const owner = await upstash(['GET', `bbowner:${lc}`]);
  if (!owner) return res.status(404).json({ error: 'Address not found' });
  if (String(owner) !== userId) return res.status(403).json({ error: 'Not your address' });

  // Latest event the webhook recorded for this address, if any.
  // Shape: { status: 'pending'|'confirmed', usd, coin, txid, at }
  let ev = null;
  try { ev = JSON.parse(await upstash(['GET', `bbseen:${lc}`])); } catch {}

  if (!ev) {
    return res.status(200).json({ status: 'waiting' });
  }

  return res.status(200).json({
    status: ev.status || 'waiting',   // waiting | pending | confirmed
    usd: ev.usd != null ? ev.usd : null,
    coin: ev.coin || null,
    txid: ev.txid || null,
    at: ev.at || null,
  });
};
