// Creates a NOWPayments payment and returns a deposit address.
// Self-contained (no cross-dir imports) for reliable Vercel bundling.
const crypto = require('crypto');

// The smallest deposit we will ask NOWPayments to create. Their own minimum is
// per network and often far below this (USDT on BSC is ~$0.06, on Polygon
// ~$0.13); the discovery below never goes under this floor, so at 10 we were
// the reason a cheap network still demanded $10. USDT TRC20 sits at ~11 on
// their side and no floor of ours can move it.
const MIN_USD = 1;

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
      return res.status(200).json({
        address: rec.address,
        payCurrency: rec.payCurrency || payCurrency.toUpperCase(),
        paymentId: rec.paymentId,
        payinExtraId: rec.payinExtraId || null,
        network: rec.network || null,
        minUsd: rec.minUsd,
        minCoin: rec.minCoin,
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

    const cacheKey = `minprice:${payCurrency}`;
    let data = null, priceUsd = 0, lastErr = 'NOWPayments error', status = 502;

    // Fast path: reuse the previously-discovered working amount (single call).
    const cached = parseFloat(await upstash(['GET', cacheKey]));
    if (cached >= MIN_USD) {
      const r = await tryCreate(cached);
      if (r.ok) { data = r.data; priceUsd = cached; }
      else { status = r.status; lastErr = r.msg; } // stale cache → fall through to discovery
    }

    if (!data) {
      // Seed near the coin's USD minimum (best-effort), never below the floor.
      let seed = MIN_USD;
      const mr = await jget(
        `https://api.nowpayments.io/v1/min-amount?currency_from=${encodeURIComponent(payCurrency)}&fiat_equivalent=usd`,
        { headers: { 'x-api-key': apiKey } }
      );
      const minFiat = mr.ok && mr.json ? parseFloat(mr.json.fiat_equivalent) : NaN;
      if (minFiat > 0) seed = Math.max(MIN_USD, Math.ceil(minFiat));

      // Phase 1 — coarse: grow until NOWPayments accepts it (upper bound `hi`).
      let lo = MIN_USD - 1, hi = null, hiData = null, p = seed;
      for (let i = 0; i < 5 && hi === null; i++) {
        const r = await tryCreate(p);
        if (r.ok) { hi = p; hiData = r.data; break; }
        status = r.status; lastErr = r.msg;
        if (r.status === 429) { await sleep(1500); continue; }       // rate limited: retry same price
        if (r.tooSmall) { lo = p; p = Math.ceil(p * 1.6); await sleep(300); continue; }
        break;                                                        // other error → give up
      }

      // Phase 2 — refine: binary-search down to the true minimum (won't go below MIN_USD).
      let refines = 0;
      while (hi !== null && hi - lo > 1 && refines < 4) {
        refines++;
        const mid = Math.max(MIN_USD, Math.floor((lo + hi) / 2));
        if (mid <= lo || mid >= hi) break;
        await sleep(300);
        const r = await tryCreate(mid);
        if (r.ok) { hi = mid; hiData = r.data; }
        else if (r.status === 429) { await sleep(1500); refines--; }  // don't count rate-limit retries
        else if (r.tooSmall) { lo = mid; }
        else break;
      }

      if (hi !== null) { data = hiData; priceUsd = hi; }
    }

    if (!data) return res.status(status).json({ error: lastErr });

    // Remember the working amount so future deposits for this coin are a single call.
    await upstash(['SET', cacheKey, String(priceUsd), 'EX', 21600]);

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
      minUsd: priceUsd,
      minCoin: parseFloat(data.pay_amount) || null,
    };
    // Keep it for next time. Written last, so a half-finished creation is never
    // cached — a bad cached address would send real funds nowhere.
    if (out.address) {
      await upstash(['SET', addrKey, JSON.stringify(Object.assign({ at: Date.now() }, out))]);
    }

    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};
