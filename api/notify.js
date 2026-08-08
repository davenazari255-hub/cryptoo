// Sends a bot push message to the authenticated user (used for client-side
// events like task-claim bonuses). TG-authed. Self-contained for Vercel.
const crypto = require('crypto');

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
  try { const u = JSON.parse(params.get('user') || 'null'); return u && u.id ? u : null; } catch { return null; }
}

const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Length-safe constant-time string compare for the scheduler bearer tokens.
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch { return false; }
}


// ── daily check-in reminder (invoked by Vercel Cron, see vercel.json) ────────
// Lives here rather than in its own file because the Hobby plan allows only 12
// Serverless Functions per deployment and api/ is already at the cap.

const REMIND_PER_RUN = 220;   // Telegram tolerates ~30 msg/s; this stays under
const REMIND_GAP_MS = 45;     // gentle pacing between sends

// `bot:users` stores the bare Telegram chat id, because that is what
// sendMessage takes. Every app-scoped key in Redis is namespaced `tg_<id>`.
// Reading `checkin:<bare id>` therefore always missed, so nobody was ever
// skipped and users who had already checked in were reminded anyway.
const appId = (chatId) => `tg_${chatId}`;

// Three windows a day. A user belongs to exactly one window per day, and the
// assignment rotates with the day number so the reminder does not always land
// at the same hour for the same person.
const REMIND_SLOTS = 3;
const SLOT_HOURS = [8, 13, 18];        // UTC — ~11:30 / 16:30 / 21:30 Tehran
const RM_DAY_TTL = 172800;             // the per-day claim set self-cleans

const dayNumber = (ts) => Math.floor((ts || Date.now()) / 86400000);

// Deterministic: the same user lands in the same window all day (so a retry
// cannot move them) but a different window tomorrow.
//
// FNV-1a with a murmur3 finaliser rather than the obvious `h * 31 + c`. That
// simple form has structure in its low bits: for a 3-character string of one
// repeated character it reduces to c * 993, and 993 is divisible by 3, so every
// such id landed in the same window. Real Telegram ids are long and varied
// enough that it looked fine in aggregate, which is exactly why it needed a
// test rather than an eyeball.
function userSlot(chatId, dayNum) {
  const str = String(chatId);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return ((h + dayNum) % REMIND_SLOTS + REMIND_SLOTS) % REMIND_SLOTS;
}

// Which window this invocation is for, in order of trust:
//   1. an explicit ?slot=
//   2. the hour in Vercel's x-vercel-cron-schedule header — the documented way
//      to tell apart several crons that share one path, and reliable even if
//      the query string were ever dropped
//   3. the wall-clock hour
// Hobby fires anywhere inside the scheduled hour, so the hour is matched to the
// nearest configured window rather than exactly.
function slotForHour(hour) {
  let best = 0, bestD = Infinity;
  SLOT_HOURS.forEach((h, i) => {
    const raw = Math.abs(hour - h);
    const d = Math.min(raw, 24 - raw);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function resolveSlot(raw, schedule, now) {
  const n = parseInt(raw, 10);
  if (Number.isInteger(n) && n >= 0 && n < REMIND_SLOTS) return n;
  const m = String(schedule || '').trim().match(/^\S+\s+(\d{1,2})\s/);
  if (m) {
    const h = parseInt(m[1], 10);
    if (h >= 0 && h <= 23) return slotForHour(h);
  }
  return slotForHour(new Date(now || Date.now()).getUTCHours());
}

async function upstash(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Upstash not configured');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error('Upstash: ' + (data.error || r.status));
  return data.result;
}

const parseJSON = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
const dayKey = (ts) => { const d = ts ? new Date(ts) : new Date(); return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same tables as api/sync.js — used only to say what today is worth.
const RM_REWARDS = [0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 1];
const RM_TIERS = [{ min: 180, mult: 2 }, { min: 90, mult: 1.75 }, { min: 30, mult: 1.5 }, { min: 7, mult: 1.25 }, { min: 0, mult: 1 }];
const rmMult = (n) => (RM_TIERS.find((t) => n >= t.min) || { mult: 1 }).mult;

function reminderText(st, yest) {
  const streak = Math.max(0, parseInt(st && st.streak, 10) || 0);
  const freeze = Math.max(0, parseInt(st && st.freeze, 10) || 0);
  const continues = !!(st && st.last === yest);

  const nextStreak = continues ? streak + 1 : 1;
  const day = ((nextStreak - 1) % 7) + 1;
  const due = Math.round((RM_REWARDS[day - 1] || 0) * rmMult(nextStreak) * 100) / 100;

  if (continues && streak >= 2) {
    const risk = freeze > 0
      ? `You have ${freeze} \u2744\uFE0F freeze${freeze > 1 ? 's' : ''} banked \u2014 but why spend one?`
      : 'Miss today and it goes back to zero.';
    return `\u{1F525} <b>${streak}-day streak</b>\n\nDay ${day} is waiting \u2014 <b>+${due} USDT</b> bonus.\n${risk}`;
  }
  if (continues) {
    return `\u{1F381} <b>Day ${day} is ready</b>\n\nCheck in for <b>+${due} USDT</b> bonus and keep your streak going.`;
  }
  return `\u{1F381} <b>Your daily bonus is waiting</b>\n\nCheck in today for <b>+${due} USDT</b> \u2014 then keep the streak alive for bigger rewards.`;
}

// Walks the audience in slices behind a Redis cursor, so a single invocation can
// never run past the function timeout however large the audience grows.
async function runCheckinReminder(res, slotRaw, schedule) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN missing' });

  const now = Date.now();
  const today = dayKey(), yest = dayKey(now - 86400000);
  const dayNum = dayNumber(now);
  const slot = resolveSlot(slotRaw, schedule, now);
  const webapp = process.env.WEBAPP_URL;
  const reply_markup = webapp ? { inline_keyboard: [[{ text: '\u{1F381} Check in now', web_app: { url: webapp } }]] } : undefined;
  let sent = 0, alreadyIn = 0, optedOut = 0, otherSlot = 0, dupe = 0, blocked = 0, failed = 0;

  try {
    // bot:users only: these chat ids actually started the bot, so we are not
    // pushing to anyone who never opted into messages.
    const all = (await upstash(['SMEMBERS', 'bot:users'])) || [];
    if (!all.length) return res.status(200).json({ ok: true, slot, audience: 0, sent });

    // Only this window's share of the audience.
    const mine = all.filter((id) => userSlot(id, dayNum) === slot).sort();
    otherSlot = all.length - mine.length;

    // A cursor per slot bounds the work in one invocation however large the
    // audience grows, without a slot stealing another slot's position.
    const cursorKey = `cron:checkin:cursor:${slot}`;
    let start = Math.max(0, parseInt(await upstash(['GET', cursorKey]), 10) || 0);
    if (start >= mine.length) start = 0;
    const slice = mine.slice(start, start + REMIND_PER_RUN);

    // These two used to be a SISMEMBER and a GET *per user*, so a run over 220
    // users cost 440 commands before a single message was sent — three times a
    // day, against a metered quota. Both are now one command for the whole
    // slice: the opt-out list as a single set read, and every check-in record
    // in a single MGET.
    const optOutSet = new Set(((await upstash(['SMEMBERS', 'noremind'])) || []).map(String));
    const checkinRaw = slice.length
      ? ((await upstash(['MGET', ...slice.map((c) => `checkin:${appId(c)}`)])) || [])
      : [];

    for (let i = 0; i < slice.length; i++) {
      const chatId = slice[i];
      try {
        if (optOutSet.has(String(chatId))) { optedOut++; continue; }

        const st = parseJSON(checkinRaw[i]) || { last: '', streak: 0 };
        if (st.last === today) { alreadyIn++; continue; }   // already checked in today

        // Atomic claim before sending: SADD returns 0 if some other invocation
        // (or a retry of this one) already took this user today. Claiming
        // before the send means a failed send is not retried later the same
        // day, which is the right trade — a missed reminder is recoverable,
        // a duplicate one is what annoys people.
        const claimed = await upstash(['SADD', `remind:day:${today}`, chatId]);
        if (claimed !== 1) { dupe++; continue; }

        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: reminderText(st, yest),
            parse_mode: 'HTML', disable_web_page_preview: true, reply_markup }),
        });

        if (r.status === 403) { await upstash(['SREM', 'bot:users', chatId]); blocked++; }  // blocked the bot
        else if (!r.ok) failed++;
        else sent++;
      } catch { failed++; }
      await sleep(REMIND_GAP_MS);
    }

    const nextCursor = start + slice.length >= mine.length ? 0 : start + slice.length;
    await upstash(['SET', cursorKey, String(nextCursor)]);
    await upstash(['EXPIRE', `remind:day:${today}`, String(RM_DAY_TTL)]);
    return res.status(200).json({ ok: true, slot, day: today,
      audience: all.length, inSlot: mine.length, otherSlot, from: start,
      processed: slice.length, sent, alreadyIn, optedOut, dupe, blocked, failed, nextCursor });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Schedulers hit this with GET + `Authorization: Bearer <secret>`. Vercel
  // Cron carries CRON_SECRET; Hobby allows only one cron a day, so the other
  // two windows are driven externally with REMIND_SECRET. Either is accepted,
  // and both are compared in constant time. Anything else on GET is refused so
  // this can never be used to blast messages.
  if (req.method === 'GET') {
    const given = String(req.headers.authorization || '');
    const ok = [process.env.CRON_SECRET, process.env.REMIND_SECRET]
      .filter(Boolean)
      .some((sec) => safeEq(given, `Bearer ${sec}`));
    if (!ok) return res.status(401).json({ error: 'Unauthorized' });
    const slot = (req.query && req.query.slot) != null ? req.query.slot
      : (() => { try { return new URL(req.url, 'http://x').searchParams.get('slot'); } catch { return null; } })();
    return runCheckinReminder(res, slot, req.headers['x-vercel-cron-schedule']);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const user = verifyTelegram(body.initData);
  if (!user) return res.status(401).json({ error: 'Telegram authentication failed' });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const text = String(body.text || '').slice(0, 500);
  if (!text) return res.status(400).json({ error: 'text required' });

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: user.id, text: escHtml(text), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: process.env.WEBAPP_URL ? { inline_keyboard: [[{ text: '🚀 Open KolonoEX', web_app: { url: process.env.WEBAPP_URL } }]] } : undefined }),
    });
  } catch (e) { /* best-effort */ }
  return res.status(200).json({ ok: true });
};

module.exports.reminderText = reminderText;
module.exports.userSlot = userSlot;
module.exports.resolveSlot = resolveSlot;
module.exports.slotForHour = slotForHour;
module.exports.appId = appId;
module.exports.REMIND_SLOTS = REMIND_SLOTS;
module.exports.SLOT_HOURS = SLOT_HOURS;
