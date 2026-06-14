// NOWPayments IPN (Instant Payment Notification) webhook.
// NOWPayments POSTs here on every payment status change. We verify the
// HMAC-SHA512 signature, and on `finished` credit the user idempotently.
// Required env: NOWPAYMENTS_IPN_SECRET (the "IPN secret key" from NOWPayments).
const crypto = require('crypto');
const { creditDeposit } = require('../lib/store');

const MIN_USD = 10;

// Read the raw request body (needed for an exact signature check).
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Recursively sort object keys, matching NOWPayments' signature scheme.
function sortObject(obj) {
  if (Array.isArray(obj)) return obj.map(sortObject);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, k) => { acc[k] = sortObject(obj[k]); return acc; }, {});
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

  // Verify signature over the key-sorted JSON.
  const sorted = JSON.stringify(sortObject(payload));
  const expected = crypto.createHmac('sha512', secret).update(sorted).digest('hex');
  const sig = req.headers['x-nowpayments-sig'];
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(String(sig || ''), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'bad signature' });
    }
  } catch {
    return res.status(401).json({ error: 'bad signature' });
  }

  // order_id is "user_<userId>" as set when creating the payment.
  const orderId = String(payload.order_id || '');
  const userId = orderId.startsWith('user_') ? orderId.slice(5) : null;

  if (payload.payment_status === 'finished' && userId) {
    // USD value actually received = actually_paid / pay_amount * price_amount.
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
        // Returning 500 makes NOWPayments retry the IPN later.
        return res.status(500).json({ error: 'credit failed' });
      }
    }
  }

  // Always 200 for accepted-but-ignored statuses so NOWPayments stops retrying.
  return res.status(200).json({ ok: true });
};

// Disable Vercel's body parser so we can verify the signature over the raw body.
module.exports.config = { api: { bodyParser: false } };
