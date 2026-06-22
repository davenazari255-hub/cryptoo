// Unified client sync: receives a state snapshot from the app, enforces bans,
// returns the server (real) balance and any pending admin commands. TG-authed.
// Self-contained for reliable Vercel bundling.
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
  try {
    const u = JSON.parse(params.get('user') || 'null');
    if (!u || !u.id) return null;
    u.startParam = params.get('start_param') || null; // deep-link payload (referral)
    return u;
  } catch { return null; }
}

const parseJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const REFERRAL_BONUS = 0.5; // USD credited to the referrer per valid invite

// Send a push message into the bot chat (outside the mini app). Best-effort.
async function tgSend(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (e) { /* ignore */ }
}

// Records a referral the first time a referred user appears. Idempotent and
// abuse-resistant: a user can be referred only once, can't refer themselves.
async function recordReferral(upstashFn, userId, startParam, newUserName) {
  if (!startParam || typeof startParam !== 'string') return;
  const m = startParam.match(/^ref_(tg_\d+|\d+)$/);
  if (!m) return;
  let referrer = m[1];
  if (!referrer.startsWith('tg_')) referrer = `tg_${referrer}`;
  if (referrer === userId) return; // no self-referral

  // Only set if this user has no referrer yet (NX = first writer wins).
  const set = await upstashFn(['SET', `ref:by:${userId}`, referrer, 'NX']);
  if (set !== 'OK') return; // already referred before

  // Credit the referrer and track the relationship.
  await upstashFn(['SADD', `ref:list:${referrer}`, userId]);
  await upstashFn(['INCR', `ref:count:${referrer}`]);
  await upstashFn(['INCRBYFLOAT', `bal:${referrer}`, REFERRAL_BONUS]);
  await upstashFn(['LPUSH', `ledger:${referrer}`, JSON.stringify({ usd: REFERRAL_BONUS, coin: 'REFERRAL', note: 'Referral bonus', at: Date.now() })]);
  await upstashFn(['LTRIM', `ledger:${referrer}`, 0, 99]);

  // Notify the referrer: in-bot push + in-app notification (delivered on next sync).
  const who = escHtml(newUserName || 'A new user');
  const text = `🎉 <b>${who}</b> just joined KolonoEX using your invite link!\n\n💰 You earned <b>$${REFERRAL_BONUS}</b> referral bonus — it has been added to your balance.`;
  await tgSend(referrer.slice(3), text);
  await upstashFn(['LPUSH', `cmd:${referrer}`, JSON.stringify({ type: 'message', kind: 'referral', title: 'New referral 🎉', text: `${newUserName || 'A friend'} joined with your link. You earned $${REFERRAL_BONUS} bonus!` })]);
  await upstashFn(['LTRIM', `cmd:${referrer}`, 0, 99]);
}

// Keep the stored snapshot bounded so Redis values stay small.
function sanitizeProfile(p) {
  if (!p || typeof p !== 'object') return {};
  const num = (x) => (isFinite(parseFloat(x)) ? parseFloat(x) : 0);
  return {
    usdt: num(p.usdt), futUSDT: num(p.futUSDT), bonus: num(p.bonus),
    realBalance: num(p.realBalance), equity: num(p.equity),
    holdings: Array.isArray(p.holdings) ? p.holdings.slice(0, 40) : [],
    positions: Array.isArray(p.positions) ? p.positions.slice(0, 60) : [],
    openOrders: Array.isArray(p.openOrders) ? p.openOrders.slice(0, 60) : [],
    txs: Array.isArray(p.txs) ? p.txs.slice(0, 20) : [],
    closedCount: num(p.closedCount), flags: p.flags && typeof p.flags === 'object' ? p.flags : {},
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const user = verifyTelegram(body.initData);
  if (!user) return res.status(401).json({ error: 'Telegram authentication failed' });
  const userId = `tg_${user.id}`;

  try {
    const banned = await upstash(['GET', `banned:${userId}`]);
    if (banned) return res.status(200).json({ banned: true });

    // Merge & store the profile snapshot (preserve original join date).
    const prev = parseJSON(await upstash(['GET', `profile:${userId}`])) || {};
    const snap = sanitizeProfile(body.profile);
    const profile = {
      userId,
      username: user.username || prev.username || null,
      name: user.first_name || prev.name || null,
      joinedAt: prev.joinedAt || Date.now(),
      lastSeen: Date.now(),
      ...snap,
    };
    const isNew = !prev.joinedAt;
    await upstash(['SET', `profile:${userId}`, JSON.stringify(profile)]);
    await upstash(['SADD', 'users', userId]);

    // Process a referral deep-link (only meaningful for brand-new users).
    if (isNew && user.startParam) {
      try { await recordReferral(upstash, userId, user.startParam, user.first_name || user.username); } catch (e) {}
    }

    const balance = parseFloat(await upstash(['GET', `bal:${userId}`])) || 0;
    // Cumulative lifetime deposits (gates the first withdrawal client-side & server-side).
    const depositTotal = parseFloat(await upstash(['GET', `dep:total:${userId}`])) || 0;

    // Referral stats for this user.
    const referralCount = parseInt(await upstash(['GET', `ref:count:${userId}`]), 10) || 0;
    const referral = { count: referralCount, earned: Math.round(referralCount * REFERRAL_BONUS * 100) / 100, bonus: REFERRAL_BONUS };

    // Drain pending admin commands for this user (apply-once).
    const cmds = (await upstash(['LRANGE', `cmd:${userId}`, 0, -1])) || [];
    if (cmds.length) await upstash(['DEL', `cmd:${userId}`]);
    const commands = cmds.map(parseJSON).filter(Boolean);

    return res.status(200).json({ banned: false, balance, commands, referral, depositTotal });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};
