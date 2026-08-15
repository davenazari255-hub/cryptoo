// Creates a BlockBee payment address and returns it (+ a QR image URL) so the
// app can show the deposit ADDRESS and QR INSIDE the mini-app — no hosted
// checkout, no redirect, and the app's own domain is never shown to the user.
//
// Replacement for the NOWPayments get-deposit-address.js, restoring the same
// in-app address/QR deposit UX.
//
// BlockBee model:
//   GET https://api.blockbee.io/{ticker}/create/?apikey=...&callback=...
//   -> { address_in, address_out, minimum_transaction_coin, status }
// We show `address_in` to the user. When funds arrive, BlockBee calls our
// callback (api/blockbee-webhook.js). Security: the callback URL carries a
// random `nonce` we store and re-check, PLUS the webhook is RSA-signed.
//
// Self-contained (no cross-dir imports) for reliable Vercel bundling.
const crypto = require('crypto');

const BLOCKBEE_BASE = 'https://api.blockbee.io';

// Ticker per coin/network, in BlockBee's format ({coin}_{chain} for tokens).
// USDT on TRON is the cheapest common network for small deposits.
// Keys match the `t` values the frontend's DEPOSIT_COINS list sends; values are
// BlockBee's ticker format ({coin}_{chain} for tokens).
const TICKERS = {
  usdttrc20: 'usdt_trc20',
  usdterc20: 'usdt_erc20',
  usdtbsc: 'usdt_bep20',
  usdtmatic: 'usdt_polygon',
  usdtarb: 'usdt_arbitrum',
  btc: 'btc',
  eth: 'eth',
  bnbbsc: 'bnb',
  trx: 'trx',
  sol: 'sol',
  ton: 'ton',
};

// ── storage: refuse to issue an address if storage is down, so we never hand
// out an address we cannot attribute to a user (same policy as the old flow). ──
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
    return await createAddress(req, res);
  } catch (err) {
    if (err instanceof StorageDown) {
      return res.status(503).json({
        error: 'Deposits are paused for maintenance. Please try again later — your funds and balance are safe.',
      });
    }
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};

async function createAddress(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.BLOCKBEE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'BLOCKBEE_API_KEY is not configured' });

  const body = req.body || {};

  const user = verifyTelegram(body.initData);
  if (!user) return res.status(401).json({ error: 'Telegram authentication failed' });
  const userId = `tg_${user.id}`;

  if (await upstash(['GET', `banned:${userId}`])) return res.status(403).json({ error: 'Account suspended' });

  const currency = String(body.currency || 'usdttrc20').toLowerCase();
  const ticker = TICKERS[currency];
  if (!ticker) return res.status(400).json({ error: 'Unsupported coin' });

  // One fixed address per user per coin. BlockBee addresses are reusable — a
  // later send to the same address raises a fresh callback — so we create once
  // and reuse, exactly like the old flow. Reusing also keeps the nonce stable.
  const addrKey = `bbaddr:${userId}:${currency}`;
  const saved = await upstash(['GET', addrKey]);
  if (saved) {
    let rec = null; try { rec = JSON.parse(saved); } catch {}
    if (rec && rec.address) {
      return res.status(200).json({
        address: rec.address,
        qr: `${BLOCKBEE_BASE}/${ticker}/qrcode/?address=${encodeURIComponent(rec.address)}&size=300`,
        payCurrency: currency.toUpperCase(),
        network: rec.network || null,
        minCoin: rec.minCoin != null ? rec.minCoin : null,
        reused: true,
        hosted: false,
      });
    }
  }

  // Per-user random secret returned in the callback and re-checked in the
  // webhook — a forged callback that does not echo this exact nonce is rejected.
  const nonce = crypto.randomBytes(24).toString('hex');

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const base = process.env.BLOCKBEE_CALLBACK_BASE || (host ? `${proto}://${host}` : '');
  if (!base) return res.status(500).json({ error: 'Callback base URL unavailable' });

  // The callback carries user + coin + nonce. BlockBee returns these query
  // params unchanged in the webhook, so the webhook can attribute + verify.
  const callbackUrl = `${base}/api/blockbee-webhook`
    + `?user=${encodeURIComponent(userId)}`
    + `&coin=${encodeURIComponent(currency)}`
    + `&nonce=${encodeURIComponent(nonce)}`;

  // json=1 -> webhook body is JSON; post=1 -> sent as POST; pending=1 -> also
  // notify on mempool detection so the UI can show "seen, confirming".
  const url = `${BLOCKBEE_BASE}/${ticker}/create/`
    + `?apikey=${encodeURIComponent(apiKey)}`
    + `&callback=${encodeURIComponent(callbackUrl)}`
    + `&pending=1&post=1&json=1`;

  const r = await fetch(url);
  const t = await r.text();
  let data = null; try { data = JSON.parse(t); } catch {}

  if (!r.ok || !data || data.status !== 'success' || !data.address_in) {
    const msg = (data && (data.error || data.message)) || ('BlockBee unavailable (' + r.status + ')');
    return res.status(r.status && r.status >= 400 ? r.status : 502).json({ error: msg });
  }

  const address = String(data.address_in);
  const minCoin = data.minimum_transaction_coin != null ? data.minimum_transaction_coin : null;

  // Store the owner + nonce, keyed by address (the webhook resolves by
  // address_in as the definitive link) and keep the reusable record.
  await upstash(['SET', `bbowner:${address.toLowerCase()}`, userId]);
  await upstash(['SET', `bbnonce:${address.toLowerCase()}`, nonce]);
  const rec = { address, network: currency.toUpperCase(), minCoin, nonce, at: Date.now() };
  await upstash(['SET', addrKey, JSON.stringify(rec)]);

  return res.status(200).json({
    address,
    // A QR image the app can render directly (BlockBee-hosted PNG of the address).
    qr: `${BLOCKBEE_BASE}/${ticker}/qrcode/?address=${encodeURIComponent(address)}&size=300`,
    payCurrency: currency.toUpperCase(),
    network: currency.toUpperCase(),
    minCoin,
    reused: false,
    hosted: false,
  });
}
