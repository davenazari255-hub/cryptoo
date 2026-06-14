// NOWPayments IPN (Instant Payment Notification) webhook.
// NOWPayments POSTs here on every payment status change. We verify the
// HMAC-SHA512 signature, and on `finished` credit the user idempotently.
// Self-contained (no cross-dir imports) for reliable Vercel bundling.
// Required env: NOWPAYMENTS_IPN_SECRET, UPSTASH_REDIS_REST_URL/TOKEN.
const crypto = require('crypto');

const MIN_USD = 10;

async function upstash(args) {
  const URL = process.env.UPSTASH_REDIS_REST_URL, TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!URL || !TOKEN) throw new Error('Upstash not configured');
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error('Upstash: ' + (data.error || res.status));
  return data.result;
}

// Idempotently credit a finished deposit; returns false if already processed.
async function creditDeposit(userId, paymentId, usd, meta) {
  const added = await upstash(['SADD', `seen:${userId}`, String(paymentId)]);
  if (added === 0) return false;
  const amount = Math.round((parseFloat(usd) || 0) * 100) / 100;
  await upstash(['INCRBYFLOAT', `bal:${userId}`, amount]);
  await upstash(['LPUSH', `ledger:${userId}`, JSON.stringify({ paymentId: String(paymentId), usd: amount, ...meta })]);
  await upstash(['LTRIM', `ledger:${userId}`, 0, 99]);
  return true;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sortObject(obj) {
  if (Array.isArray(obj)) return obj.map(sortObject);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((a, k) => { a[k] = sortObject(obj[k]); return a; }, {});
  }
  return obj;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!secret) return res.status(500).json({ error: 'IPN secret not configured' });

  let raw;
  try { raw = await readRawBody(req); } catch { return res.status(400).json({ error: 'bad body' }); }

  let payload;
  try { payload = JSON.parse(raw); } catch { return res.status(400).json({ error: 'bad json' }); }

  const expected = crypto.createHmac('sha512', secret).update(JSON.stringify(sortObject(payload))).digest('hex');
  const sig = req.headers['x-nowpayments-sig'];
  try {
    const a = Buffer.from(expected, 'hex'), b = Buffer.from(String(sig || ''), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'bad signature' });
    }
  } catch {
    return res.status(401).json({ error: 'bad signature' });
  }

  const orderId = String(payload.order_id || '');
  const userId = orderId.startsWith('user_') ? orderId.slice(5) : null;

  if (payload.payment_status === 'finished' && userId) {
    const paid = parseFloat(payload.actually_paid) || 0;
    const expect = parseFloat(payload.pay_amount) || 0;
    const price = parseFloat(payload.price_amount) || 0;
    const usd = expect > 0 ? (paid / expect) * price : price;

    if (usd >= MIN_USD) {
      try {
        await creditDeposit(userId, payload.payment_id, usd, {
          coin: String(payload.pay_currency || '').toUpperCase(),
          at: payload.updated_at || payload.created_at || null,
        });
      } catch (e) {
        return res.status(500).json({ error: 'credit failed' }); // triggers NOWPayments retry
      }
    }
  }

  return res.status(200).json({ ok: true });
};

// Disable Vercel's body parser so we can verify the signature over the raw body.
module.exports.config = { api: { bodyParser: false } };
