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
    // Safe fetch: never throw on a non-JSON (HTML error page) response.
    const jget = async (url, opts) => {
      const r = await fetch(url, opts);
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { ok: r.ok, status: r.status, json: j, text: t };
    };

    // Ask NOWPayments for the coin's real minimum (in its own units + USD).
    let priceUsd = MIN_USD, minCoin = null;
    const mr = await jget(
      `https://api.nowpayments.io/v1/min-amount?currency_from=${encodeURIComponent(payCurrency)}&fiat_equivalent=usd`,
      { headers: { 'x-api-key': apiKey } }
    );
    if (mr.ok && mr.json) {
      const minFiat = parseFloat(mr.json.fiat_equivalent);
      minCoin = parseFloat(mr.json.min_amount) || null;
      if (minFiat > 0) priceUsd = Math.max(MIN_USD, Math.ceil(minFiat));
    }

    let data = null, lastErr = 'NOWPayments error', status = 502;
    for (let attempt = 0; attempt < 6; attempt++) {
      const resp = await jget('https://api.nowpayments.io/v1/payment', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          price_amount: priceUsd,
          price_currency: 'usd',
          pay_currency: payCurrency,
          order_id: `user_${userId}`,
          order_description: `Deposit for ${userId}`,
          ipn_callback_url: ipnUrl,
          is_fee_paid_by_user: true,
        }),
      });
      if (resp.ok && resp.json && resp.json.pay_address) { data = resp.json; break; }
      lastErr = (resp.json && resp.json.message) || ('NOWPayments unavailable (' + resp.status + ')');
      status = resp.status || 502;
      // Only retry the "too small" case; bump the amount and try again.
      if (/too small|too low|minim/i.test(lastErr)) { priceUsd += 1; continue; }
      break;
    }

    if (!data) return res.status(status).json({ error: lastErr });

    return res.status(200).json({
      address: data.pay_address,
      payCurrency: (data.pay_currency || payCurrency).toUpperCase(),
      paymentId: data.payment_id,
      payinExtraId: data.payin_extra_id || null,
      network: data.network || null,
      minUsd: priceUsd,
      minCoin: minCoin,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};
