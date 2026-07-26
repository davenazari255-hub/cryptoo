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
const MAX_TASK_REWARD = 100; // hard ceiling on any single task reward (incl. partner overrides)

// Default home tasks. Admin can edit/extend these via the admin panel (stored in
// Redis at config:tasks). `metric` drives client-side progress: always | deposit
// | spotVol | futVol | referral. `target` is the numeric goal (0 = instant).
const DEFAULT_TASKS = [
  { id: 'welcome', icon: 'ti-gift', title: 'Welcome Bonus', desc: 'Sign in to KolonoEX', reward: 10, metric: 'always', target: 0, go: 'home' },
  { id: 'deposit', icon: 'ti-wallet', title: 'Net Deposit', desc: 'Deposit a total of 100 USDT', reward: 10, metric: 'deposit', target: 100, go: 'assets' },
  { id: 'spot', icon: 'ti-arrows-exchange', title: 'First Spot Trade', desc: 'Trade 100 USDT volume in Spot', reward: 5, metric: 'spotVol', target: 100, go: 'trade' },
  { id: 'futures', icon: 'ti-trending-up', title: 'First Futures Trade', desc: 'Trade 20,000 USDT volume in Futures', reward: 15, metric: 'futVol', target: 20000, go: 'futures' },
  { id: 'tgchannel', icon: 'ti-brand-telegram', title: 'Join our Telegram', desc: 'Join the @KolonoEX channel', reward: 0.5, metric: 'tgChannel', target: 0, go: 'social', link: 'https://t.me/KolonoEX' },
  { id: 'xfollow', icon: 'ti-brand-x', title: 'Follow us on X', desc: 'Follow @KolonoEX on X', reward: 0.5, metric: 'xFollow', target: 0, go: 'social', link: 'https://x.com/KolonoEX' },
];
async function loadTasks(upstashFn) {
  const raw = await upstashFn(['GET', 'config:tasks']);
  const parsed = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;
  return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_TASKS;
}

// The task list as this user sees it, including any partner reward overrides.
// Rewards are clamped: a partner config must not be able to mint an arbitrary
// bonus, and a negative override must not deduct from the user.
async function effectiveTasks(upstashFn, userId) {
  let tasks = await loadTasks(upstashFn);
  const myPartner = await upstashFn(['GET', `ref:partner:${userId}`]);
  if (myPartner) {
    const pcfg = parseJSON(await upstashFn(['GET', `partner:cfg:${myPartner}`])) || {};
    const overrides = pcfg.taskRewards || {};
    tasks = tasks.map((t) => {
      if (overrides[t.id] == null) return t;
      const r = parseFloat(overrides[t.id]);
      if (!isFinite(r)) return t;
      return { ...t, reward: Math.min(MAX_TASK_REWARD, Math.max(0, r)), partnerBoost: true };
    });
  }
  return tasks;
}

// ── Daily check-in (7-day streak) ──
// Mirrors the client's reward table; the server is the arbiter of which day is
// claimable so clearing local storage cannot restart the cycle.
const CHECKIN_REWARDS = [0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 1];
const dayKey = (ts) => { const d = ts ? new Date(ts) : new Date(); return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate(); };

// Does this user satisfy a task's condition? Checked against server-held state
// wherever ground truth exists. Trading volume is simulated client-side, so the
// server keeps a monotonic high-water mark rather than a verifiable figure —
// the one-shot claim ledger is what actually caps the reward.
async function taskConditionMet(upstashFn, userId, task, vols) {
  const metric = task.metric || 'always';
  const target = parseFloat(task.target) || 0;
  switch (metric) {
    case 'tgChannel': return !!(await upstashFn(['GET', `task:tgchannel:${userId}`]));
    case 'xFollow':   return true; // honour-based; the claim ledger limits it to once
    case 'deposit':   return (parseFloat(await upstashFn(['GET', `dep:total:${userId}`])) || 0) >= target;
    case 'referral':  return (parseInt(await upstashFn(['GET', `ref:count:${userId}`]), 10) || 0) >= target;
    case 'spotVol':   return (vols.spot || 0) >= target;
    case 'futVol':    return (vols.fut || 0) >= target;
    default:          return true; // 'always'
  }
}

// Send a push message into the bot chat (outside the mini app). Best-effort.
async function tgSend(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: process.env.WEBAPP_URL ? { inline_keyboard: [[{ text: '🚀 Open KolonoEX', web_app: { url: process.env.WEBAPP_URL } }]] } : undefined }),
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
    // Ban check runs before ANY action so a suspended account cannot keep
    // verifying tasks, claiming rewards or checking in.
    if (await upstash(['GET', `banned:${userId}`])) return res.status(200).json({ banned: true });

    // Lightweight action: verify Telegram channel membership for the social task
    // (folded into sync to stay within the Hobby-plan 12-function limit). The bot
    // must be an admin of the channel for getChatMember to work.
    if (body.action === 'verifyChannel') {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const channel = process.env.TG_CHANNEL || '@KolonoEX';
      if (!token) return res.status(200).json({ ok: true, joined: false, error: 'bot not configured' });
      const url = `https://api.telegram.org/bot${token}/getChatMember`
        + `?chat_id=${encodeURIComponent(channel)}&user_id=${encodeURIComponent(user.id)}`;
      const r = await fetch(url);
      const d = await r.json().catch(() => null);
      if (!d || !d.ok || !d.result) return res.status(200).json({ ok: true, joined: false, error: (d && d.description) || 'cannot verify' });
      const st = d.result.status;
      const joined = st === 'creator' || st === 'administrator' || st === 'member'
        || (st === 'restricted' && d.result.is_member === true);
      // 7-day TTL: membership is re-verified periodically, so joining once and
      // immediately leaving does not keep the task satisfied forever.
      if (joined) { try { await upstash(['SET', `task:tgchannel:${userId}`, '1', 'EX', 604800]); } catch {} }
      return res.status(200).json({ ok: true, joined });
    }

    // ── Claim a task reward (server-authoritative, one-shot) ──
    // Claim state used to live only in localStorage, so clearing browser storage
    // re-enabled every task indefinitely. The claim ledger below is the single
    // source of truth: `SADD` returning 0 means it was already claimed.
    if (body.action === 'claimTask') {
      const taskId = String(body.taskId || '').slice(0, 24);
      if (!taskId) return res.status(400).json({ error: 'taskId required' });

      const tasks = await effectiveTasks(upstash, userId);
      const task = tasks.find((t) => String(t.id) === taskId);
      if (!task) return res.status(404).json({ error: 'Unknown task' });

      const vols = {
        spot: parseFloat(await upstash(['GET', `vol:spot:${userId}`])) || 0,
        fut: parseFloat(await upstash(['GET', `vol:fut:${userId}`])) || 0,
      };
      if (!(await taskConditionMet(upstash, userId, task, vols))) {
        return res.status(400).json({ error: 'Task not completed yet' });
      }

      // Atomic one-shot guard: only the first claim gets past this.
      const first = await upstash(['SADD', `task:claimed:${userId}`, taskId]);
      if (first === 0) return res.status(409).json({ error: 'Already claimed', claimed: await upstash(['SMEMBERS', `task:claimed:${userId}`]) });

      const reward = Math.min(MAX_TASK_REWARD, Math.max(0, parseFloat(task.reward) || 0));
      if (reward > 0) {
        const nb = parseFloat(await upstash(['INCRBYFLOAT', `bonus:${userId}`, reward]));
        // INCRBYFLOAT accumulates binary-float drift (0.1+0.2 -> 0.30000000000000004);
        // re-anchor to 2dp so the stored bonus stays a clean currency value.
        await upstash(['SET', `bonus:${userId}`, String(Math.round(nb * 100) / 100)]);
        await upstash(['LPUSH', `ledger:${userId}`, JSON.stringify({ usd: reward, coin: 'BONUS', note: 'Task: ' + String(task.title || taskId).slice(0, 60), at: Date.now() })]);
        await upstash(['LTRIM', `ledger:${userId}`, 0, 99]);
      }
      const bonus = parseFloat(await upstash(['GET', `bonus:${userId}`])) || 0;
      const claimed = (await upstash(['SMEMBERS', `task:claimed:${userId}`])) || [];
      return res.status(200).json({ ok: true, taskId, reward, bonus, claimed });
    }

    // ── Daily check-in (server-authoritative streak) ──
    if (body.action === 'checkin') {
      const st = parseJSON(await upstash(['GET', `checkin:${userId}`])) || { last: '', streak: 0 };
      const today = dayKey(), yest = dayKey(Date.now() - 86400000);
      if (st.last === today) return res.status(409).json({ error: 'Already checked in today', checkin: st });

      const day = (st.last === yest && (st.streak || 0) < 7) ? (st.streak || 0) + 1 : 1;
      const reward = CHECKIN_REWARDS[day - 1] || 0;
      const next = { last: today, streak: day };
      await upstash(['SET', `checkin:${userId}`, JSON.stringify(next)]);
      if (reward > 0) {
        const nb = parseFloat(await upstash(['INCRBYFLOAT', `bonus:${userId}`, reward]));
        await upstash(['SET', `bonus:${userId}`, String(Math.round(nb * 100) / 100)]);
        await upstash(['LPUSH', `ledger:${userId}`, JSON.stringify({ usd: reward, coin: 'BONUS', note: 'Daily check-in day ' + day, at: Date.now() })]);
        await upstash(['LTRIM', `ledger:${userId}`, 0, 99]);
      }
      const bonus = parseFloat(await upstash(['GET', `bonus:${userId}`])) || 0;
      return res.status(200).json({ ok: true, day, reward, bonus, checkin: next });
    }

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

    // Effective task list, including any partner reward overrides (clamped).
    const tasks = await effectiveTasks(upstash, userId);

    // Server-held reward state. The client renders from these instead of its own
    // localStorage, so wiping storage no longer re-opens claimed rewards.
    const [claimedRaw, checkinRaw, bonusRaw] = await Promise.all([
      upstash(['SMEMBERS', `task:claimed:${userId}`]),
      upstash(['GET', `checkin:${userId}`]),
      upstash(['GET', `bonus:${userId}`]),
    ]);
    let taskClaimed = claimedRaw || [];
    let checkin = parseJSON(checkinRaw) || { last: '', streak: 0 };
    let bonusServer = parseFloat(bonusRaw) || 0;

    // ── One-time migration for users who predate server-side reward state ──
    // Their claims/streak/bonus only ever existed in localStorage. Adopt the
    // snapshot ONCE (guarded by a marker key) so nobody loses an earned bonus,
    // then the server is authoritative from that point on.
    const migrated = await upstash(['GET', `rw:migrated:${userId}`]);
    if (!migrated) {
      const inClaims = body.taskClaimed && typeof body.taskClaimed === 'object' ? Object.keys(body.taskClaimed).filter((k) => body.taskClaimed[k]).slice(0, 24) : [];
      const inCheckin = body.checkin && typeof body.checkin === 'object' ? body.checkin : null;
      const inBonus = Math.max(0, Math.min(10000, parseFloat(body.bonusLocal) || 0));
      if (inClaims.length) { await upstash(['SADD', `task:claimed:${userId}`, ...inClaims]); taskClaimed = (await upstash(['SMEMBERS', `task:claimed:${userId}`])) || []; }
      if (inCheckin && inCheckin.last) {
        checkin = { last: String(inCheckin.last).slice(0, 12), streak: Math.max(0, Math.min(7, parseInt(inCheckin.streak, 10) || 0)) };
        await upstash(['SET', `checkin:${userId}`, JSON.stringify(checkin)]);
      }
      if (inBonus > 0 && bonusServer === 0) {
        bonusServer = Math.round(inBonus * 100) / 100;
        await upstash(['SET', `bonus:${userId}`, String(bonusServer)]);
      }
      await upstash(['SET', `rw:migrated:${userId}`, '1']);
    }

    // Persist a monotonic high-water mark of simulated trading volume so the
    // volume-gated tasks have a server-side value to check against.
    const volSpot = Math.max(0, parseFloat(body.spotVol) || 0);
    const volFut = Math.max(0, parseFloat(body.futVol) || 0);
    const [prevSpot, prevFut] = await Promise.all([
      upstash(['GET', `vol:spot:${userId}`]),
      upstash(['GET', `vol:fut:${userId}`]),
    ]);
    if (volSpot > (parseFloat(prevSpot) || 0)) await upstash(['SET', `vol:spot:${userId}`, String(volSpot)]);
    if (volFut > (parseFloat(prevFut) || 0)) await upstash(['SET', `vol:fut:${userId}`, String(volFut)]);

    // This user's own partner status (if they applied / were approved).
    const partnerRaw = await upstash(['GET', `partner:me:${userId}`]);
    const partner = parseJSON(partnerRaw) || null;

    // Drain pending admin commands for this user (apply-once).
    const cmds = (await upstash(['LRANGE', `cmd:${userId}`, 0, -1])) || [];
    if (cmds.length) await upstash(['DEL', `cmd:${userId}`]);
    const commands = cmds.map(parseJSON).filter(Boolean);

    return res.status(200).json({ banned: false, balance, commands, referral, depositTotal, tasks, partner, taskClaimed, checkin, bonusServer });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};
