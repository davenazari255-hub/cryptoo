// NOWPayments IPN (Instant Payment Notification) webhook.
// NOWPayments POSTs here on every payment status change. We verify the
// HMAC-SHA512 signature, and on `finished` credit the user idempotently.
// Self-contained (no cross-dir imports) for reliable Vercel bundling.
// Required env: NOWPAYMENTS_IPN_SECRET, UPSTASH_REDIS_REST_URL/TOKEN.
const crypto = require('crypto');

// The floor for *crediting* what actually arrived, which is deliberately far
// below the floor we ask for. Refusing to credit a payment the user really made
// loses their money; crediting a small one costs nothing but a dust balance.
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

// Idempotently credit a finished deposit; returns false if already processed.
async function creditDeposit(userId, paymentId, usd, meta) {
  const added = await upstash(['SADD', `seen:${userId}`, String(paymentId)]);
  if (added === 0) return false;
  const amount = Math.round((parseFloat(usd) || 0) * 100) / 100;
  await upstash(['INCRBYFLOAT', `bal:${userId}`, amount]);
  await upstash(['INCRBYFLOAT', `dep:total:${userId}`, amount]); // lifetime credit (drives deposit tiers)
  // Real, on-chain money only. This is the sole thing that opens the withdrawal
  // gate — admin credits and bonus profit deliberately do not write it.
  await upstash(['INCRBYFLOAT', `dep:real:${userId}`, amount]);
  const entry = { paymentId: String(paymentId), usd: amount, ...meta };
  await upstash(['LPUSH', `ledger:${userId}`, JSON.stringify(entry)]);
  await upstash(['LTRIM', `ledger:${userId}`, 0, 99]);
  // Global deposits feed for the admin report.
  await upstash(['LPUSH', 'deposits:all', JSON.stringify({ ...entry, userId })]);
  await upstash(['LTRIM', 'deposits:all', 0, 499]);
  // Notify the user: in-app (next sync) + bot push.
  const coin = (meta && meta.coin) || 'crypto';
  await upstash(['LPUSH', `cmd:${userId}`, JSON.stringify({ type: 'message', kind: 'deposit', title: 'Deposit received 💰', text: 'Your deposit of $' + amount + ' (' + coin + ') has been credited to your balance.' })]);
  await upstash(['LTRIM', `cmd:${userId}`, 0, 99]);
  await tgSend(userId, `💰 <b>Deposit received</b>\n\nYour ${escHtml(coin)} deposit worth <b>$${amount}</b> has been credited to your KolonoEX balance.`);
  // Partner commission: if this user came through a partner link, pay the partner
  // a % of the deposit (config set by admin). Best-effort — never blocks the credit.
  try { await payPartnerCommission(userId, amount, 'deposit'); } catch (e) { /* ignore */ }
  return true;
}

// ── shared partner-commission block ───────────────────────────────────────────
// This block is duplicated verbatim in api/admin.js, because every file in api/
// is its own Vercel bundle and cross-directory imports were unreliable here.
// test_commission.js asserts the two copies are byte-identical, so they cannot
// drift — a drifting money function is exactly how the 150-USDT coupon got
// clamped to 100 earlier in this project.
const SRC_LABEL = { deposit: 'deposit', admin: 'admin credit' };
const SRC_VERB = { deposit: 'deposited', admin: 'was credited' };

// How a referred user is named back to their partner. Falls back to a neutral
// label rather than exposing the raw user id.
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

// Credit a partner a percentage of a referred user's deposit.
async function payPartnerCommission(userId, amount, source) {
  const code = await upstash(['GET', `ref:partner:${userId}`]);
  if (!code) return;
  const owner = await upstash(['GET', `partner:owner:${code}`]);
  if (!owner) return;
  let pct = 0;
  const cfgRaw = await upstash(['GET', `partner:cfg:${code}`]);
  try { const c = JSON.parse(cfgRaw); if (c && isFinite(parseFloat(c.depositPct))) pct = parseFloat(c.depositPct); } catch {}

  // Volume is recorded even at 0% so the partner's list still shows what their
  // referrals deposited, and so raising the rate later has history behind it.
  await upstash(['HINCRBYFLOAT', `partner:vol:${code}`, userId, amount]);
  await upstash(['HINCRBY', `partner:cnt:${code}`, userId, 1]);

  if (!(pct > 0)) return;
  const commission = Math.round(amount * (pct / 100) * 100) / 100;
  if (!(commission > 0)) return;

  await upstash(['INCRBYFLOAT', `bal:${owner}`, commission]);
  await upstash(['INCRBYFLOAT', `partner:earned:${code}`, commission]);
  // Commission is real earned money, unlike paper trading gains. Withdrawals are
  // capped by what a user actually funded (see api/withdraw.js), so without this
  // the commission sat in the balance and could never be taken out.
  await upstash(['INCRBYFLOAT', `payout:earned:${owner}`, commission]);
  // Per-referral ledger. The sorted set gives the ranking for free.
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

function sortObject(obj) {
  if (Array.isArray(obj)) return obj.map(sortObject);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((a, k) => { a[k] = sortObject(obj[k]); return a; }, {});
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

  const expected = crypto.createHmac('sha512', secret).update(JSON.stringify(sortObject(payload))).digest('hex');
  const sig = req.headers['x-nowpayments-sig'];
  try {
    const a = Buffer.from(expected, 'hex'), b = Buffer.from(String(sig || ''), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'bad signature' });
    }
  } catch {
    return res.status(401).json({ error: 'bad signature' });
  }

  // Who does this money belong to? Three paths, tried in order. The first is
  // how it has always worked. The other two exist because a repeat deposit to a
  // stored address raises a *new* payment, and its callback may not carry the
  // order_id we set on the original — without them that money would arrive and
  // never be credited. Additive: this can only ever resolve more, never fewer.
  const orderId = String(payload.order_id || '');
  let userId = orderId.startsWith('user_') ? orderId.slice(5) : null;
  if (!userId && payload.parent_payment_id != null) {
    userId = (await upstash(['GET', `pay:owner:${payload.parent_payment_id}`])) || null;
  }
  if (!userId && payload.pay_address) {
    userId = (await upstash(['GET', `payaddr:${String(payload.pay_address).toLowerCase()}`])) || null;
  }

  if (payload.payment_status === 'finished' && userId) {
    const paid = parseFloat(payload.actually_paid) || 0;
    const expect = parseFloat(payload.pay_amount) || 0;
    const price = parseFloat(payload.price_amount) || 0;
    const usd = expect > 0 ? (paid / expect) * price : price;

    if (usd >= MIN_USD) {
      try {
        const tsRaw = payload.updated_at || payload.created_at || null;
        const ts = tsRaw ? (Date.parse(tsRaw) || null) : null;
        await creditDeposit(userId, payload.payment_id, usd, {
          coin: String(payload.pay_currency || '').toUpperCase(),
          network: String(payload.network || payload.pay_currency || '').toUpperCase(),
          actuallyPaid: payload.actually_paid != null ? String(payload.actually_paid) : null,
          at: ts,
        });
      } catch (e) {
        return res.status(500).json({ error: 'credit failed' }); // triggers NOWPayments retry
      }
    }
  }

  return res.status(200).json({ ok: true });
};

// Disable Vercel's body parser so we can verify the signature over the raw body.
module.exports.config = { api: { bodyParser: false } };
