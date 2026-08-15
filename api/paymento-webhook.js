// Paymento IPN/callback webhook. Replacement for api/ipn.js (NOWPayments).
//
// Paymento POSTs here on payment status changes. Security is TWO layers, both
// required (per Paymento docs — "do not rely on signature alone; always Verify
// Payment before finalising"):
//   1. Verify the callback signature: HMAC-SHA256 over the RAW body using the
//      dashboard secret, compared as UPPERCASE HEX, against X-HMAC-SHA256-SIGNATURE.
//   2. Call the Verify Payment API with the token and only credit if it reports
//      a paid/finished status.
//
// Crediting reuses creditDeposit() and payPartnerCommission() VERBATIM from
// api/ipn.js, so the withdrawal gate (dep:real), deposit tiers, idempotency
// (SADD seen:), ledger, notifications and partner commission all behave exactly
// as before. Only the provider/verification layer is new.
//
// Required env: PAYMENTO_API_KEY, PAYMENTO_HMAC_SECRET,
//               UPSTASH_REDIS_REST_URL/TOKEN, TELEGRAM_BOT_TOKEN.
const crypto = require('crypto');

const PAYMENTO_BASE = 'https://api.paymento.io/v1';

// The floor for crediting what actually arrived. Far below what we ask for:
// refusing to credit a real payment loses the user's money; crediting a tiny
// one costs a dust balance. (Same value as the old ipn.js.)
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

// ── creditDeposit: VERBATIM from api/ipn.js. Do not let this drift. ──────────
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
  return true;
}

// ── partner-commission block: VERBATIM from api/ipn.js / api/admin.js. ───────
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

// Paymento callback statuses that mean the money is (or will be) settled. Kept
// permissive on the naming because the docs describe status by label; the
// authoritative gate is the Verify Payment call below, not this string.
const PAID_STATUSES = /^(paid|completed|finished|confirmed|success|successful)$/i;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.PAYMENTO_HMAC_SECRET;
  if (!secret) return res.status(500).json({ error: 'Webhook secret not configured' });
  const apiKey = process.env.PAYMENTO_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Payment provider not configured' });

  let raw;
  try { raw = await readRawBody(req); } catch { return res.status(400).json({ error: 'bad body' }); }

  // ── Layer 1: signature. HMAC-SHA256 over the RAW body, UPPERCASE HEX. ──
  const expected = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex').toUpperCase();
  const sig = String(req.headers['x-hmac-sha256-signature'] || req.headers['x-hmac-sha256-signature'.toLowerCase()] || '').toUpperCase();
  try {
    const a = Buffer.from(expected, 'utf8'), b = Buffer.from(sig, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'bad signature' });
    }
  } catch {
    return res.status(401).json({ error: 'bad signature' });
  }

  let payload;
  try { payload = JSON.parse(raw); } catch { return res.status(400).json({ error: 'bad json' }); }

  const token = payload.Token || payload.token;
  const orderId = String(payload.OrderId || payload.orderId || '');
  const status = String(payload.OrderStatus || payload.orderStatus || payload.status || '');

  // Resolve the owner. Primary: orderId shape user_<userId> (same as before).
  // Fallbacks: token -> owner map, then token -> orderId map, both written by
  // api/paymento-create.js.
  let userId = orderId.startsWith('user_') ? orderId.slice(5) : null;
  if (!userId && token) {
    userId = (await upstash(['GET', `pay:token:${token}`])) || null;
    if (!userId) {
      const oid = await upstash(['GET', `pay:tokenorder:${token}`]);
      if (oid && String(oid).startsWith('user_')) userId = String(oid).slice(5);
    }
  }

  // Ack quickly for statuses we don't act on, but only after the signature
  // passed — an unsigned request never gets this far.
  if (!token || !userId) return res.status(200).json({ ok: true, ignored: 'unresolved' });

  // ── Layer 2: authoritative verification. Never credit on the callback body
  // alone; ask Paymento directly. ──
  let verified = null;
  try {
    const r = await fetch(`${PAYMENTO_BASE}/payment/verify`, {
      method: 'POST',
      headers: { 'Api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const t = await r.text();
    try { verified = JSON.parse(t); } catch { verified = null; }
    if (!r.ok) verified = null;
  } catch { verified = null; }

  if (!verified || verified.success === false) {
    // Could not confirm with the provider — do NOT credit. Returning 500 lets
    // Paymento retry the callback later (same strategy the NOWPayments handler
    // used for a failed credit).
    return res.status(500).json({ error: 'verification failed' });
  }

  const vp = verified.body || verified;
  const vStatus = String(vp.orderStatus || vp.OrderStatus || vp.status || status || '');

  // Only settle on a paid status confirmed by the verify call.
  if (!PAID_STATUSES.test(vStatus)) {
    return res.status(200).json({ ok: true, status: vStatus || 'pending' });
  }

  // Derive the USD amount from the VERIFIED payload (never trust the raw
  // callback for money). Paymento is fiat-priced, so fiatAmount is the USD we
  // asked for; fall back through common field names.
  const usd = parseFloat(
    vp.fiatAmount != null ? vp.fiatAmount
    : vp.FiatAmount != null ? vp.FiatAmount
    : vp.amount != null ? vp.amount
    : payload.fiatAmount != null ? payload.fiatAmount
    : 0
  ) || 0;

  // A stable, unique id for idempotency. PaymentId from the callback if present,
  // else the token (a token maps to exactly one payment).
  const paymentId = String(payload.PaymentId || payload.paymentId || vp.paymentId || token);

  if (usd >= MIN_USD) {
    try {
      await creditDeposit(userId, paymentId, usd, {
        coin: String(vp.cryptoCurrency || vp.coin || 'USDT').toUpperCase(),
        network: String(vp.network || 'TRC20').toUpperCase(),
        provider: 'paymento',
        token: String(token),
        at: Date.now(),
      });
    } catch (e) {
      return res.status(500).json({ error: 'credit failed' }); // triggers Paymento retry
    }
  }

  return res.status(200).json({ ok: true });
};

// Disable Vercel's body parser so we can verify the signature over the raw body.
module.exports.config = { api: { bodyParser: false } };
