// Creates a Paymento payment and returns the hosted-checkout token/URL.
// Replacement for api/get-deposit-address.js (NOWPayments).
//
// IMPORTANT — model difference from NOWPayments:
//   NOWPayments handed the user a fixed deposit ADDRESS to send to.
//   Paymento is a HOSTED CHECKOUT: we create a payment, get a `token`, and send
//   the user to https://app.paymento.io/gateway?token=<token>. There is no
//   per-user fixed address to display. The frontend deposit flow must change
//   from "copy this address" to "open the payment page" (Telegram
//   WebApp.openLink / openInvoice). See PAYMENTO_MIGRATION.md.
//
// Self-contained (no cross-dir imports) for reliable Vercel bundling.
const crypto = require('crypto');

const PAYMENTO_BASE = 'https://api.paymento.io/v1';
const PAYMENTO_GATEWAY = 'https://app.paymento.io/gateway';

// New, much lower minimums than NOWPayments. TRC20 is the cheapest common
// network for small payments; the real limiter is the on-chain fee (~$1), not
// Paymento's own fee (0.5%). Values in USD.
const MIN_USD_BY_CURRENCY = {
  usdttrc20: 1,
  usdterc20: 5,
  usdtbsc: 1,
  usdtmatic: 1,
  usdtarb: 1,
  btc: 5,
  eth: 5,
  bnbbsc: 2,
  sol: 2,
  trx: 2,
  ton: 2,
};
const MIN_USD_DEFAULT = 1;
const minUsdFor = (cur) => MIN_USD_BY_CURRENCY[cur] || MIN_USD_DEFAULT;

const STABLE = /^usd|^dai|^tusd/;

// ── Upstash REST helper — refuses to issue a payment if storage is down, so we
// never create a payment we cannot attribute to a user (same policy as the old
// get-deposit-address.js). A missing key is a normal null; a real failure throws.
class StorageDown extends Error {}
async function upstash(args) {
  const URL = process.env.UPSTASH_REDIS_REST_URL, TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!URL || !TOKEN) throw new StorageDown('storage not configured');
  let res, data;
  try {
    res = await fetch(URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    data = await res.json();
  } catch (e) { throw new StorageDown('storage unreachable'); }
  if (!res.ok || (data && data.error)) throw new StorageDown(String((data && data.error) || res.status));
  return data ? data.result : null;
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
  try {
    return await createPayment(req, res);
  } catch (err) {
    if (err instanceof StorageDown) {
      return res.status(503).json({
        error: 'Deposits are paused for maintenance. Please try again later — your funds and balance are safe.',
      });
    }
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};

async function createPayment(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.PAYMENTO_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'PAYMENTO_API_KEY is not configured' });

  const body = req.body || {};

  const user = verifyTelegram(body.initData);
  if (!user) return res.status(401).json({ error: 'Telegram authentication failed' });
  const userId = `tg_${user.id}`;

  if (await upstash(['GET', `banned:${userId}`])) return res.status(403).json({ error: 'Account suspended' });

  // The user chooses how much (USD) they want to deposit. Paymento is fiat-
  // priced (fiatAmount + fiatCurrency), unlike NOWPayments where we quoted a
  // coin floor. `currency` is optional and only used to enforce our per-coin
  // minimum + tell the client which coin to expect.
  const payCurrency = String(body.currency || 'usdttrc20').toLowerCase();
  const floor = minUsdFor(payCurrency);

  const amountUsd = Math.round((parseFloat(body.amountUsd != null ? body.amountUsd : body.amount) || 0) * 100) / 100;
  if (!isFinite(amountUsd) || amountUsd <= 0) {
    return res.status(400).json({ error: 'A valid deposit amount is required' });
  }
  if (amountUsd < floor) {
    return res.status(400).json({ error: `Minimum deposit is ${floor} USD` });
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const returnUrl = process.env.PAYMENTO_RETURN_URL
    || (host ? `${proto}://${host}/` : undefined);

  // orderId keeps the SAME shape the NOWPayments flow used (user_<userId>), so
  // the webhook's owner-resolution logic is unchanged. It is echoed back in the
  // callback as OrderId.
  const orderId = `user_${userId}`;

  // Safe fetch: never throw on a non-JSON (HTML error page) response.
  const jpost = async (url, payload) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { ok: r.ok, status: r.status, json: j, text: t };
  };

  const resp = await jpost(`${PAYMENTO_BASE}/payment/request`, {
    fiatAmount: String(amountUsd),
    fiatCurrency: 'USD',
    orderId,
    ReturnUrl: returnUrl,
    Speed: 1, // 0 = High, 1 = Low. Low favours cheaper (slower) confirmation.
  });

  // Paymento returns { success, message, body: "<token>" }.
  const token = resp.json && resp.json.body;
  if (!resp.ok || !resp.json || resp.json.success === false || !token) {
    const msg = (resp.json && resp.json.message) || ('Paymento unavailable (' + resp.status + ')');
    return res.status(resp.status || 502).json({ error: msg });
  }

  // Record who owns this payment so the status/webhook endpoints can attribute
  // it. Keyed by BOTH orderId and token; the callback carries Token + OrderId.
  await upstash(['SET', `pay:owner:${orderId}`, userId]);
  await upstash(['SET', `pay:token:${token}`, userId]);
  // Reverse lookup token -> orderId, so the webhook can find the order from the
  // token alone if needed.
  await upstash(['SET', `pay:tokenorder:${token}`, orderId]);

  const gatewayUrl = `${PAYMENTO_GATEWAY}?token=${encodeURIComponent(token)}`;

  return res.status(200).json({
    // Hosted-checkout: the frontend should open this URL (Telegram openLink).
    token,
    gatewayUrl,
    orderId,
    payCurrency: payCurrency.toUpperCase(),
    amountUsd,
    minUsd: floor,
    stable: STABLE.test(payCurrency),
    // Signals to the client this is a redirect flow, not an address flow.
    hosted: true,
  });
}
