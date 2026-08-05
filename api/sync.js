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
const COUPON_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // coupons expire after 7 days

// Small, frequent rewards (daily check-in, referrals) collect in a pot instead
// of minting a coupon each time — a 0.10 ticket per check-in would bury the
// Coupon Center. Once the pot reaches the threshold the WHOLE pot becomes one
// coupon and the pot resets, so nothing is left stranded as dust.
// Two independent pots. They were one shared pot with one threshold, which made
// the two rewards indistinguishable: raising the referral bar to 10 also raised
// the check-in bar, and each surface described the other's rules.
//
//   check-in  -> pot:<user>   mints at 5   (small, daily, should land often)
//   referral  -> rpot:<user>  mints at 10  (a couple of invites should not tip it)
//
// Existing users keep their pot: balance as the check-in pot; rpot: starts empty,
// so nothing already banked is lost.
const POT_THRESHOLD = 5;
const REF_POT_THRESHOLD = 10;

const POTS = {
  checkin:  { key: 'pot',  threshold: POT_THRESHOLD,     label: 'Check-in rewards' },
  referral: { key: 'rpot', threshold: REF_POT_THRESHOLD, label: 'Referral rewards' },
};

// Net deposit ladder. Each rung pays once; reaching a higher rung does not
// void the lower ones.
const DEPOSIT_TIERS = [
  { id: 'd100',  at: 100,  reward: 10 },
  { id: 'd200',  at: 200,  reward: 25 },
  { id: 'd1000', at: 1000, reward: 150 },
];

// Pure: add to a pot and decide whether it tips over into a coupon.
// Returns the amount to mint (0 = nothing yet) and the pot to store. The
// threshold is a parameter because check-in and referral pots differ; it
// defaults to the check-in one so existing callers and tests are unaffected.
function potAdd(pot, amount, threshold) {
  const t = parseFloat(threshold);
  const lim = isFinite(t) && t > 0 ? t : POT_THRESHOLD;
  const cur = Math.max(0, parseFloat(pot) || 0);
  const add = Math.max(0, parseFloat(amount) || 0);
  const next = Math.round((cur + add) * 100) / 100;
  if (next >= lim) return { mint: next, pot: 0 };
  return { mint: 0, pot: next };
}

// Pure: the ladder's state for a given net deposit and set of claimed rungs.
// `legacyDeposit` is true when the user already claimed the old flat "Net
// Deposit" task; that reward was the same 10 USDT as rung d100, so it must
// count as claimed or the ladder would pay it a second time.
function depositLadder(total, claimedIds, legacyDeposit) {
  const dep = Math.max(0, parseFloat(total) || 0);
  const done = new Set(Array.isArray(claimedIds) ? claimedIds : []);
  if (legacyDeposit) done.add('d100');
  return DEPOSIT_TIERS.map((t) => ({
    id: t.id, at: t.at, reward: t.reward,
    state: done.has(t.id) ? 'claimed' : (dep >= t.at ? 'ready' : 'locked'),
  }));
}
const COUPON_KEEP = 40;                           // cap the stored history

// Mints a coupon into coupons:${userId}. Shared by every reward path so the
// record shape and the 7-day window can never drift between them.
async function mintCoupon(upstashFn, userId, { src, srcId, title, amount }) {
  const now = Date.now();
  const c = {
    id: 'c_' + String(srcId || src).slice(0, 20) + '_' + now.toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    src, srcId: srcId || null,
    title: String(title || 'Bonus coupon').slice(0, 60),
    amount: Math.round((parseFloat(amount) || 0) * 100) / 100,
    at: now, exp: now + COUPON_TTL_MS, status: 'new',
  };
  const list = parseJSON(await upstashFn(['GET', `coupons:${userId}`])) || [];
  const next = [c].concat(Array.isArray(list) ? list : []).slice(0, COUPON_KEEP);
  await upstashFn(['SET', `coupons:${userId}`, JSON.stringify(next)]);
  return c;
}

// Adds a small reward to the pot, minting a coupon if it tips the threshold.
// `kind` selects which pot this reward belongs to — 'checkin' or 'referral'.
// They are separate keys with separate thresholds, so a referral can never
// advance the check-in bar or vice versa.
async function creditPot(upstashFn, userId, amount, label, kind) {
  const spec = POTS[kind] || POTS.checkin;
  const redisKey = `${spec.key}:${userId}`;
  const cur = parseFloat(await upstashFn(['GET', redisKey])) || 0;
  const { mint, pot } = potAdd(cur, amount, spec.threshold);
  await upstashFn(['SET', redisKey, String(pot)]);
  if (!mint) return { pot, coupon: null };
  const coupon = await mintCoupon(upstashFn, userId, {
    src: 'pot', srcId: spec.key, title: label || spec.label, amount: mint,
  });
  return { pot, coupon };
}

// Pure: derive a coupon's state at a point in time. Kept separate from I/O so
// it can be unit-tested (see test_coupons.js).
function couponState(c, now) {
  if (!c) return 'expired';
  if (c.status === 'active') return 'active';
  return (Number(c.exp) || 0) > now ? 'available' : 'expired';
}

// Pure: split a coupon list into the three buckets the UI renders, newest first.
function bucketCoupons(list, now) {
  const out = { available: [], active: [], expired: [] };
  (Array.isArray(list) ? list : []).forEach((c) => {
    const st = couponState(c, now);
    out[st === 'active' ? 'active' : st].push(Object.assign({}, c, { state: st }));
  });
  return out;
}

const MAX_TASK_REWARD = 100; // hard ceiling on any single task reward (incl. partner overrides)
// Coupons need their own, higher ceiling: the deposit ladder pays 150, which is
// above MAX_TASK_REWARD. Clamping activation to the *task* ceiling silently ate
// 50 USDT off a 150 coupon.
const MAX_COUPON_VALUE = 1000;

// Default home tasks. Admin can edit/extend these via the admin panel (stored in
// Redis at config:tasks). `metric` drives client-side progress: always | deposit
// | spotVol | futVol | referral. `target` is the numeric goal (0 = instant).
const DEFAULT_TASKS = [
  { id: 'welcome', icon: 'ti-gift', title: 'Welcome Bonus', desc: 'Sign in to KolonoEX', reward: 10, metric: 'always', target: 0, go: 'home' },
  { id: 'deposit', icon: 'ti-wallet', title: 'Net Deposit', desc: 'Deposit to unlock tiered rewards', reward: 10, metric: 'deposit', target: 100, go: 'assets' },
  { id: 'spot', icon: 'ti-arrows-exchange', title: 'First Spot Trade', desc: 'Trade 100 USDT volume in Spot', reward: 5, metric: 'spotVol', target: 100, go: 'trade' },
  { id: 'futures', icon: 'ti-trending-up', title: 'First Futures Trade', desc: 'Trade 20,000 USDT volume in Futures', reward: 15, metric: 'futVol', target: 20000, go: 'futures' },
  { id: 'tgchannel', icon: 'ti-brand-telegram', title: 'Join our Telegram', desc: 'Join the @KolonoEX channel', reward: 0.5, metric: 'tgChannel', target: 0, go: 'social', link: 'https://t.me/KolonoEX' },
  { id: 'xfollow', icon: 'ti-brand-x', title: 'Follow us on X', desc: 'Follow @KolonoEX on X', reward: 0.5, metric: 'xFollow', target: 0, go: 'social', link: 'https://x.com/KolonoEX' },
];
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

async function loadBanners(upstashFn, userId) {
  const raw = await upstashFn(['GET', 'config:banners']);
  const parsed = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;
  const list = Array.isArray(parsed) ? cleanBanners(parsed) : DEFAULT_BANNERS;

  // Never pitch the partner programme to someone already in it. Pending counts:
  // an application under review should not be asked to apply again. Decided
  // here rather than in the client, because the client's partner record may not
  // have loaded by the time the carousel opens.
  let inProgramme = false;
  if (userId) {
    const me = parseJSON(await upstashFn(['GET', `partner:me:${userId}`]));
    inProgramme = !!(me && (me.status === 'approved' || me.status === 'pending'));
  }
  return list.filter((b) => b.on !== false && !(inProgramme && b.action === 'partner'));
}

// Who invited this user, for display back to them. Returns null for an organic
// signup. Deliberately does not include the referrer's user id: the point is
// attribution, not exposing another account's identifier.
async function invitedBy(upstashFn, userId) {
  const ref = await upstashFn(['GET', `ref:by:${userId}`]);
  if (!ref) return null;
  const code = await upstashFn(['GET', `ref:partner:${userId}`]);
  const [profRaw, pmRaw] = await Promise.all([
    upstashFn(['GET', `profile:${ref}`]),
    upstashFn(['GET', `partner:me:${ref}`]),
  ]);
  const prof = parseJSON(profRaw) || {};
  const pm = parseJSON(pmRaw) || null;
  // Only an approved partner is presented as one, and only their channel is
  // shown — the rest of the application (audience, private note) stays private.
  const approved = !!(pm && pm.status === 'approved');
  const name = (approved && pm.name) || prof.name || null;
  const username = (approved && pm.username) || prof.username || null;
  return {
    name: name ? String(name).slice(0, 40) : null,
    username: username ? String(username).slice(0, 40) : null,
    channel: approved && pm.channel ? String(pm.channel).slice(0, 120) : null,
    partner: approved,
    code: approved && code ? String(code).slice(0, 32) : null,
  };
}

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
const CHECKIN_REWARDS = [0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 1];   // one week of the cycle
// The streak runs indefinitely. Each further week pays the same shape scaled by
// the tier the streak has reached, plus a one-off badge at each milestone.
const STREAK_TIERS = [
  { min: 180, mult: 2 },
  { min: 90,  mult: 1.75 },
  { min: 30,  mult: 1.5 },
  { min: 7,   mult: 1.25 },
  { min: 0,   mult: 1 },
];
const STREAK_MILESTONES = { 7: 1, 30: 5, 90: 15, 180: 40 };  // paid once each, ever
const FREEZE_EVERY = 10;   // one streak freeze earned per 10 consecutive days
const FREEZE_MAX = 2;      // never bank more than this
const streakMult = (n) => (STREAK_TIERS.find((t) => n >= t.min) || { mult: 1 }).mult;

// Pure decision step for a check-in, split out so it can be tested directly.
// `st` is the stored { last, streak, freeze, best, ms }; the three day keys are
// today / yesterday / the day before, all from the server clock.
function computeCheckin(st, today, yest, before) {
  // parseInt, not `|| 0`: a stored string would make `+ 1` concatenate
  // ('5' + 1 === '51'), which would fabricate a huge streak and tier.
  const prevStreak = Math.max(0, parseInt(st.streak, 10) || 0);
  const banked = Math.max(0, parseInt(st.freeze, 10) || 0);

  // Continue, or spend a banked freeze to forgive exactly one missed day.
  let streak, usedFreeze = false;
  if (st.last === yest) {
    streak = prevStreak + 1;
  } else if (st.last === before && banked > 0) {
    streak = prevStreak + 1; usedFreeze = true;
  } else {
    streak = 1;
  }

  const day = ((streak - 1) % 7) + 1;              // position within the current week
  const mult = streakMult(streak);
  const reward = Math.round((CHECKIN_REWARDS[day - 1] || 0) * mult * 100) / 100;

  // Milestone badges pay once per account, tracked by the ms list.
  const ms = Array.isArray(st.ms) ? st.ms.slice(0, 24) : [];
  let milestone = 0;
  if (STREAK_MILESTONES[streak] && !ms.includes(String(streak))) {
    milestone = STREAK_MILESTONES[streak];
    ms.push(String(streak));
  }

  let freeze = banked - (usedFreeze ? 1 : 0);
  if (streak % FREEZE_EVERY === 0) freeze = Math.min(FREEZE_MAX, freeze + 1);

  const credit = Math.round((reward + milestone) * 100) / 100;
  const next = { last: today, streak, freeze, best: Math.max(parseInt(st.best, 10) || 0, streak), ms };
  return { day, streak, mult, reward, milestone, freeze, usedFreeze, credit, next };
}
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
  // Referral rewards go through the same pot as check-ins: they collect until
  // POT_THRESHOLD, then become one activatable coupon.
  if (bonus > 0) {
    await creditPot(upstashFn, referrer, bonus, 'Referral rewards', 'referral');
    await upstashFn(['LPUSH', `ledger:${referrer}`, JSON.stringify({ usd: bonus, coin: 'POT', note: 'Referral bonus', at: Date.now() })]);
    await upstashFn(['LTRIM', `ledger:${referrer}`, 0, 99]);
  }

  // Notify the referrer: in-bot push + in-app notification (delivered on next sync).
  const who = escHtml(newUserName || 'A new user');
  const text = `🎉 <b>${who}</b> just joined KolonoEX using your invite link!\n\n💰 You earned <b>$${bonus}</b> — it is collecting in your Coupon Center and becomes an activatable coupon once your referral rewards reach $${REF_POT_THRESHOLD}.`;
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
      // The deposit reward is paid by the ladder (action=claimDeposit), which
      // owns all three rungs. Letting claimTask pay it too would double-pay the
      // first rung for anyone whose admin task config still lists it.
      if (task.metric === 'deposit') {
        return res.status(400).json({ error: 'Claim deposit rewards from the Net Deposit card' });
      }
      if (!(await taskConditionMet(upstash, userId, task, vols))) {
        return res.status(400).json({ error: 'Task not completed yet' });
      }

      // Atomic one-shot guard: only the first claim gets past this.
      const first = await upstash(['SADD', `task:claimed:${userId}`, taskId]);
      if (first === 0) return res.status(409).json({ error: 'Already claimed', claimed: await upstash(['SMEMBERS', `task:claimed:${userId}`]) });

      const reward = Math.min(MAX_TASK_REWARD, Math.max(0, parseFloat(task.reward) || 0));

      // The reward is issued as a coupon, NOT credited here. It only reaches the
      // bonus balance when the user activates it in the Coupon Center, and it
      // lapses if they leave it for a week.
      let coupon = null;
      if (reward > 0) {
        const now = Date.now();
        coupon = {
          id: 'c_' + taskId + '_' + now.toString(36),
          src: 'task', srcId: taskId,
          title: String(task.title || 'Task reward').slice(0, 60),
          amount: reward, at: now, exp: now + COUPON_TTL_MS, status: 'new',
        };
        const list = parseJSON(await upstash(['GET', `coupons:${userId}`])) || [];
        const next = [coupon].concat(Array.isArray(list) ? list : []).slice(0, COUPON_KEEP);
        await upstash(['SET', `coupons:${userId}`, JSON.stringify(next)]);
      }
      const bonus = parseFloat(await upstash(['GET', `bonus:${userId}`])) || 0;
      const claimed = (await upstash(['SMEMBERS', `task:claimed:${userId}`])) || [];
      const coupons = parseJSON(await upstash(['GET', `coupons:${userId}`])) || [];
      return res.status(200).json({ ok: true, taskId, reward, coupon, bonus, claimed, coupons, now: Date.now() });
    }

    // ── Claim a rung of the net-deposit ladder ──
    if (body.action === 'claimDeposit') {
      const depTotal = parseFloat(await upstash(['GET', `dep:total:${userId}`])) || 0;
      const already = (await upstash(['SMEMBERS', `dep:tiers:${userId}`])) || [];
      // A user who claimed the old flat Net Deposit task already has rung one.
      const legacy = ((await upstash(['SMEMBERS', `task:claimed:${userId}`])) || []).indexOf('deposit') >= 0;
      if (legacy && already.indexOf('d100') < 0) { await upstash(['SADD', `dep:tiers:${userId}`, 'd100']); already.push('d100'); }
      const ready = DEPOSIT_TIERS.filter((t) => depTotal >= t.at && already.indexOf(t.id) < 0);
      if (!ready.length) return res.status(400).json({ error: 'Nothing to claim yet', depTiers: already, depositTotal: depTotal });

      // Every rung that is due is claimed in one call — a 1000 USDT deposit
      // opens all three at once and should not need three taps. Each rung keeps
      // its own atomic SADD gate, so a concurrent call cannot double-pay one.
      const minted = [];
      let total = 0;
      for (const t of ready) {
        const first = await upstash(['SADD', `dep:tiers:${userId}`, t.id]);
        if (first === 0) continue;                       // someone else got this rung
        const c = await mintCoupon(upstash, userId, {
          src: 'deposit', srcId: t.id,
          title: 'Net deposit ' + t.at + ' USDT', amount: t.reward,
        });
        minted.push(c); total += t.reward;
        await upstash(['LPUSH', `ledger:${userId}`, JSON.stringify({ usd: t.reward, coin: 'COUPON', note: 'Deposit ladder ' + t.at, at: Date.now() })]);
      }
      if (!minted.length) return res.status(409).json({ error: 'Already claimed', depTiers: (await upstash(['SMEMBERS', `dep:tiers:${userId}`])) || [] });
      await upstash(['LTRIM', `ledger:${userId}`, 0, 99]);

      const depTiers = (await upstash(['SMEMBERS', `dep:tiers:${userId}`])) || [];
      const coupons = parseJSON(await upstash(['GET', `coupons:${userId}`])) || [];
      return res.status(200).json({ ok: true, reward: Math.round(total * 100) / 100, minted: minted.length,
        coupons, depTiers, depositTotal: depTotal, now: Date.now() });
    }

    // ── Activate a coupon → this is the only path that credits a task bonus ──
    if (body.action === 'activateCoupon') {
      const couponId = String(body.couponId || '').slice(0, 64);
      if (!couponId) return res.status(400).json({ error: 'couponId required' });

      const now = Date.now();
      const list = parseJSON(await upstash(['GET', `coupons:${userId}`])) || [];
      const idx = (Array.isArray(list) ? list : []).findIndex((c) => c && c.id === couponId);
      if (idx < 0) return res.status(404).json({ error: 'Coupon not found' });

      const c = list[idx];
      const st = couponState(c, now);
      if (st === 'active') return res.status(409).json({ error: 'Coupon already activated', coupons: list });
      if (st === 'expired') return res.status(410).json({ error: 'Coupon has expired', coupons: list });

      // Atomic one-shot gate. Read-modify-write on the JSON array alone would
      // let a double-tap credit the bonus twice; SADD returning 0 means someone
      // already got there.
      const first = await upstash(['SADD', `coupon:used:${userId}`, couponId]);
      if (first === 0) return res.status(409).json({ error: 'Coupon already activated', coupons: list });

      const amount = Math.min(MAX_COUPON_VALUE, Math.max(0, parseFloat(c.amount) || 0));
      if (amount > 0) {
        const nb = parseFloat(await upstash(['INCRBYFLOAT', `bonus:${userId}`, amount]));
        // INCRBYFLOAT accumulates binary-float drift; re-anchor to 2dp.
        await upstash(['SET', `bonus:${userId}`, String(Math.round(nb * 100) / 100)]);
        await upstash(['LPUSH', `ledger:${userId}`, JSON.stringify({ usd: amount, coin: 'BONUS', note: 'Coupon: ' + String(c.title || couponId).slice(0, 60), at: now })]);
        await upstash(['LTRIM', `ledger:${userId}`, 0, 99]);
      }

      list[idx] = Object.assign({}, c, { status: 'active', activatedAt: now });
      await upstash(['SET', `coupons:${userId}`, JSON.stringify(list)]);
      const bonus = parseFloat(await upstash(['GET', `bonus:${userId}`])) || 0;
      return res.status(200).json({ ok: true, couponId, amount, bonus, coupons: list, now });
    }

    // ── Daily check-in (server-authoritative streak) ──
    if (body.action === 'checkin') {
      const st = parseJSON(await upstash(['GET', `checkin:${userId}`])) || { last: '', streak: 0 };
      const today = dayKey(), yest = dayKey(Date.now() - 86400000);
      if (st.last === today) return res.status(409).json({ error: 'Already checked in today', checkin: st, today, yesterday: yest });

      const before = dayKey(Date.now() - 172800000);   // the day before yesterday
      const c = computeCheckin(st, today, yest, before);
      const { day, streak, mult, reward, milestone, freeze, usedFreeze, credit, next } = c;

      await upstash(['SET', `checkin:${userId}`, JSON.stringify(next)]);

      // Check-in rewards are small and daily, so they collect in the pot and
      // only become a coupon once it reaches POT_THRESHOLD.
      let potOut = { pot: parseFloat(await upstash(['GET', `pot:${userId}`])) || 0, coupon: null };
      if (credit > 0) {
        const note = 'Daily check-in day ' + day + ' (' + streak + '-day streak' +
          (milestone > 0 ? ', ' + streak + '-day badge' : '') + (usedFreeze ? ', freeze used' : '') + ')';
        potOut = await creditPot(upstash, userId, credit, 'Check-in rewards', 'checkin');
        await upstash(['LPUSH', `ledger:${userId}`, JSON.stringify({ usd: credit, coin: 'POT', note, at: Date.now() })]);
        await upstash(['LTRIM', `ledger:${userId}`, 0, 99]);
      }
      const bonus = parseFloat(await upstash(['GET', `bonus:${userId}`])) || 0;
      const coupons = parseJSON(await upstash(['GET', `coupons:${userId}`])) || [];
      return res.status(200).json({ ok: true, day, streak, reward, milestone, mult, freeze, usedFreeze,
        best: next.best, bonus, checkin: next, today, yesterday: yest,
        pot: potOut.pot, potCoupon: potOut.coupon, potThreshold: POT_THRESHOLD, coupons, now: Date.now() });
    }

    // ── Transfer bonus profit out, and clear the bonus ──
    // The client cleared its own copy and the next sync handed the whole bonus
    // straight back, because the server still held it. Clearing has to happen
    // here to stick.
    if (body.action === 'bonusTransfer') {
      const want = Math.round((parseFloat(body.amount) || 0) * 100) / 100;
      if (!(want > 0)) return res.status(400).json({ error: 'Enter an amount' });

      const bonusNow = parseFloat(await upstash(['GET', `bonus:${userId}`])) || 0;
      if (!(bonusNow > 0)) return res.status(400).json({ error: 'No bonus to transfer' });

      // The profit figure comes from trading that happens entirely in the
      // client, so this endpoint cannot verify it. What becomes real, spendable
      // money is therefore capped at the bonus actually granted: the most any
      // user can turn into a withdrawal is the bonus we chose to give them.
      const credited = Math.min(want, bonusNow);

      await upstash(['SET', `bonus:${userId}`, '0']);
      const newBal = parseFloat(await upstash(['INCRBYFLOAT', `bal:${userId}`, credited]));
      // Spendable, not just visible: the withdrawal gate is deposits + earned,
      // so without this the money would sit in the balance and never come out.
      await upstash(['INCRBYFLOAT', `payout:earned:${userId}`, credited]);

      await upstash(['LPUSH', `ledger:${userId}`, JSON.stringify({
        usd: credited, coin: 'BONUS', note: 'Bonus profit transferred to Spot', at: Date.now() })]);
      await upstash(['LTRIM', `ledger:${userId}`, 0, 99]);

      return res.status(200).json({ ok: true, balance: newBal, credited, cleared: bonusNow });
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
    // Cash the user genuinely earned (partner commission, transferred bonus
    // profit). The withdrawal gate is deposits + this, so the client needs it to
    // apply the same rule instead of a stricter deposits-only one.
    const payoutEarned = Math.max(0, parseFloat(await upstash(['GET', `payout:earned:${userId}`])) || 0);
    // Real on-chain deposits, which is what the withdrawal gate turns on. Sent
    // so the client can warn with the same rule instead of guessing from the
    // lifetime credit, which also counts admin credits.
    const realDeposit = Math.max(0, parseFloat(await upstash(['GET', `dep:real:${userId}`])) || 0);

    // Referral stats for this user.
    const referralCount = parseInt(await upstash(['GET', `ref:count:${userId}`]), 10) || 0;
    const referral = { count: referralCount, earned: Math.round(referralCount * REFERRAL_BONUS * 100) / 100, bonus: REFERRAL_BONUS };

    // Effective task list, including any partner reward overrides (clamped).
    const tasks = await effectiveTasks(upstash, userId);
    const banners = await loadBanners(upstash, userId);
    const invited = await invitedBy(upstash, userId);

    // Server-held reward state. The client renders from these instead of its own
    // localStorage, so wiping storage no longer re-opens claimed rewards.
    const couponsRaw = await upstash(['GET', `coupons:${userId}`]);
    const potVal = parseFloat(await upstash(['GET', `pot:${userId}`])) || 0;
    const refPotVal = parseFloat(await upstash(['GET', `rpot:${userId}`])) || 0;
    const depTiers = (await upstash(['SMEMBERS', `dep:tiers:${userId}`])) || [];
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

    // The server owns the calendar day (UTC). The client must not derive it
    // locally — a client in UTC+03:30 computes a different day between 00:00
    // and 03:29 local, which made an already-claimed check-in look claimable.
    return res.status(200).json({ banned: false, balance, commands, referral, depositTotal, tasks, partner, taskClaimed, checkin, bonusServer,
      banners, invitedBy: invited, payoutEarned, realDeposit,
      coupons: parseJSON(couponsRaw) || [], now: Date.now(),
      pot: potVal, potThreshold: POT_THRESHOLD,
      refPot: refPotVal, refPotThreshold: REF_POT_THRESHOLD,
      depTiers, depositLadder: depositLadder(depositTotal, depTiers, (Array.isArray(taskClaimed) ? taskClaimed : []).indexOf('deposit') >= 0),
      today: dayKey(), yesterday: dayKey(Date.now() - 86400000) });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};

module.exports.cleanBanners = cleanBanners;
module.exports.loadBanners = loadBanners;
module.exports.invitedBy = invitedBy;
module.exports.DEFAULT_BANNERS = DEFAULT_BANNERS;
module.exports.computeCheckin = computeCheckin;
module.exports.couponState = couponState;
module.exports.bucketCoupons = bucketCoupons;
module.exports.potAdd = potAdd;
module.exports.POT_THRESHOLD = POT_THRESHOLD;
module.exports.REF_POT_THRESHOLD = REF_POT_THRESHOLD;
module.exports.POTS = POTS;
module.exports.depositLadder = depositLadder;
