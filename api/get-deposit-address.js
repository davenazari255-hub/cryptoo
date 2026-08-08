// Creates a NOWPayments payment and returns a deposit address.
// Self-contained (no cross-dir imports) for reliable Vercel bundling.
const crypto = require('crypto');

// Per-network deposit minimum, in USD, and deliberately a round number: the
// figure users saw before came straight from NOWPayments' pay_amount and read
// like "17.219728 USDT". These are ours, chosen just above NOWPayments' own
// published floor for each network so the ask is always clean.
//
//   their floor        ours
//   TRC20   11.12  ->  12     (theirs is the binding constraint here)
//   ERC20    0.56  ->   5     (Ethereum gas makes anything smaller pointless)
//   OP       2.20  ->   5
//   ARB      0.27  ->   2
//   POLYGON  0.13  ->   2
//   BSC      0.055 ->   2
const MIN_USD_BY_CURRENCY = {
  usdttrc20: 12,
  usdterc20: 5,
  usdtbsc: 2,
  usdtmatic: 2,
  usdtarb: 2,
  btc: 10,
  eth: 10,
  bnbbsc: 5,
  sol: 5,
  trx: 5,
  ton: 5,
};
const MIN_USD_DEFAULT = 5;
const minUsdFor = (cur) => MIN_USD_BY_CURRENCY[cur] || MIN_USD_DEFAULT;

// Only ever ask for a round number. If NOWPayments will not take our floor we
// climb this ladder rather than binary-searching into 17.219728 territory.
const CLEAN_STEPS = [1, 2, 3, 5, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500];
const cleanUp = (x) => CLEAN_STEPS.find((v) => v >= x - 1e-9) || Math.ceil(x / 100) * 100;

// A stablecoin's minimum reads naturally in the coin itself; everything else is
// shown in dollars, because "0.00013 BTC" is not a friendlier number.
const STABLE = /^usd|^dai|^tusd/;

const MIN_USD = MIN_USD_DEFAULT;   // kept for anything still referring to it

// ── Upstash REST helper (best-effort: returns null on any failure) ──
// This file is the one that hands out an address a stranger will send real
// money to, and it was the only money path that swallowed storage errors. With
// the database refusing commands it would still mint a fresh NOWPayments
// address, fail silently to record who owns it, and return it — so the deposit
// arrived somewhere nobody could attribute, and the IPN could not credit it
// either. Refusing to issue an address is the only safe answer.
//
// A missing key is still a normal null; only a real failure throws.
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

// One guard around the whole handler. Two of the storage reads happen before
// the inner try block, so catching StorageDown only there let the throw escape
// as an unhandled 500 — which is exactly the vague failure this change existed
// to replace.
module.exports = async function handler(req, res) {
  try {
    return await deposit(req, res);
  } catch (err) {
    if (err instanceof StorageDown) {
      return res.status(503).json({
        error: 'Deposits are paused for maintenance. Please try again later — your funds and balance are safe.',
      });
    }
    throw err;
  }
};

async function deposit(req, res) {
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

  if (await upstash(['GET', `banned:${userId}`])) return res.status(403).json({ error: 'Account suspended' });

  const payCurrency = String(currency).toLowerCase();

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const ipnUrl = process.env.IPN_CALLBACK_URL || (host ? `${proto}://${host}/api/ipn` : undefined);

  // One fixed address per user per coin. NOWPayments supports this with the
  // Payments API we already use: create the payment once, keep the address, and
  // later sends to it are recognised as repeat deposits (they raise a new
  // payment carrying parent_payment_id, which api/ipn.js resolves). Previously
  // a fresh payment — and so a fresh address — was created on every visit.
  const addrKey = `depaddr:${userId}:${payCurrency}`;
  const saved = await upstash(['GET', addrKey]);
  if (saved) {
    let rec = null;
    try { rec = JSON.parse(saved); } catch {}
    if (rec && rec.address) {
      // The address is a property of the account; the minimum is policy. Serving
      // the figure frozen into this record is what kept showing the old number
      // long after the floor changed, so it is recomputed on every read.
      return res.status(200).json({
        address: rec.address,
        payCurrency: rec.payCurrency || payCurrency.toUpperCase(),
        paymentId: rec.paymentId,
        payinExtraId: rec.payinExtraId || null,
        network: rec.network || null,
        minUsd: minUsdFor(payCurrency),
        stable: STABLE.test(payCurrency),
        // Tells the client not to poll that original payment: it settled long
        // ago and would report "finished" before this deposit even lands.
        reused: true,
      });
    }
  }

  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Safe fetch: never throw on a non-JSON (HTML error page) response.
    const jget = async (url, opts) => {
      const r = await fetch(url, opts);
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { ok: r.ok, status: r.status, json: j, text: t };
    };

    // Try to create a payment at a given USD price. Never throws.
    const tryCreate = async (priceUsd) => {
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
      if (resp.ok && resp.json && resp.json.pay_address) return { ok: true, data: resp.json };
      const status = resp.status || 502;
      const msg = (resp.json && resp.json.message) || ('NOWPayments unavailable (' + status + ')');
      return { ok: false, status, msg, tooSmall: /too small|too low|minim/i.test(msg) };
    };

    // Ask only for round numbers, climbing a ladder from our own floor. The
    // old code binary-searched and cached whatever it landed on, which is how
    // "17.219728 USDT" ended up on screen and then stuck: the cache had no
    // version, so every hit re-cached the same high value and lowering the
    // floor changed nothing anyone could see.
    const floorUsd = minUsdFor(payCurrency);
    let data = null, priceUsd = 0, lastErr = 'NOWPayments error', status = 502;

    // Their published minimum, only ever used to skip candidates we know are
    // too small — never to raise the ask above what they would accept.
    let theirMin = 0;
    const mr = await jget(
      `https://api.nowpayments.io/v1/min-amount?currency_from=${encodeURIComponent(payCurrency)}&fiat_equivalent=usd`,
      { headers: { 'x-api-key': apiKey } }
    );
    if (mr.ok && mr.json) theirMin = parseFloat(mr.json.fiat_equivalent) || 0;

    const start = cleanUp(Math.max(floorUsd, theirMin));
    let ladder = CLEAN_STEPS.filter((v) => v >= start);
    if (!ladder.length) ladder = [start];

    // There is deliberately no cached "amount that worked last time". That cache
    // is what froze 17 in place: any high value it held was tried first and
    // accepted, so the ask could never come back down. Since an address is now
    // created once per user per coin and reused after that, this path runs
    // rarely and the extra call costs nothing worth the risk.

    for (let i = 0; i < ladder.length && i < 6; i++) {
      const r = await tryCreate(ladder[i]);
      if (r.ok) { data = r.data; priceUsd = ladder[i]; break; }
      status = r.status; lastErr = r.msg;
      if (r.status === 429) { await sleep(1500); i--; continue; }   // rate limited: same rung again
      if (!r.tooSmall) break;                                        // a real error, not a floor problem
      await sleep(250);
    }

    if (!data) return res.status(status).json({ error: lastErr });

    // Record who owns this payment so /api/check-payment can authorise status
    // lookups (NOWPayments ids are sequential — without this, anyone could
    // enumerate every user's deposit). No TTL any more: the address is now
    // permanent, so a repeat deposit months later must still resolve its owner
    // through parent_payment_id.
    if (data.payment_id != null) {
      await upstash(['SET', `pay:owner:${data.payment_id}`, userId]);
    }
    // And by address, as the last-resort resolution path in api/ipn.js.
    if (data.pay_address) {
      await upstash(['SET', `payaddr:${String(data.pay_address).toLowerCase()}`, userId]);
    }

    const out = {
      address: data.pay_address,
      payCurrency: (data.pay_currency || payCurrency).toUpperCase(),
      paymentId: data.payment_id,
      payinExtraId: data.payin_extra_id || null,
      network: data.network || null,
      // The round policy figure, not NOWPayments' pay_amount. That is what read
      // as "17.219728 USDT"; it is the exact coin value of the payment we
      // happened to create, which is not a minimum anyone needs to see.
      minUsd: Math.max(minUsdFor(payCurrency), priceUsd),
      stable: STABLE.test(payCurrency),
      askedUsd: priceUsd,
    };
    // Keep it for next time. Written last, so a half-finished creation is never
    // cached — a bad cached address would send real funds nowhere.
    if (out.address) {
      await upstash(['SET', addrKey, JSON.stringify(Object.assign({ at: Date.now() }, out))]);
    }

    return res.status(200).json(out);
  } catch (err) {
    if (err instanceof StorageDown) {
      // Deliberately not a 500: nothing is wrong with the request, we simply
      // cannot record the deposit right now and must not take money blind.
      return res.status(503).json({
        error: 'Deposits are paused for maintenance. Please try again later — your funds and balance are safe.',
      });
    }
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};
