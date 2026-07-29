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


// ── daily check-in reminder (invoked by Vercel Cron, see vercel.json) ────────
// Lives here rather than in its own file because the Hobby plan allows only 12
// Serverless Functions per deployment and api/ is already at the cap.

const REMIND_PER_RUN = 220;   // Telegram tolerates ~30 msg/s; this stays under
const REMIND_GAP_MS = 45;     // gentle pacing between sends

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
async function runCheckinReminder(res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN missing' });

  const today = dayKey(), yest = dayKey(Date.now() - 86400000);
  const webapp = process.env.WEBAPP_URL;
  const reply_markup = webapp ? { inline_keyboard: [[{ text: '\u{1F381} Check in now', web_app: { url: webapp } }]] } : undefined;
  let sent = 0, skipped = 0, blocked = 0, failed = 0;

  try {
    // bot:users only: these chat ids actually started the bot, so we are not
    // pushing to anyone who never opted into messages.
    const all = (await upstash(['SMEMBERS', 'bot:users'])) || [];
    if (!all.length) return res.status(200).json({ ok: true, audience: 0, sent, skipped });

    all.sort();                                     // stable order makes the cursor meaningful
    let start = Math.max(0, parseInt(await upstash(['GET', 'cron:checkin:cursor']), 10) || 0);
    if (start >= all.length) start = 0;
    const slice = all.slice(start, start + REMIND_PER_RUN);

    for (const userId of slice) {
      try {
        const [optOut, raw] = await Promise.all([
          upstash(['SISMEMBER', 'noremind', userId]),
          upstash(['GET', `checkin:${userId}`]),
        ]);
        if (optOut === 1) { skipped++; continue; }

        const st = parseJSON(raw) || { last: '', streak: 0 };
        if (st.last === today) { skipped++; continue; }   // already checked in today

        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: userId, text: reminderText(st, yest),
            parse_mode: 'HTML', disable_web_page_preview: true, reply_markup }),
        });

        if (r.status === 403) { await upstash(['SREM', 'bot:users', userId]); blocked++; }  // blocked the bot
        else if (!r.ok) failed++;
        else sent++;
      } catch { failed++; }
      await sleep(REMIND_GAP_MS);
    }

    const nextCursor = start + slice.length >= all.length ? 0 : start + slice.length;
    await upstash(['SET', 'cron:checkin:cursor', String(nextCursor)]);
    return res.status(200).json({ ok: true, audience: all.length, from: start,
      processed: slice.length, sent, skipped, blocked, failed, nextCursor });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Vercel Cron hits this with GET + `Authorization: Bearer $CRON_SECRET`.
  // Anything else on GET is refused so this can never be used to blast messages.
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET;
    if (!secret || (req.headers.authorization || '') !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return runCheckinReminder(res);
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
