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

const REFERRAL_BONUS = 0.5; // default USD credited to the referrer per valid invite

// Default home tasks. Admin can edit/extend these via the admin panel (stored in
// Redis at config:tasks). `metric` drives client-side progress: always | deposit
// | spotVol | futVol | referral. `target` is the numeric goal (0 = instant).
const DEFAULT_TASKS = [
  { id: 'welcome', icon: 'ti-gift', title: 'Welcome Bonus', desc: 'Sign in to KolonoEX', reward: 10, metric: 'always', target: 0, go: 'home' },
  { id: 'deposit', icon: 'ti-wallet', title: 'Net Deposit', desc: 'Deposit a total of 100 USDT', reward: 10, metric: 'deposit', target: 100, go: 'assets' },
  { id: 'spot', icon: 'ti-arrows-exchange', title: 'First Spot Trade', desc: 'Trade 100 USDT volume in Spot', reward: 5, metric: 'spotVol', target: 100, go: 'trade' },
  { id: 'futures', icon: 'ti-trending-up', title: 'First Futures Trade', desc: 'Trade 20,000 USDT volume in Futures', reward: 15, metric: 'futVol', target: 20000, go: 'futures' },
];
async function loadTasks(upstashFn) {
  const raw = await upstashFn(['GET', 'config:tasks']);
  const parsed = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;
  return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_TASKS;
}

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
// Supports two link types: ref_<id> (normal user) and par_<code> (partner).
async function recordReferral(upstashFn, userId, startParam, newUserName) {
  if (!startParam || typeof startParam !== 'string') return;
  let referrer = null, partnerCode = null;
  const mUser = startParam.match(/^ref_(tg_\d+|\d+)$/);
  const mPartner = startParam.match(/^par_([a-zA-Z0-9_]{3,32})$/);
  if (mPartner) {
    partnerCode = mPartner[1];
    const ownerRaw = await upstashFn(['GET', `partner:owner:${partnerCode}`]);
    if (!ownerRaw) return; // unknown/inactive partner code
    referrer = String(ownerRaw);
  } else if (mUser) {
    referrer = mUser[1];
    if (!referrer.startsWith('tg_')) referrer = `tg_${referrer}`;
  } else return;
  if (referrer === userId) return; // no self-referral

  // Only set if this user has no referrer yet (NX = first writer wins).
  const set = await upstashFn(['SET', `ref:by:${userId}`, referrer, 'NX']);
  if (set !== 'OK') return; // already referred before

  // Per-partner referral bonus override (falls back to the global default).
  let bonus = REFERRAL_BONUS;
  if (partnerCode) {
    await upstashFn(['SET', `ref:partner:${userId}`, partnerCode]); // tag user → partner
    await upstashFn(['INCR', `partner:refcount:${partnerCode}`]);
    const cfg = parseJSON(await upstashFn(['GET', `partner:cfg:${partnerCode}`])) || {};
    if (cfg.refBonus != null && isFinite(parseFloat(cfg.refBonus))) bonus = parseFloat(cfg.refBonus);
  }

  // Credit the referrer and track the relationship.
  await upstashFn(['SADD', `ref:list:${referrer}`, userId]);
  await upstashFn(['INCR', `ref:count:${referrer}`]);
  if (bonus > 0) {
    await upstashFn(['INCRBYFLOAT', `bal:${referrer}`, bonus]);
    await upstashFn(['LPUSH', `ledger:${referrer}`, JSON.stringify({ usd: bonus, coin: 'REFERRAL', note: 'Referral bonus', at: Date.now() })]);
    await upstashFn(['LTRIM', `ledger:${referrer}`, 0, 99]);
  }

  // Notify the referrer: in-bot push + in-app notification (delivered on next sync).
  const who = escHtml(newUserName || 'A new user');
  const text = `🎉 <b>${who}</b> just joined KolonoEX using your invite link!\n\n💰 You earned <b>$${bonus}</b> referral bonus — it has been added to your balance.`;
  await tgSend(referrer.slice(3), text);
  await upstashFn(['LPUSH', `cmd:${referrer}`, JSON.stringify({ type: 'message', kind: 'referral', title: 'New referral 🎉', text: `${newUserName || 'A friend'} joined with your link. You earned $${bonus} bonus!` })]);
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

    // Effective task list. If this user was referred by a partner, apply that
    // partner's per-task reward overrides so the partner can offer richer bonuses.
    let tasks = await loadTasks(upstash);
    const myPartner = await upstash(['GET', `ref:partner:${userId}`]);
    if (myPartner) {
      const pcfg = parseJSON(await upstash(['GET', `partner:cfg:${myPartner}`])) || {};
      const overrides = pcfg.taskRewards || {};
      tasks = tasks.map((t) => (overrides[t.id] != null ? { ...t, reward: parseFloat(overrides[t.id]) || 0, partnerBoost: true } : t));
    }

    // This user's own partner status (if they applied / were approved).
    const partnerRaw = await upstash(['GET', `partner:me:${userId}`]);
    const partner = parseJSON(partnerRaw) || null;

    // Drain pending admin commands for this user (apply-once).
    const cmds = (await upstash(['LRANGE', `cmd:${userId}`, 0, -1])) || [];
    if (cmds.length) await upstash(['DEL', `cmd:${userId}`]);
    const commands = cmds.map(parseJSON).filter(Boolean);

    return res.status(200).json({ banned: false, balance, commands, referral, depositTotal, tasks, partner });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};
