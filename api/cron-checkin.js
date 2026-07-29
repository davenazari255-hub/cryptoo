// Daily check-in reminder. Vercel Cron hits this once a day; it messages every
// user who has not checked in yet today via the bot.
//
// Design notes:
//  - Users are walked in slices with a cursor in Redis, so one invocation can
//    never run past the function timeout no matter how large the audience gets.
//    Each run picks up where the last left off and stops at MAX_PER_RUN.
//  - Only `bot:users` is used as the audience: those are chat ids that have
//    actually started the bot, so we are not pushing to people who never opted
//    into messages.
//  - A 403 from Telegram means the user blocked the bot; they are removed from
//    the audience so we stop paying to message them.
//  - `noremind` opt-outs are always honoured.

const MAX_PER_RUN = 220;      // Telegram tolerates ~30 msg/s; this stays well under
const SEND_GAP_MS = 45;       // gentle pacing between sends

async function upstash(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Upstash not configured');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error('Upstash: ' + (data.error || res.status));
  return data.result;
}

const parseJSON = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
const dayKey = (ts) => { const d = ts ? new Date(ts) : new Date(); return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same tier table as api/sync.js — used only to tell the user what today is worth.
const STREAK_TIERS = [{ min: 180, mult: 2 }, { min: 90, mult: 1.75 }, { min: 30, mult: 1.5 }, { min: 7, mult: 1.25 }, { min: 0, mult: 1 }];
const CHECKIN_REWARDS = [0.1, 0.1, 0.1, 0.2, 0.2, 0.2, 1];
const streakMult = (n) => (STREAK_TIERS.find((t) => n >= t.min) || { mult: 1 }).mult;

function buildMessage(st, today, yest) {
  const streak = Math.max(0, parseInt(st && st.streak, 10) || 0);
  const continues = st && st.last === yest;
  const freeze = Math.max(0, parseInt(st && st.freeze, 10) || 0);

  // What they would earn if they check in right now.
  const nextStreak = continues ? streak + 1 : 1;
  const day = ((nextStreak - 1) % 7) + 1;
  const due = Math.round((CHECKIN_REWARDS[day - 1] || 0) * streakMult(nextStreak) * 100) / 100;

  if (continues && streak >= 2) {
    const risk = freeze > 0
      ? `You have ${freeze} ❄️ freeze${freeze > 1 ? 's' : ''} banked, but why spend one?`
      : 'Miss today and it goes back to zero.';
    return `🔥 <b>${streak}-day streak</b>\n\nDay ${day} is waiting — <b>+${due} USDT</b> bonus.\n${risk}`;
  }
  if (continues) {
    return `🎁 <b>Day ${day} is ready</b>\n\nCheck in for <b>+${due} USDT</b> bonus and keep your streak going.`;
  }
  return `🎁 <b>Your daily bonus is waiting</b>\n\nCheck in today for <b>+${due} USDT</b> — then keep the streak alive for bigger rewards.`;
}

module.exports = async function handler(req, res) {
  // Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Refuse anything else
  // so this cannot be used as an open message-blasting endpoint.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!secret || auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN missing' });

  const today = dayKey(), yest = dayKey(Date.now() - 86400000);
  const webapp = process.env.WEBAPP_URL;
  const reply_markup = webapp ? { inline_keyboard: [[{ text: '🎁 Check in now', web_app: { url: webapp } }]] } : undefined;

  let sent = 0, skipped = 0, blocked = 0, failed = 0;

  try {
    const all = (await upstash(['SMEMBERS', 'bot:users'])) || [];
    if (!all.length) return res.status(200).json({ ok: true, audience: 0, sent, skipped });

    all.sort();                                   // stable order so the cursor is meaningful
    const rawCursor = await upstash(['GET', 'cron:checkin:cursor']);
    let start = Math.max(0, parseInt(rawCursor, 10) || 0);
    if (start >= all.length) start = 0;
    const slice = all.slice(start, start + MAX_PER_RUN);

    for (const userId of slice) {
      try {
        const [optOut, raw] = await Promise.all([
          upstash(['SISMEMBER', 'noremind', userId]),
          upstash(['GET', `checkin:${userId}`]),
        ]);
        if (optOut === 1) { skipped++; continue; }

        const st = parseJSON(raw) || { last: '', streak: 0 };
        if (st.last === today) { skipped++; continue; }   // already checked in

        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: userId,
            text: buildMessage(st, today, yest),
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup,
          }),
        });

        if (r.status === 403) {
          // blocked or deactivated — drop them from the audience
          await upstash(['SREM', 'bot:users', userId]);
          blocked++;
        } else if (!r.ok) {
          failed++;
        } else {
          sent++;
        }
      } catch { failed++; }
      await sleep(SEND_GAP_MS);
    }

    const nextCursor = start + slice.length >= all.length ? 0 : start + slice.length;
    await upstash(['SET', 'cron:checkin:cursor', String(nextCursor)]);

    return res.status(200).json({
      ok: true, audience: all.length, from: start, processed: slice.length,
      sent, skipped, blocked, failed, nextCursor,
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};

module.exports.buildMessage = buildMessage;
