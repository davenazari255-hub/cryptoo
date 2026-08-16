// BlockBee payment callback (webhook). Replacement for the NOWPayments ipn.js.
//
// BlockBee calls this URL when a deposit is detected (pending) and again once
// confirmed. We only CREDIT on the confirmed webhook (pending=0). The credit
// path reuses creditDeposit() and payPartnerCommission() VERBATIM from the old
// ipn.js, so the withdrawal gate (dep:real), deposit tiers, idempotency
// (SADD seen:), ledger, notifications and partner commission are unchanged.
//
// SECURITY — two independent layers, both required:
//   1. Nonce echo: the callback URL carried a per-address secret `nonce`; we
//      re-check it against what api/blockbee-create.js stored. A forged callback
//      that doesn't know the nonce is rejected.
//   2. RSA-SHA256 signature: BlockBee signs the request; the signature is in the
//      `x-ca-signature` header and verified against BlockBee's public key from
//      https://api.blockbee.io/pubkey/ .
//
// Required env: BLOCKBEE_API_KEY (unused here but kept for parity),
//               UPSTASH_REDIS_REST_URL/TOKEN, TELEGRAM_BOT_TOKEN.
const crypto = require('crypto');

const BLOCKBEE_BASE = 'https://api.blockbee.io';
const MIN_USD = 0.01;
const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

async function tgSend(userId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN; if (!token || !userId) return;
  const chatId = String(userId).startsWith('tg_') ? String(userId).slice(3) : String(userId);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: process.env.WEBAPP_URL ? { inline_keyboard: [[{ text: '🚀 Open KolonoEX', web_app: { url: process.env.WEBAPP_URL } }]] } : undefined }),
    });
  } catch (e) { /* ignore */ }
}

// ── creditDeposit: VERBATIM from the old api/ipn.js. Do not let this drift. ──
async function creditDeposit(userId, paymentId, usd, meta) {
  const added = await upstash(['SADD', `seen:${userId}`, String(paymentId)]);
  if (added === 0) return false;
  const amount = Math.round((parseFloat(usd) || 0) * 100) / 100;
  await upstash(['INCRBYFLOAT', `bal:${userId}`, amount]);
  await upstash(['INCRBYFLOAT', `dep:total:${userId}`, amount]);
  await upstash(['INCRBYFLOAT', `dep:real:${userId}`, amount]);
  const entry = { paymentId: String(paymentId), usd: amount, ...meta };
  await upstash(['LPUSH', `ledger:${userId}`, JSON.stringify(entry)]);
  await upstash(['LTRIM', `ledger:${userId}`, 0, 99]);
  await upstash(['LPUSH', 'deposits:all', JSON.stringify({ ...entry, userId })]);
  await upstash(['LTRIM', 'deposits:all', 0, 499]);
  const coin = (meta && meta.coin) || 'crypto';
  await upstash(['LPUSH', `cmd:${userId}`, JSON.stringify({ type: 'message', kind: 'deposit', title: 'Deposit received 💰', text: 'Your deposit of $' + amount + ' (' + coin + ') has been credited to your balance.' })]);
  await upstash(['LTRIM', `cmd:${userId}`, 0, 99]);
  await tgSend(userId, `💰 <b>Deposit received</b>\n\nYour ${escHtml(coin)} deposit worth <b>$${amount}</b> has been credited to your KolonoEX balance.`);
  try { await payPartnerCommission(userId, amount, 'deposit'); } catch (e) { /* ignore */ }
  try { await payReferrerCommission(userId, amount, 'deposit'); } catch (e) { /* ignore */ }
  return true;
}

// ── Normal-referral deposit commission ──
// A user invited through a plain ref_<id> link now earns their referrer 3% of
// every deposit that referred user makes — paid to the referrer's withdrawable
// balance, mirroring the partner commission flow. Partner links keep their own
// (10% etc.) commission via payPartnerCommission; to avoid paying twice, this
// only runs when the user was NOT referred by a partner (no ref:partner tag).
// Called from inside creditDeposit, which is guarded by `SADD seen:`, so it is
// idempotent per deposit.
const REFERRER_DEPOSIT_PCT = 3; // % of a normal referral's deposit paid to the referrer

async function payReferrerCommission(userId, amount, source) {
  // Skip if this user came through a partner link — the partner commission
  // path already handles them, and we must not double-pay.
  const partnerCode = await upstash(['GET', `ref:partner:${userId}`]);
  if (partnerCode) return;

  const referrer = await upstash(['GET', `ref:by:${userId}`]);
  if (!referrer) return;                 // organic signup, nobody to pay
  if (String(referrer) === String(userId)) return; // never self-pay

  const commission = Math.round(amount * (REFERRER_DEPOSIT_PCT / 100) * 100) / 100;
  if (!(commission > 0)) return;

  await upstash(['INCRBYFLOAT', `bal:${referrer}`, commission]);
  // Spendable AND opens nothing on its own — same treatment as partner
  // commission: it lands in payout:earned, not the real-deposit gate.
  await upstash(['INCRBYFLOAT', `payout:earned:${referrer}`, commission]);
  // Track lifetime referral earnings for display.
  await upstash(['INCRBYFLOAT', `ref:earned:${referrer}`, commission]);

  const who = await referredLabel(userId);
  await upstash(['LPUSH', `ledger:${referrer}`, JSON.stringify({ usd: commission, coin: 'REFERRAL',
    note: `Referral commission ${REFERRER_DEPOSIT_PCT}% \u00b7 ${who} \u00b7 $${amount} ${SRC_LABEL[source] || SRC_LABEL.deposit}`, at: Date.now() })]);
  await upstash(['LTRIM', `ledger:${referrer}`, 0, 99]);
  await upstash(['LPUSH', `cmd:${referrer}`, JSON.stringify({ type: 'message', kind: 'referral',
    title: 'Referral commission \u{1F4B0}',
    text: `${who} ${SRC_VERB[source] || SRC_VERB.deposit} $${amount} \u2014 you earned $${commission} (${REFERRER_DEPOSIT_PCT}%). It is in your withdrawable balance.` })]);
  await upstash(['LTRIM', `cmd:${referrer}`, 0, 99]);
  await tgSend(referrer, `\u{1F4B0} <b>Referral commission</b>\n\n<b>${escHtml(who)}</b> ${SRC_VERB[source] || SRC_VERB.deposit} <b>$${amount}</b>.`
    + `\nYou earned <b>$${commission}</b> (${REFERRER_DEPOSIT_PCT}%) \u2014 added to your withdrawable balance.`);
}

// ── partner-commission block: VERBATIM from the old api/ipn.js / api/admin.js ──
const SRC_LABEL = { deposit: 'deposit', admin: 'admin credit' };
const SRC_VERB = { deposit: 'deposited', admin: 'was credited' };

async function referredLabel(userId) {
  let prof = null;
  try { prof = JSON.parse(await upstash(['GET', `profile:${userId}`])); } catch {}
  const name = prof && prof.name ? String(prof.name).slice(0, 40) : null;
  const user = prof && prof.username ? String(prof.username).slice(0, 40) : null;
  if (name && user) return `${name} (@${user})`;
  if (name) return name;
  if (user) return `@${user}`;
  return 'a referred user';
}

async function payPartnerCommission(userId, amount, source) {
  const code = await upstash(['GET', `ref:partner:${userId}`]);
  if (!code) return;
  const owner = await upstash(['GET', `partner:owner:${code}`]);
  if (!owner) return;
  let pct = 0;
  const cfgRaw = await upstash(['GET', `partner:cfg:${code}`]);
  try { const c = JSON.parse(cfgRaw); if (c && isFinite(parseFloat(c.depositPct))) pct = parseFloat(c.depositPct); } catch {}

  await upstash(['HINCRBYFLOAT', `partner:vol:${code}`, userId, amount]);
  await upstash(['HINCRBY', `partner:cnt:${code}`, userId, 1]);

  if (!(pct > 0)) return;
  const commission = Math.round(amount * (pct / 100) * 100) / 100;
  if (!(commission > 0)) return;

  await upstash(['INCRBYFLOAT', `bal:${owner}`, commission]);
  await upstash(['INCRBYFLOAT', `partner:earned:${code}`, commission]);
  await upstash(['INCRBYFLOAT', `payout:earned:${owner}`, commission]);
  await upstash(['ZINCRBY', `partner:board:${code}`, commission, userId]);

  const who = await referredLabel(userId);
  await upstash(['LPUSH', `ledger:${owner}`, JSON.stringify({ usd: commission, coin: 'PARTNER',
    note: `Partner commission ${pct}% \u00b7 ${who} \u00b7 $${amount} ${SRC_LABEL[source] || SRC_LABEL.deposit}`, at: Date.now() })]);
  await upstash(['LTRIM', `ledger:${owner}`, 0, 99]);
  await upstash(['LPUSH', `cmd:${owner}`, JSON.stringify({ type: 'message', kind: 'referral',
    title: 'Partner commission \u{1F91D}',
    text: `${who} ${SRC_VERB[source] || SRC_VERB.deposit} $${amount} \u2014 you earned $${commission} (${pct}%). It is in your withdrawable balance.` })]);
  await upstash(['LTRIM', `cmd:${owner}`, 0, 99]);
  await tgSend(owner, `\u{1F91D} <b>Partner commission</b>\n\n<b>${escHtml(who)}</b> ${SRC_VERB[source] || SRC_VERB.deposit} <b>$${amount}</b>.`
    + `\nYou earned <b>$${commission}</b> (${pct}%) \u2014 added to your withdrawable balance.`);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// BlockBee's RSA public key, cached for the lifetime of the warm lambda.
let PUBKEY_CACHE = null;
async function blockbeePubKey() {
  if (PUBKEY_CACHE) return PUBKEY_CACHE;
  const r = await fetch(`${BLOCKBEE_BASE}/pubkey/`);
  const t = await r.text();
  let key = t;
  try { const j = JSON.parse(t); key = j.pubkey || j.public_key || t; } catch {}
  PUBKEY_CACHE = String(key).trim();
  return PUBKEY_CACHE;
}

// Verify the RSA-SHA256 signature BlockBee sends in x-ca-signature (base64) over
// the raw request body. Returns true only on a valid signature.
async function verifySignature(rawBody, signatureB64) {
  if (!signatureB64) return false;
  let pubkey;
  try { pubkey = await blockbeePubKey(); } catch { return false; }
  if (!pubkey) return false;
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(rawBody, 'utf8');
    verifier.end();
    return verifier.verify(pubkey, Buffer.from(signatureB64, 'base64'));
  } catch { return false; }
}

module.exports = async function handler(req, res) {
  // BlockBee is configured (post=1) to POST the callback.
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let raw;
  try { raw = await readRawBody(req); } catch { return res.status(400).json({ error: 'bad body' }); }

  // ── Layer 2: RSA signature over the raw body. ──
  const sig = req.headers['x-ca-signature'] || req.headers['x-ca-signature'.toLowerCase()];
  const sigOk = await verifySignature(raw, sig);
  if (!sigOk) return res.status(401).json({ error: 'bad signature' });

  // Body is JSON (json=1). Query params we added to the callback URL (user,
  // coin, nonce) arrive as query string on the request URL.
  let payload = {};
  try { payload = JSON.parse(raw); } catch { payload = {}; }

  let q = {};
  try { q = Object.fromEntries(new URL(req.url, 'https://x').searchParams); } catch {}

  const userId = q.user || payload.user || null;
  const coin = q.coin || payload.coin || 'usdttrc20';
  const nonce = q.nonce || payload.nonce || '';
  const addressIn = String(payload.address_in || q.address_in || '').toLowerCase();

  if (!userId || !addressIn) {
    // Signature was valid but we cannot attribute — ack so BlockBee stops, but
    // do not credit.
    return res.status(200).json({ ok: true, ignored: 'unattributed' });
  }

  // ── Layer 1: nonce echo must match what we stored for this address. ──
  let expectedNonce = null;
  try { expectedNonce = await upstash(['GET', `bbnonce:${addressIn}`]); } catch {}
  if (!expectedNonce || String(expectedNonce) !== String(nonce)) {
    return res.status(401).json({ error: 'bad nonce' });
  }

  // Cross-check the address really belongs to the claimed user.
  let owner = null;
  try { owner = await upstash(['GET', `bbowner:${addressIn}`]); } catch {}
  if (!owner || String(owner) !== String(userId)) {
    return res.status(401).json({ error: 'owner mismatch' });
  }

  const pending = String(payload.pending != null ? payload.pending : q.pending) === '1';
  const txid = payload.txid_in || payload.txid || q.txid_in || null;

  // USD value. BlockBee gives the received amount in the coin (value_coin),
  // before fees; we credit the gross the user actually sent (the same
  // "credit what arrived" policy the old ipn.js used).
  const valueCoin = parseFloat(
    payload.value_coin != null ? payload.value_coin
    : payload.value != null ? payload.value
    : 0
  ) || 0;

  // Convert the received amount to USD so ANY coin can be credited, not just
  // USDT. Sources, in order of trust:
  //   1. value_coin_convert.USD — BlockBee's own fiat conversion, present when
  //      the address was created with convert=1 (see blockbee-create.js). Most
  //      accurate. It may arrive as a JSON string or an already-parsed object.
  //   2. value_coin * price      — `price` is the coin's USD price at webhook
  //      time and is always sent, so this covers older addresses created before
  //      convert=1 was added.
  //   3. USDT fallback (~1:1)    — if neither is available but the coin is a
  //      USDT ticker, 1 unit ≈ $1, matching the previous behaviour.
  // Was: `const usd = isUsdt ? valueCoin : 0;` — which credited $0 for every
  // non-USDT coin, so those deposits silently never reached the balance.
  const parseConvert = (v) => {
    if (v == null) return null;
    let obj = v;
    if (typeof v === 'string') { try { obj = JSON.parse(v); } catch { return null; } }
    if (!obj || typeof obj !== 'object') return null;
    // Keys may be upper or lower case depending on BlockBee.
    const n = parseFloat(obj.USD != null ? obj.USD : obj.usd);
    return isFinite(n) && n > 0 ? n : null;
  };
  const isUsdt = /usdt/i.test(String(coin));
  const priceUsd = parseFloat(payload.price != null ? payload.price : q.price) || 0;
  const convertUsd = parseConvert(payload.value_coin_convert);

  let usd = 0;
  if (convertUsd != null) {
    usd = convertUsd;                                   // 1. BlockBee fiat conversion
  } else if (priceUsd > 0 && valueCoin > 0) {
    usd = valueCoin * priceUsd;                         // 2. amount × live price
  } else if (isUsdt) {
    usd = valueCoin;                                    // 3. USDT ~1:1 fallback
  }
  usd = Math.round((usd || 0) * 100) / 100;

  // Record the latest event for the status poll (both pending and confirmed).
  try {
    await upstash(['SET', `bbseen:${addressIn}`, JSON.stringify({
      status: pending ? 'pending' : 'confirmed',
      usd, coin: String(coin).toUpperCase(), txid, at: Date.now(),
    })]);
    await upstash(['EXPIRE', `bbseen:${addressIn}`, 86400]);
  } catch {}

  // Only CREDIT on the confirmed webhook.
  if (pending) return res.status(200).json({ ok: true, status: 'pending' });

  if (usd >= MIN_USD) {
    // Idempotency id: the incoming tx hash is unique per deposit. Falls back to
    // BlockBee's uuid, then the address (last resort).
    const paymentId = String(txid || payload.uuid || addressIn);
    try {
      await creditDeposit(userId, paymentId, usd, {
        coin: String(coin).toUpperCase(),
        network: String(coin).toUpperCase(),
        provider: 'blockbee',
        txid: txid || null,
        at: Date.now(),
      });
    } catch (e) {
      return res.status(500).json({ error: 'credit failed' }); // BlockBee will retry
    }
  }

  // BlockBee expects the literal string "*ok*" to stop resending the callback.
  res.setHeader('Content-Type', 'text/plain');
  return res.status(200).send('*ok*');
};

// Disable Vercel's body parser so we can verify the signature over the raw body.
module.exports.config = { api: { bodyParser: false } };
