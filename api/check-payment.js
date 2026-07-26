// Returns the current status of a NOWPayments payment, so the frontend can
// show live progress. Crediting is handled by the IPN webhook, not here.
//
// Authenticated: NOWPayments payment ids are sequential integers, so an
// unauthenticated lookup let anyone enumerate every user's deposit history
// (amounts, currencies, status) through our own API key. The caller must now
// prove Telegram identity AND own the payment (recorded by get-deposit-address).
// Self-contained for reliable Vercel bundling.
const crypto = require('crypto');

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

  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Payment provider not configured' });

  const body = req.body || {};
  const user = verifyTelegram(body.initData);
  if (!user) return res.status(401).json({ error: 'Telegram authentication failed' });
  const userId = `tg_${user.id}`;

  const paymentId = body.paymentId || body.payment_id;
  if (!paymentId) return res.status(400).json({ error: 'paymentId is required' });

  // Authorise: this payment must have been created by this user.
  const owner = await upstash(['GET', `pay:owner:${paymentId}`]);
  if (!owner) return res.status(404).json({ error: 'Payment not found' });
  if (String(owner) !== userId) return res.status(403).json({ error: 'Not your payment' });

  try {
    const response = await fetch(
      `https://api.nowpayments.io/v1/payment/${encodeURIComponent(paymentId)}`,
      { headers: { 'x-api-key': apiKey } }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Could not fetch payment status' });
    }

    return res.status(200).json({
      paymentId: data.payment_id,
      // waiting | confirming | confirmed | sending | partially_paid | finished | failed | refunded | expired
      status: data.payment_status,
      payAmount: data.pay_amount,
      actuallyPaid: data.actually_paid,
      payCurrency: data.pay_currency,
      priceAmount: data.price_amount,
      priceCurrency: data.price_currency,
      outcomeAmount: data.outcome_amount,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
