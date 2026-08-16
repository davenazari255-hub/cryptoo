// Admin API for managing withdrawal requests. Protected by ADMIN_SECRET (web
// admin.html) OR a verified Telegram admin (the mini app, owner accounts).
// Actions: list (pending), decide (approve | reject | paid).
// reject refunds the held balance back to the user. Self-contained for Vercel.
const crypto = require('crypto');

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

// Batch many commands into ONE HTTP request via Upstash's /pipeline endpoint.
// `commands` is a 2D array: [["DEL","k"],["LPUSH","l","x"],...]. Not atomic —
// commands run in order but may interleave with other clients, which is fine
// for an independent per-user reset. The response is one result per command;
// individual command errors are returned inline as {error} and skipped rather
// than throwing, so one bad key can't fail the whole batch. This turns the
// resetAll loop from ~3 round trips PER USER into a handful of batched calls.
async function upstashPipeline(commands) {
  if (!commands.length) return [];
  const URL = process.env.UPSTASH_REDIS_REST_URL, TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!URL || !TOKEN) throw new Error('Upstash not configured');
  const res = await fetch(`${URL.replace(/\/+$/, '')}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error('Upstash pipeline: ' + (data.error || res.status));
  return data; // array of { result } | { error }
}

const parseJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Verify a Telegram WebApp initData string and return the user (or null).
function verifyTelegram(initData) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !initData || typeof initData !== 'string') return null;
  let params; try { params = new URLSearchParams(initData); } catch { return null; }
  const hash = params.get('hash'); if (!hash) return null;
  params.delete('hash');
  const pairs = []; for (const [k, v] of params) pairs.push(`${k}=${v}`); pairs.sort();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calc = crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  try { const a = Buffer.from(calc, 'hex'), b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null; } catch { return null; }
  const authDate = parseInt(params.get('auth_date'), 10);
  if (authDate && Date.now() / 1000 - authDate > 86400) return null;
  try { const u = JSON.parse(params.get('user') || 'null'); return (u && u.id) ? u : null; } catch { return null; }
}

// Allowlist of admin Telegram numeric IDs: built-in owner(s) + ADMIN_IDS env
// (comma-separated). The mini app authenticates admins via verified initData.
function adminIds() {
  const env = String(process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return new Set(['5664533861', ...env]);
}
function isTelegramAdmin(initData) {
  const u = verifyTelegram(initData);
  return !!u && adminIds().has(String(u.id));
}

// Push a message into the user's bot chat (outside the mini app). Best-effort.
async function tgSend(userId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !userId) return;
  const chatId = String(userId).startsWith('tg_') ? String(userId).slice(3) : String(userId);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: process.env.WEBAPP_URL ? { inline_keyboard: [[{ text: '🚀 Open KolonoEX', web_app: { url: process.env.WEBAPP_URL } }]] } : undefined }),
    });
  } catch (e) { /* ignore */ }
}

// ── Image helpers for broadcasts (mirrors api/support.js) ─────────────────────
// api/ files are independent Vercel bundles with no shared imports, so the same
// small photo helpers are inlined here. Strategy for a mass broadcast: upload
// the image bytes to Telegram ONCE, keep the returned file_id, then re-send that
// file_id to every recipient — no re-uploading megabytes per user.
const IMG_MAX_BYTES = 5 * 1024 * 1024;
const chatIdOf = (id) => (String(id).startsWith('tg_') ? String(id).slice(3) : String(id));
// Signed image proxy URL, identical scheme to api/support.js so the broadcast's
// in-app notification can show the same Telegram-hosted image via /api/support
// without storing the raw (large) base64 bytes in every user's cmd: list.
function imgKey() { return process.env.ADMIN_SECRET || process.env.TELEGRAM_BOT_TOKEN || 'kolonoex'; }
function imgSig(fileId) { return crypto.createHmac('sha256', imgKey()).update(String(fileId)).digest('hex').slice(0, 20); }
function imgUrl(fileId) { return `/api/support?action=img&id=${encodeURIComponent(fileId)}&t=${imgSig(fileId)}`; }
function parseDataUrl(s) {
  const m = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(s || ''));
  if (!m) return null;
  let buf; try { buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64'); } catch { return null; }
  if (!buf.length || buf.length > IMG_MAX_BYTES) return null;
  return { buf, mime: m[1] === 'image/jpg' ? 'image/jpeg' : m[1] };
}
// Upload bytes once; returns the largest file_id Telegram gives back (or null).
async function tgUploadPhoto(chatId, buf, mime, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN; if (!token || !chatId) return null;
  try {
    const fd = new FormData();
    fd.append('chat_id', chatIdOf(chatId));
    if (caption) { fd.append('caption', String(caption).slice(0, 1024)); fd.append('parse_mode', 'HTML'); }
    fd.append('photo', new Blob([buf], { type: mime || 'image/jpeg' }), 'photo.jpg');
    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: fd });
    const d = await r.json();
    const ph = d && d.ok && d.result && d.result.photo;
    return ph && ph.length ? ph[ph.length - 1].file_id : null;
  } catch { return null; }
}
// Re-send an already-uploaded photo to another chat by file_id — no bytes sent.
async function tgSendPhotoId(chatId, fileId, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN; if (!token || !chatId || !fileId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatIdOf(chatId), photo: fileId, caption: caption ? String(caption).slice(0, 1024) : undefined, parse_mode: 'HTML' }),
    });
  } catch { /* ignore */ }
}
// Plain text bot message (no "Open app" button); used for broadcast text pushes.
async function tgSendPlain(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN; if (!token || !chatId || !text) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatIdOf(chatId), text: String(text).slice(0, 4096), parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { /* ignore */ }
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.ADMIN_SECRET;
  const body = req.body || {};
  const secretOk = !!secret && body.secret === secret;
  const tgOk = !!body.initData && isTelegramAdmin(body.initData);
  
  // Public endpoint for checking maintenance status
  if (body.action === 'getMaintenanceStatus' && body.public) {
    try {
      const raw = await upstash(['GET', 'config:maintenance']);
      const state = parseJSON(raw) || { enabled: false, endTime: null };
      return res.status(200).json(state);
    } catch (err) {
      return res.status(200).json({ enabled: false, endTime: null });
    }
  }
  
  if (!secretOk && !tgOk) return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (body.action === 'list') {
      const ids = (await upstash(['LRANGE', 'wd:pending', 0, 199])) || [];
      let items = [];
      if (ids.length) items = (await upstash(['MGET', ...ids.map((id) => `wd:item:${id}`)])) || [];
      const pending = items.map(parseJSON).filter(Boolean);
      return res.status(200).json({ pending });
    }

    // ── User management ──
    if (body.action === 'users') {
      const ids = (await upstash(['SMEMBERS', 'users'])) || [];
      if (!ids.length) return res.status(200).json({ users: [] });
      const [profiles, bals, bans, refs] = await Promise.all([
        upstash(['MGET', ...ids.map((id) => `profile:${id}`)]),
        upstash(['MGET', ...ids.map((id) => `bal:${id}`)]),
        upstash(['MGET', ...ids.map((id) => `banned:${id}`)]),
        upstash(['MGET', ...ids.map((id) => `ref:count:${id}`)]),
      ]);
      const users = ids.map((id, i) => {
        const p = parseJSON(profiles[i]) || {};
        return {
          userId: id, username: p.username || null, name: p.name || null,
          joinedAt: p.joinedAt || null, lastSeen: p.lastSeen || null,
          balance: parseFloat(bals[i]) || 0, equity: p.equity || 0, bonus: p.bonus || 0,
          positions: (p.positions || []).length, openOrders: (p.openOrders || []).length,
          referrals: parseInt(refs[i], 10) || 0,
          banned: !!bans[i],
        };
      }).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      return res.status(200).json({ users });
    }

    if (body.action === 'deposits') {
      const rows = (await upstash(['LRANGE', 'deposits:all', 0, 199])) || [];
      const deposits = rows.map(parseJSON).filter(Boolean);
      return res.status(200).json({ deposits });
    }

    if (body.action === 'user') {
      const id = String(body.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      const [profile, bal, banned, wdIds, ledger, refCount, refBy] = await Promise.all([
        upstash(['GET', `profile:${id}`]),
        upstash(['GET', `bal:${id}`]),
        upstash(['GET', `banned:${id}`]),
        upstash(['LRANGE', `wd:user:${id}`, 0, 29]),
        upstash(['LRANGE', `ledger:${id}`, 0, 29]),
        upstash(['GET', `ref:count:${id}`]),
        upstash(['GET', `ref:by:${id}`]),
      ]);
      let withdrawals = [];
      if (wdIds && wdIds.length) {
        const items = await upstash(['MGET', ...wdIds.map((w) => `wd:item:${w}`)]);
        withdrawals = (items || []).map(parseJSON).filter(Boolean);
      }
      return res.status(200).json({
        profile: parseJSON(profile) || { userId: id },
        balance: parseFloat(bal) || 0,
        banned: !!banned,
        withdrawals,
        deposits: (ledger || []).map(parseJSON).filter(Boolean),
        referral: { count: parseInt(refCount, 10) || 0, referredBy: refBy || null },
      });
    }

    if (body.action === 'adjust') {
      const id = String(body.id || '');
      const amount = Math.round((parseFloat(body.amount) || 0) * 100) / 100;
      // Was missing: the notification below reads `note`, and without this the
      // handler threw ReferenceError *after* the balance had already moved —
      // money applied, error shown, nobody notified.
      const note = String(body.note || '').trim();
      if (!id || !amount) return res.status(400).json({ error: 'id and non-zero amount required' });
      const newBal = parseFloat(await upstash(['INCRBYFLOAT', `bal:${id}`, amount]));
      if (newBal < 0) { await upstash(['INCRBYFLOAT', `bal:${id}`, -amount]); return res.status(400).json({ error: 'Would make balance negative' }); }
      // A positive admin credit counts as a deposit (so it unlocks withdrawals).
      if (amount > 0) await upstash(['INCRBYFLOAT', `dep:total:${id}`, amount]);
      await upstash(['LPUSH', `ledger:${id}`, JSON.stringify({ usd: amount, coin: 'ADMIN', note: String(body.note || 'Admin adjustment'), at: Date.now() })]);
      await upstash(['LTRIM', `ledger:${id}`, 0, 99]);
      // The bonus action has always notified; this one only wrote a ledger row,
      // so money appeared in a user's balance with no explanation. Both channels
      // now, like every other money event.
      const up = amount > 0;
      const abs = Math.abs(amount);
      await upstash(['LPUSH', `cmd:${id}`, JSON.stringify({ type: 'message', kind: 'deposit',
        title: up ? 'Balance credited \u{1F4B0}' : 'Balance adjusted',
        text: (up ? '$' + abs + ' has been added to your balance.' : '$' + abs + ' has been deducted from your balance.')
          + (note ? '\n\n' + note : '') })]);
      await upstash(['LTRIM', `cmd:${id}`, 0, 99]);
      await tgSend(id, `\u{1F4B0} <b>Balance ${up ? '+' : '\u2212'}$${abs}</b> has been ${up ? 'added to' : 'deducted from'} your KolonoEX balance.`
        + `${note ? `\n\n\u{1F4DD} ${escHtml(note)}` : ''}`);
      // An admin credit already counts as a deposit everywhere else — it raises
      // dep:total, unlocks withdrawals and drives the deposit tiers — so it must
      // reach the partner too, otherwise a partner-referred user credited by
      // hand was invisible in the partner's own list. Opt out per adjustment
      // with payCommission:false, for corrections and refunds.
      let commissionPaid = false;
      if (amount > 0 && body.payCommission !== false) {
        try { await payPartnerCommission(id, amount, 'admin'); commissionPaid = true; }
        catch (e) { /* best-effort: never fails the adjustment itself */ }
      }
      return res.status(200).json({ ok: true, balance: newBal, commissionPaid });
    }

    if (body.action === 'ban' || body.action === 'unban') {
      const id = String(body.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      if (body.action === 'ban') await upstash(['SET', `banned:${id}`, '1']);
      else await upstash(['DEL', `banned:${id}`]);
      return res.status(200).json({ ok: true, banned: body.action === 'ban' });
    }

const DEFAULT_BANNERS = [
  { id: 'partner', img: 'poster-partner.jpg', tag: 'Partner Program', accent: 'green',
    title: 'Run a crypto channel?', sub: 'Get paid for your audience.',
    hi: '', foot: 'Commission on every trader you bring in',
    cta: 'Apply as a partner', action: 'partner', link: '', on: true },
  { id: 'bonus', img: 'poster-bonus.jpg', tag: 'Coupon Center', accent: 'gold',
    title: 'Every reward is a coupon.', sub: 'Collect them. Activate them. Trade them.',
    hi: '125\u00d7', foot: 'Futures margin \u00b7 up to 125\u00d7 leverage',
    cta: 'Open Coupon Center', action: 'coupons', link: '', on: true },
];

// Whatever the admin saved, normalised so a bad row cannot break the client.
function cleanBanners(list) {
  const ACTIONS = ['partner', 'coupons', 'invite', 'tasks', 'assets', 'trade', 'futures', 'link', 'none'];
  const ACCENTS = ['green', 'gold', 'purple'];
  // Either an absolute https URL or a same-origin image file. Deliberately
  // strict: `javascript:` and `data:` are obvious, but a protocol-relative
  // `//evil.com/a.jpg` also loads from someone else's origin, and a bare
  // `https?://` prefix test would let a quote-breaking value through.
  const cleanImg = (s) => { const v = String(s || '').trim().slice(0, 300);
    if (/^https:\/\/[^\s"'<>\\]+$/i.test(v)) return v;
    if (/^[\w.\-]+(\/[\w.\-]+)*\.(jpe?g|png|webp|avif|gif)$/i.test(v)) return v;
    return ''; };
  const cleanLink = (s) => { const v = String(s || '').trim().slice(0, 300);
    return /^(https?:\/\/|tg:\/\/)/i.test(v) ? v : ''; };
  return (Array.isArray(list) ? list : []).slice(0, 8).map((b, i) => ({
    id: String(b.id || ('b' + i)).slice(0, 24).replace(/[^a-zA-Z0-9_]/g, '') || ('b' + i),
    img: cleanImg(b.img),
    tag: String(b.tag || '').slice(0, 28),
    accent: ACCENTS.includes(b.accent) ? b.accent : 'green',
    title: String(b.title || '').slice(0, 80),
    sub: String(b.sub || '').slice(0, 90),
    hi: String(b.hi || '').slice(0, 18),
    foot: String(b.foot || '').slice(0, 90),
    cta: String(b.cta || 'Learn more').slice(0, 32),
    action: ACTIONS.includes(b.action) ? b.action : 'none',
    link: cleanLink(b.link),
    on: b.on !== false,
  })).filter((b) => b.img || b.title);
}

    // ── Coupon management ──
    // Coupons live as a JSON array at coupons:<user>. `coupon:used:<user>` is the
    // one-shot activation guard, so removing a coupon has to clear its entry
    // there too or the id could never be reissued.
    const COUPON_TTL_DAYS = 7;
    if (body.action === 'getCoupons') {
      const id = String(body.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      const list = parseJSON(await upstash(['GET', `coupons:${id}`]));
      const used = (await upstash(['SMEMBERS', `coupon:used:${id}`])) || [];
      const bonus = parseFloat(await upstash(['GET', `bonus:${id}`])) || 0;
      return res.status(200).json({
        coupons: Array.isArray(list) ? list : [], used, bonus, now: Date.now(),
      });
    }
    if (body.action === 'sendCoupon') {
      const id = String(body.id || '');
      const amount = Math.round((parseFloat(body.amount) || 0) * 100) / 100;
      const title = String(body.title || 'Bonus coupon').slice(0, 60).trim() || 'Bonus coupon';
      const days = Math.max(1, Math.min(90, parseInt(body.days, 10) || COUPON_TTL_DAYS));
      if (!id) return res.status(400).json({ error: 'id required' });
      // Same ceiling the activation path enforces, so the panel can never mint a
      // coupon larger than the client is allowed to redeem.
      if (!(amount > 0) || amount > 1000) return res.status(400).json({ error: 'Amount must be between 0 and 1000' });
      const now = Date.now();
      const c = {
        id: 'c_admin_' + now.toString(36) + Math.floor(Math.random() * 1e4).toString(36),
        src: 'admin', srcId: 'admin', title, amount,
        at: now, exp: now + days * 86400000, status: 'new',
      };
      const list = parseJSON(await upstash(['GET', `coupons:${id}`]));
      const next = [c].concat(Array.isArray(list) ? list : []).slice(0, 60);
      await upstash(['SET', `coupons:${id}`, JSON.stringify(next)]);
      await upstash(['LPUSH', `cmd:${id}`, JSON.stringify({ type: 'message', kind: 'bonus',
        title: 'Coupon received \u{1F39F}',
        text: `${title} \u00b7 ${amount} USDT. Open the Coupon Center to activate it \u2014 it expires in ${days} day${days > 1 ? 's' : ''}.` })]);
      await upstash(['LTRIM', `cmd:${id}`, 0, 99]);
      await tgSend(id, `\u{1F39F} <b>You received a coupon</b>\n\n<b>${amount} USDT</b> \u00b7 ${escHtml(title)}\nActivate it in the Coupon Center within ${days} day${days > 1 ? 's' : ''}.`);
      return res.status(200).json({ ok: true, coupon: c, coupons: next });
    }
    if (body.action === 'deleteCoupon') {
      const id = String(body.id || '');
      const couponId = String(body.couponId || '');
      if (!id || !couponId) return res.status(400).json({ error: 'id and couponId required' });
      const list = parseJSON(await upstash(['GET', `coupons:${id}`]));
      const arr = Array.isArray(list) ? list : [];
      const gone = arr.find((c) => c && c.id === couponId) || null;
      // An activated coupon has already paid into the bonus balance. Removing it
      // here would not claw that back, so refuse rather than leave the two
      // disagreeing — deduct the bonus by hand instead.
      if (gone && gone.status === 'active') {
        return res.status(400).json({ error: 'That coupon is already activated. Adjust the bonus balance instead.' });
      }
      const next = arr.filter((c) => c && c.id !== couponId);
      await upstash(['SET', `coupons:${id}`, JSON.stringify(next)]);
      await upstash(['SREM', `coupon:used:${id}`, couponId]);
      return res.status(200).json({ ok: true, removed: !!gone, coupons: next });
    }

    // ── Banner management (config:banners) ──
    if (body.action === 'getBanners') {
      const raw = await upstash(['GET', 'config:banners']);
      const parsed = parseJSON(raw);
      return res.status(200).json({ banners: Array.isArray(parsed) ? cleanBanners(parsed) : DEFAULT_BANNERS });
    }
    if (body.action === 'saveBanners') {
      if (!Array.isArray(body.banners)) return res.status(400).json({ error: 'banners array required' });
      const clean = cleanBanners(body.banners);
      await upstash(['SET', 'config:banners', JSON.stringify(clean)]);
      return res.status(200).json({ ok: true, banners: clean });
    }
    if (body.action === 'resetBannersConfig') {
      await upstash(['DEL', 'config:banners']);
      return res.status(200).json({ ok: true, banners: DEFAULT_BANNERS });
    }

    // ── Task management (config:tasks) ──
    const DEFAULT_TASKS = [
      { id: 'welcome', icon: 'ti-gift', title: 'Welcome Bonus', desc: 'Sign in to KolonoEX', reward: 10, metric: 'always', target: 0, go: 'home' },
      { id: 'deposit', icon: 'ti-wallet', title: 'Net Deposit', desc: 'Deposit a total of 100 USDT', reward: 10, metric: 'deposit', target: 100, go: 'assets' },
      { id: 'depositmatch', icon: 'ti-gift', title: '100% Deposit Match', desc: 'Deposit 10–100 USDT and get the exact same amount back as a bonus coupon', reward: 100, metric: 'depositMatch', target: 10, go: 'assets', featured: true },
      { id: 'spot', icon: 'ti-arrows-exchange', title: 'First Spot Trade', desc: 'Trade 100 USDT volume in Spot', reward: 5, metric: 'spotVol', target: 100, go: 'trade' },
      { id: 'futures', icon: 'ti-trending-up', title: 'First Futures Trade', desc: 'Trade 20,000 USDT volume in Futures', reward: 15, metric: 'futVol', target: 20000, go: 'futures' },
      { id: 'tgchannel', icon: 'ti-brand-telegram', title: 'Join our Telegram', desc: 'Join the @KolonoEX channel', reward: 0.5, metric: 'tgChannel', target: 0, go: 'social', link: 'https://t.me/KolonoEX' },
      { id: 'xfollow', icon: 'ti-brand-x', title: 'Follow us on X', desc: 'Follow @KolonoEX on X', reward: 0.5, metric: 'xFollow', target: 0, go: 'social', link: 'https://x.com/KolonoEX' },
      { id: 'starsbonus', icon: 'ti-star', title: 'Buy 15 USDT Bonus with Stars', desc: 'Pay ~$10 in Telegram Stars and get a 15 USDT bonus coupon', reward: 15, metric: 'stars', target: 500, go: 'stars', featured: true },
    ];
    if (body.action === 'getTasks') {
      const raw = await upstash(['GET', 'config:tasks']);
      const tasks = parseJSON(raw);
      // Re-inject only the always-present promo task (deposit-match) when it is
      // missing from the saved config, so it shows up and stays editable here
      // even behind an older saved list. Every OTHER task the admin deleted must
      // stay deleted — so we do NOT re-add the rest of DEFAULT_TASKS. This
      // mirrors ALWAYS_PRESENT_IDS in api/sync.js.
      const ALWAYS_PRESENT_IDS = ['depositmatch', 'starsbonus'];
      let out;
      if (Array.isArray(tasks) && tasks.length) {
        out = tasks.slice();
        const have = new Set(out.map((t) => t && String(t.id)));
        DEFAULT_TASKS.forEach((def, i) => {
          if (ALWAYS_PRESENT_IDS.includes(String(def.id)) && !have.has(String(def.id))) {
            out.splice(Math.min(i, out.length), 0, def);
          }
        });
      } else {
        out = DEFAULT_TASKS;
      }
      return res.status(200).json({ tasks: out });
    }
    if (body.action === 'saveTasks') {
      const tasks = Array.isArray(body.tasks) ? body.tasks : null;
      if (!tasks) return res.status(400).json({ error: 'tasks array required' });
      const ALLOWED_METRICS = ['always', 'deposit', 'depositMatch', 'spotVol', 'futVol', 'referral', 'tgChannel', 'xFollow', 'stars'];
      // Only allow safe http(s)/tg links for the social "Go" button.
      const cleanLink = (s) => { const v = String(s || '').trim().slice(0, 200); return /^(https?:\/\/|tg:\/\/)/i.test(v) ? v : ''; };
      const clean = tasks.slice(0, 12).map((t, i) => ({
        id: String(t.id || ('task' + i)).slice(0, 24).replace(/[^a-zA-Z0-9_]/g, ''),
        icon: String(t.icon || 'ti-gift').slice(0, 40),
        title: String(t.title || 'Task').slice(0, 60),
        desc: String(t.desc || '').slice(0, 120),
        reward: Math.max(0, Math.round((parseFloat(t.reward) || 0) * 100) / 100),
        metric: ALLOWED_METRICS.includes(t.metric) ? t.metric : 'always',
        target: Math.max(0, parseFloat(t.target) || 0),
        go: ['home', 'assets', 'trade', 'futures', 'invite', 'social', 'stars'].includes(t.go) ? t.go : 'home',
        link: cleanLink(t.link),
        // Preserve the "featured" flag so a highlighted promo task keeps its
        // special styling in the app after an admin saves the task list.
        featured: !!t.featured,
      })).filter((t) => t.id);
      await upstash(['SET', 'config:tasks', JSON.stringify(clean)]);
      return res.status(200).json({ ok: true, tasks: clean });
    }
    if (body.action === 'resetTasksConfig') {
      await upstash(['DEL', 'config:tasks']);
      return res.status(200).json({ ok: true, tasks: DEFAULT_TASKS });
    }

    // Reset a user. mode 'tasks' clears only task/check-in progress (a client
    // command). mode 'full' wipes the server balance, deposit total and ledger
    // too, then tells the client to reset its local app to a fresh state.
    if (body.action === 'reset') {
      const id = String(body.id || '');
      const mode = body.mode === 'full' ? 'full' : 'tasks';
      if (!id) return res.status(400).json({ error: 'id required' });
      if (mode === 'full') {
        // Wipe server-side balances/state so the client reconciles to zero.
        // Reward state is server-owned now, so it must be cleared here too or
        // the client would immediately re-adopt the old claims on next sync.
        await upstash(['DEL', `bal:${id}`, `dep:total:${id}`, `dep:real:${id}`, `ledger:${id}`, `seen:${id}`,
          `task:claimed:${id}`, `checkin:${id}`, `bonus:${id}`, `vol:spot:${id}`, `vol:fut:${id}`,
          // reward state introduced with the Coupon Center
          `coupons:${id}`, `coupon:used:${id}`, `pot:${id}`, `rpot:${id}`, `dep:tiers:${id}`,
          // withdrawal allowance earned as partner commission — it tracks bal:,
          // so a full wipe that zeroes the balance must zero this too
          `payout:earned:${id}`]);
        await upstash(['LPUSH', `cmd:${id}`, JSON.stringify({ type: 'resetAccount' })]);
      } else {
        // Task/check-in progress lives server-side; clear it alongside the
        // client-side command so the reset actually takes effect.
        //
        // `bonus:` is deliberately NOT cleared. It is a balance, not progress:
        // it holds coupons the user already activated plus anything an admin
        // granted by hand, and the panel promises "Balances and positions are
        // kept". Wiping it here destroyed money the user had legitimately
        // banked. Only the earning slate is reset — including unactivated
        // coupons and the collecting pot, so nothing can be claimed twice.
        await upstash(['DEL', `task:claimed:${id}`, `checkin:${id}`,
          `vol:spot:${id}`, `vol:fut:${id}`, `task:tgchannel:${id}`,
          `coupons:${id}`, `coupon:used:${id}`, `pot:${id}`, `rpot:${id}`, `dep:tiers:${id}`]);
        await upstash(['LPUSH', `cmd:${id}`, JSON.stringify({ type: 'resetTasks' })]);
      }
      await upstash(['LTRIM', `cmd:${id}`, 0, 99]);
      await tgSend(id, mode === 'full'
        ? '♻️ <b>Account reset</b>\n\nYour KolonoEX account has been reset by an admin. Open the app for a fresh start.'
        : '♻️ <b>Tasks reset</b>\n\nYour tasks and daily check-in have been reset by an admin.');
      return res.status(200).json({ ok: true, mode });
    }

    // Reset EVERY user at once. Same semantics as the single-user reset above,
    // applied to the whole `users` set. `mode: 'full'` wipes balances/state and
    // sends a resetAccount command; anything else clears only task/check-in
    // progress (a resetTasks command). Telegram push notifications are
    // deliberately skipped here — sending one per user would be slow and could
    // trip Telegram's rate limits on a large user base; the in-app command
    // resets them on next open. Returns how many users were affected.
    if (body.action === 'resetAll') {
      const mode = body.mode === 'full' ? 'full' : 'tasks';
      const ids = ((await upstash(['SMEMBERS', 'users'])) || []).filter(Boolean);

      // ── Why the old reset "said done" but left balances behind ──────────────
      // Every user's wallet lives in TWO places, not one:
      //   1. server keys  → bal:, bonus:, dep:*, vol:*, coupons:, pot:, …
      //   2. profile:<id>  → a JSON snapshot the app RE-UPLOADS on every sync,
      //      holding usdt / futUSDT / bonus / realBalance / equity / holdings /
      //      positions / openOrders / txs.
      // The previous reset only DEL'd the server keys and never touched
      // profile:, so the moment the user reopened the app, sync.js merged the
      // stale profile snapshot straight back — balance and bonus "returned".
      // Deleting profile: outright is wrong too: it holds identity (name,
      // username, joinedAt) we must keep. So we DEL the money/task keys AND
      // rewrite profile: in place, zeroing only the financial fields.
      //
      // Two things are deliberately PRESERVED so a reset can't be undone or
      // wipe things you asked to keep:
      //   • referrals — ref:by:, ref:partner:, ref:count:, ref:list:,
      //     ref:earned:, partner:* are never touched here.
      //   • rw:migrated: — the one-time "adopt localStorage bonus" marker. If it
      //     were cleared, the next sync would re-import the user's old client
      //     bonus and refund it. Leaving it set keeps the zero permanent.
      //
      // Performance: instead of ~3 serial requests PER user (22k users → 66k
      // round trips → function timeout), each user's commands are batched into
      // /pipeline requests fired in parallel waves — seconds, not minutes.

      // Financial fields to zero/empty inside the profile snapshot. Anything not
      // listed here (userId, username, name, joinedAt, flags, …) is preserved.
      const zeroProfileMoney = (prof) => {
        const p = (prof && typeof prof === 'object') ? prof : {};
        return {
          ...p,
          usdt: 0, futUSDT: 0, bonus: 0, realBalance: 0, equity: 0,
          holdings: [], positions: [], openOrders: [], txs: [], closedCount: 0,
        };
      };

      // The server keys wiped on a FULL reset. Note the keys NOT here:
      // ref:* / partner:* (referrals), rw:migrated: (migration guard),
      // banned: and wd:* (moderation + withdrawal history) — all kept.
      const fullDelKeys = (id) => [
        `bal:${id}`, `bonus:${id}`, `dep:total:${id}`, `dep:real:${id}`,
        `ledger:${id}`, `seen:${id}`, `payout:earned:${id}`,
        `task:claimed:${id}`, `checkin:${id}`, `task:tgchannel:${id}`,
        `vol:spot:${id}`, `vol:fut:${id}`,
        `coupons:${id}`, `coupon:used:${id}`, `pot:${id}`, `rpot:${id}`, `dep:tiers:${id}`,
      ];
      // A tasks-only reset clears progress but keeps money keys (bal:, bonus:,
      // dep:*) and, crucially, does NOT touch the profile snapshot at all.
      const tasksDelKeys = (id) => [
        `task:claimed:${id}`, `checkin:${id}`, `task:tgchannel:${id}`,
        `vol:spot:${id}`, `vol:fut:${id}`,
        `coupons:${id}`, `coupon:used:${id}`, `pot:${id}`, `rpot:${id}`, `dep:tiers:${id}`,
      ];

      const cmdResetType = mode === 'full' ? 'resetAccount' : 'resetTasks';

      // Tunables. USERS_PER_BATCH keeps each pipeline payload well under
      // Upstash's 10 MB request limit; WAVE caps how many pipeline requests are
      // in flight at once. Full mode also reads profiles (one MGET per batch),
      // so we use a smaller batch there to keep each request comfortably small.
      const USERS_PER_BATCH = mode === 'full' ? 300 : 500;
      const WAVE = 8;

      // Process one batch of user ids: (full) read their profiles, then pipeline
      // the DEL + rewritten profile + reset command + trim; (tasks) just the
      // DEL + command + trim. Returns the number of users handled.
      async function processBatch(slice) {
        let profiles = [];
        if (mode === 'full') {
          profiles = (await upstash(['MGET', ...slice.map((id) => `profile:${id}`)])) || [];
        }
        const commands = [];
        slice.forEach((id, i) => {
          if (mode === 'full') {
            commands.push(['DEL', ...fullDelKeys(id)]);
            // Only rewrite a profile that already exists — no need to
            // materialise an empty snapshot for a user who never had one.
            const existing = parseJSON(profiles[i]);
            if (existing) {
              commands.push(['SET', `profile:${id}`, JSON.stringify(zeroProfileMoney(existing))]);
            }
          } else {
            commands.push(['DEL', ...tasksDelKeys(id)]);
          }
          commands.push(['LPUSH', `cmd:${id}`, JSON.stringify({ type: cmdResetType })]);
          commands.push(['LTRIM', `cmd:${id}`, 0, 99]);
        });
        await upstashPipeline(commands);
        return slice.length;
      }

      const slices = [];
      for (let i = 0; i < ids.length; i += USERS_PER_BATCH) slices.push(ids.slice(i, i + USERS_PER_BATCH));

      let count = 0;
      let failedBatches = 0;
      for (let i = 0; i < slices.length; i += WAVE) {
        const wave = slices.slice(i, i + WAVE);
        const results = await Promise.allSettled(wave.map((s) => processBatch(s)));
        results.forEach((r) => {
          if (r.status === 'fulfilled') count += r.value;
          else failedBatches += 1; // one failed batch never aborts the whole run
        });
      }

      return res.status(200).json({
        ok: failedBatches === 0, mode, count, total: ids.length,
        batches: slices.length, failedBatches,
      });
    }

    // ── Broadcast an announcement to many users at once ──────────────────────
    // Sends an in-app notification (drained by sync.js on next open) and/or a
    // Telegram bot push, optionally with an image, to an audience selected by
    // activity/join time. Two phases:
    //   • preview:true  → resolve the audience and just return the count, so the
    //     admin sees "will reach N users" before committing. Nothing is sent.
    //   • send          → deliver for real.
    //
    // Audience filters (all optional, ANDed together), evaluated against each
    // user's profile snapshot:
    //   • activeSince : keep users whose lastSeen >= this epoch ms ("entered the
    //                   app since <date/time>", exactly what was asked for)
    //   • joinedSince : keep users whose joinedAt >= this epoch ms (new signups)
    //   • activeBefore: keep users whose lastSeen <  this epoch ms (dormant)
    // With no filter, the audience is everyone in the `users` set.
    //
    // Performance mirrors resetAll: profiles are read with batched MGET and the
    // in-app notifications are written with batched /pipeline LPUSH+LTRIM. The
    // image is uploaded to Telegram ONCE; every recipient then gets that file_id
    // (no re-upload). Telegram pushes are throttled in small parallel waves to
    // respect rate limits — the in-app notification is the guaranteed channel,
    // the bot push is best-effort on top.
    if (body.action === 'broadcast') {
      const title = String(body.title || '').slice(0, 120).trim();
      const text = String(body.text || '').slice(0, 3500).trim();
      const preview = body.preview === true;
      const sendInApp = body.inApp !== false;              // default on
      const sendTelegram = body.telegram === true;         // default off (opt-in)
      const hasImage = !!body.image;

      if (!preview && !title && !text && !hasImage) {
        return res.status(400).json({ error: 'Provide a title, text, or image' });
      }
      if (!preview && !sendInApp && !sendTelegram) {
        return res.status(400).json({ error: 'Pick at least one channel (in-app or Telegram)' });
      }

      // Parse the optional image up front so a bad one fails before we fan out.
      let img = null;
      if (hasImage) {
        img = parseDataUrl(body.image);
        if (!img) return res.status(400).json({ error: 'Invalid or oversized image (max 5 MB, jpg/png/webp)' });
      }

      // Filters. Values are epoch ms; 0/undefined means "no bound".
      const activeSince = Number(body.activeSince) > 0 ? Number(body.activeSince) : 0;
      const joinedSince = Number(body.joinedSince) > 0 ? Number(body.joinedSince) : 0;
      const activeBefore = Number(body.activeBefore) > 0 ? Number(body.activeBefore) : 0;
      const includeBanned = body.includeBanned === true; // default: skip banned

      const allIds = ((await upstash(['SMEMBERS', 'users'])) || []).filter(Boolean);

      // Resolve the audience by reading profiles in batches (and ban flags, when
      // we're excluding banned users). Keep only the ids that pass every filter.
      const RESOLVE_BATCH = 500;
      const audience = [];
      for (let i = 0; i < allIds.length; i += RESOLVE_BATCH) {
        const slice = allIds.slice(i, i + RESOLVE_BATCH);
        const needFilter = activeSince || joinedSince || activeBefore;
        const [profiles, bans] = await Promise.all([
          (needFilter) ? upstash(['MGET', ...slice.map((id) => `profile:${id}`)]) : Promise.resolve(null),
          (!includeBanned) ? upstash(['MGET', ...slice.map((id) => `banned:${id}`)]) : Promise.resolve(null),
        ]);
        slice.forEach((id, j) => {
          if (bans && bans[j]) return; // skip banned
          if (needFilter) {
            const p = parseJSON(profiles[j]) || {};
            const lastSeen = Number(p.lastSeen) || 0;
            const joinedAt = Number(p.joinedAt) || 0;
            if (activeSince && !(lastSeen >= activeSince)) return;
            if (activeBefore && !(lastSeen && lastSeen < activeBefore)) return;
            if (joinedSince && !(joinedAt >= joinedSince)) return;
          }
          audience.push(id);
        });
      }

      // Preview: report the audience size (and total) without sending anything.
      if (preview) {
        return res.status(200).json({ ok: true, preview: true, audience: audience.length, total: allIds.length });
      }

      // ── Deliver ──
      // If there's an image, upload it to Telegram ONCE up front to obtain a
      // file_id. That same file_id is re-sent to every Telegram recipient, and
      // its signed proxy URL (via /api/support?action=img) is embedded in the
      // in-app notification — so the raw base64 is never stored per user.
      let fileId = null;
      if (img) {
        const firstAdmin = [...adminIds()][0];
        fileId = await tgUploadPhoto(firstAdmin, img.buf, img.mime, null);
      }
      const inAppImg = fileId ? imgUrl(fileId) : undefined;

      // 1) In-app notification via batched pipeline (guaranteed channel).
      let inAppCount = 0;
      const notif = JSON.stringify({
        type: 'message', kind: 'announcement',
        title: title || 'Announcement', text, img: inAppImg, at: Date.now(),
      });
      if (sendInApp) {
        const NOTIF_BATCH = 500, WAVE = 8;
        const slices = [];
        for (let i = 0; i < audience.length; i += NOTIF_BATCH) slices.push(audience.slice(i, i + NOTIF_BATCH));
        for (let i = 0; i < slices.length; i += WAVE) {
          const wave = slices.slice(i, i + WAVE);
          const results = await Promise.allSettled(wave.map((s) => {
            const commands = [];
            for (const id of s) {
              commands.push(['LPUSH', `cmd:${id}`, notif]);
              commands.push(['LTRIM', `cmd:${id}`, 0, 99]);
            }
            return upstashPipeline(commands);
          }));
          results.forEach((r, k) => { if (r.status === 'fulfilled') inAppCount += wave[i + k - i] ? wave[k].length : 0; });
        }
      }

      // 2) Telegram push (best-effort). Re-sends the file_id minted above (if
      // any) to everyone; text-only broadcasts send plain text. Small parallel
      // waves keep us under Telegram's rate limit.
      let telegramCount = 0;
      if (sendTelegram) {
        const caption = [title ? `<b>${escHtml(title)}</b>` : '', escHtml(text)].filter(Boolean).join('\n\n');
        const TG_WAVE = 25; // small waves stay under Telegram's ~30 msg/s ceiling
        for (let i = 0; i < audience.length; i += TG_WAVE) {
          const wave = audience.slice(i, i + TG_WAVE);
          const results = await Promise.allSettled(wave.map((id) => (
            fileId ? tgSendPhotoId(id, fileId, caption || undefined)
                   : tgSendPlain(id, caption || title || text)
          )));
          telegramCount += results.filter((r) => r.status === 'fulfilled').length;
          // A short breather between waves to be gentle on the rate limit.
          if (i + TG_WAVE < audience.length) await new Promise((r) => setTimeout(r, 1000));
        }
      }

      return res.status(200).json({
        ok: true, audience: audience.length, total: allIds.length,
        inAppSent: sendInApp ? inAppCount : 0,
        telegramSent: sendTelegram ? telegramCount : 0,
        hadImage: !!img,
      });
    }

    // Adjust the user's bonus balance (with an optional note). Delivered to the
    // app via a command and pushed to the user's bot chat.
    if (body.action === 'bonus') {
      const id = String(body.id || '');
      const amount = Math.round((parseFloat(body.amount) || 0) * 100) / 100;
      const note = String(body.note || '').trim();
      if (!id || !amount) return res.status(400).json({ error: 'id and non-zero amount required' });
      // The bonus balance is server-owned, so apply it here — a client-only
      // command would be reverted by the next sync reconciliation. Clamped at 0.
      const nb = parseFloat(await upstash(['INCRBYFLOAT', `bonus:${id}`, amount]));
      await upstash(['SET', `bonus:${id}`, String(nb >= 0 ? Math.round(nb * 100) / 100 : 0)]);
      await upstash(['LPUSH', `cmd:${id}`, JSON.stringify({ type: 'adjustBonus', amount, note, title: amount > 0 ? 'Bonus added 🎁' : 'Bonus updated' })]);
      await upstash(['LTRIM', `cmd:${id}`, 0, 99]);
      const sign = amount > 0 ? '+' : '−';
      await tgSend(id, `🎁 <b>Bonus ${sign}$${Math.abs(amount)}</b> has been ${amount > 0 ? 'added to' : 'deducted from'} your account.${note ? `\n\n📝 ${escHtml(note)}` : ''}`);
      return res.status(200).json({ ok: true });
    }

    // Queue a trade command for the user's app to apply on next sync.
    if (body.action === 'command') {
      const id = String(body.id || '');
      const cmd = body.command;
      const valid = cmd && ['closePosition', 'cancelOrder', 'editPosition', 'message'].includes(cmd.type);
      if (!id || !valid) return res.status(400).json({ error: 'id and a valid command required' });
      await upstash(['LPUSH', `cmd:${id}`, JSON.stringify(cmd)]);
      await upstash(['LTRIM', `cmd:${id}`, 0, 99]);
      // Mirror admin messages into the user's bot chat too.
      if (cmd.type === 'message' && cmd.text) await tgSend(id, `📩 <b>Message from KolonoEX</b>\n\n${escHtml(cmd.text)}`);
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'decide') {
      const id = String(body.id || '');
      const decision = String(body.decision || ''); // approve | reject | paid
      if (!id || !['approve', 'reject', 'paid'].includes(decision)) {
        return res.status(400).json({ error: 'id and a valid decision are required' });
      }
      const rec = parseJSON(await upstash(['GET', `wd:item:${id}`]));
      if (!rec) return res.status(404).json({ error: 'Withdrawal not found' });

      if (decision === 'reject') {
        if (rec.status === 'pending' || rec.status === 'approved') {
          await upstash(['INCRBYFLOAT', `bal:${rec.userId}`, rec.amount]); // refund held funds
        }
        rec.status = 'rejected';
      } else if (decision === 'approve') {
        rec.status = 'approved';
      } else if (decision === 'paid') {
        rec.status = 'paid';
      }
      rec.decidedAt = Date.now();
      await upstash(['SET', `wd:item:${id}`, JSON.stringify(rec)]);
      // Keep approved items in the queue (still need paying); drop on paid/reject.
      if (decision !== 'approve') await upstash(['LREM', 'wd:pending', 0, id]);

      // Notify the user: in-app (next sync) + bot push.
      const amtLabel = (rec.coin && rec.coin !== 'USDT' && rec.coinAmount) ? (rec.coinAmount + ' ' + rec.coin) : (rec.amount + ' USDT');
      if (decision === 'reject') {
        // Refund the SAME coin back to the wallet (and absorb the server USD refund).
        await upstash(['LPUSH', `cmd:${rec.userId}`, JSON.stringify({
          type: 'refundWithdraw', coin: rec.coin || 'USDT', coinAmount: rec.coinAmount || null, usd: rec.amount,
          title: 'Withdrawal rejected', text: amtLabel + ' was rejected and returned to your wallet.',
        })]);
        await tgSend(rec.userId, `❌ <b>Withdrawal rejected</b>\n\n<b>${escHtml(amtLabel)}</b> was rejected and returned to your wallet.`);
      } else {
        const msg = decision === 'paid'
          ? { title: 'Withdrawal completed ✅', text: amtLabel + ' has been sent to your ' + rec.network + ' address.', bot: `✅ <b>Withdrawal completed</b>\n\n<b>${escHtml(amtLabel)}</b> has been sent to your ${escHtml(rec.network)} address.` }
          : { title: 'Withdrawal approved', text: amtLabel + ' approved — being sent shortly.', bot: `🔄 <b>Withdrawal approved</b>\n\n<b>${escHtml(amtLabel)}</b> is approved and being processed.` };
        await upstash(['LPUSH', `cmd:${rec.userId}`, JSON.stringify({ type: 'message', kind: 'withdraw', title: msg.title, text: msg.text })]);
        await tgSend(rec.userId, msg.bot);
      }
      await upstash(['LTRIM', `cmd:${rec.userId}`, 0, 99]);

      return res.status(200).json({ ok: true, withdrawal: rec });
    }

    // ── Maintenance Mode Management ──
    if (body.action === 'getMaintenanceStatus') {
      const raw = await upstash(['GET', 'config:maintenance']);
      const state = parseJSON(raw) || { enabled: false, endTime: null };
      return res.status(200).json(state);
    }

    if (body.action === 'setMaintenance') {
      const enabled = body.enabled === true;
      const endTime = body.endTime && typeof body.endTime === 'string' ? body.endTime : null;
      
      // Validate endTime format if provided
      if (endTime) {
        const date = new Date(endTime);
        if (isNaN(date.getTime())) {
          return res.status(400).json({ error: 'Invalid endTime format' });
        }
      }
      
      const state = { enabled, endTime };
      await upstash(['SET', 'config:maintenance', JSON.stringify(state)]);
      return res.status(200).json({ ok: true, ...state });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};
