// Creates a NOWPayments payment and returns a deposit address.
// Self-contained (no cross-dir imports) for reliable Vercel bundling.
const crypto = require('crypto');

const MIN_USD = 10;

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
  if (!apiKey) return res.status(500).json({ error: 'NOWPAYMENTS_API_KEY is not configured' });

  const body = req.body || {};
  const { currency } = body;
  if (!currency) return res.status(400).json({ error: 'currency is required' });

  const user = verifyTelegram(body.initData);
  if (!user) return res.status(401).json({ error: 'Telegram authentication failed' });
  const userId = `tg_${user.id}`;

  const payCurrency = String(currency).toLowerCase();

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const ipnUrl = process.env.IPN_CALLBACK_URL || (host ? `${proto}://${host}/api/ipn` : undefined);

  try {
    const response = await fetch('https://api.nowpayments.io/v1/payment', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: MIN_USD,
        price_currency: 'usd',
        pay_currency: payCurrency,
        order_id: `user_${userId}`,
        order_description: `Deposit for ${userId}`,
        ipn_callback_url: ipnUrl,
        is_fee_paid_by_user: true,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || 'NOWPayments error' });
    }
    return res.status(200).json({
      address: data.pay_address,
      payCurrency: (data.pay_currency || payCurrency).toUpperCase(),
      paymentId: data.payment_id,
      payinExtraId: data.payin_extra_id || null,
      network: data.network || null,
      minUsd: MIN_USD,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};
