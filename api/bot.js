// Telegram bot webhook. Receives bot updates (messages/commands sent INSIDE the
// bot chat — not the mini app) and:
//   • /start  → records the user as a "bot starter" (unique) + welcomes them.
//   • /stats  → admin-only: replies with how many people have started the bot.
// Secured by a secret token header (set when registering the webhook), so only
// Telegram can post here. Self-contained for reliable Vercel bundling.
// Required env: TELEGRAM_BOT_TOKEN, UPSTASH_REDIS_REST_URL/TOKEN,
//               TELEGRAM_WEBHOOK_SECRET. Optional: WEBAPP_URL, ADMIN_IDS.
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

// Built-in owner + ADMIN_IDS env (comma-separated). Same allowlist used elsewhere.
function adminIds() {
  const env = String(process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return new Set(['5664533861', ...env]);
}

async function tgSend(chatId, text, replyMarkup) {
  const token = process.env.TELEGRAM_BOT_TOKEN; if (!token || !chatId) return;
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  // Attach an "Open" button under every message (caller markup wins, else the app button).
  const fallback = process.env.WEBAPP_URL ? { inline_keyboard: [[{ text: '🚀 Open KolonoEX', web_app: { url: process.env.WEBAPP_URL } }]] } : undefined;
  const markup = replyMarkup || fallback;
  if (markup) payload.reply_markup = markup;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) { /* ignore */ }
}

module.exports = async function handler(req, res) {
  // Telegram only ever POSTs updates here.
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify the secret token Telegram echoes back on every webhook call.
  const want = process.env.TELEGRAM_WEBHOOK_SECRET;
  const got = req.headers['x-telegram-bot-api-secret-token'];
  if (want && got !== want) return res.status(401).json({ error: 'bad secret' });

  const update = req.body || {};
  const msg = update.message || update.edited_message || null;
  // Acknowledge anything we don't handle (callbacks, channel posts, etc.) so
  // Telegram doesn't retry the delivery.
  if (!msg || !msg.from || !msg.text) return res.status(200).json({ ok: true });

  const from = msg.from;
  const chatId = msg.chat && msg.chat.id;
  const userId = String(from.id);
  const text = String(msg.text || '').trim();
  const cmd = text.split(/\s+/)[0].split('@')[0].toLowerCase(); // strip args + @botname

  try {
    if (cmd === '/start') {
      // Track unique starters (count) and total /start presses.
      const isNew = await upstash(['SADD', 'bot:users', userId]); // 1 = first time
      await upstash(['INCR', 'bot:starts:total']);
      if (isNew === 1) {
        // Remember profile basics + first-seen time for the admin report.
        await upstash(['SET', `bot:user:${userId}`, JSON.stringify({
          id: userId, name: from.first_name || null, username: from.username || null, firstAt: Date.now(),
        })]);
      }

      const webapp = process.env.WEBAPP_URL;
      const markup = webapp ? { inline_keyboard: [[{ text: '🚀 Open KolonoEX', web_app: { url: webapp } }]] } : undefined;
      await tgSend(chatId,
        `👋 <b>Welcome to KolonoEX</b>\n\nTrade crypto, deposit & withdraw, invite friends and earn rewards — all inside Telegram.${webapp ? '\n\nTap the button below to open the app.' : ''}`,
        markup);
      return res.status(200).json({ ok: true });
    }

    // Admin-only stats command, answered right here in the bot chat.
    if (cmd === '/stats') {
      if (!adminIds().has(userId)) {
        await tgSend(chatId, '⛔ This command is for admins only.');
        return res.status(200).json({ ok: true });
      }
      const [starters, totalStarts, appUsers] = await Promise.all([
        upstash(['SCARD', 'bot:users']),       // unique people who pressed /start
        upstash(['GET', 'bot:starts:total']),  // total /start presses (incl. repeats)
        upstash(['SCARD', 'users']),           // unique mini-app users (for comparison)
      ]);
      await tgSend(chatId,
        `📊 <b>KolonoEX — Bot Stats</b>\n\n` +
        `👥 Started the bot: <b>${parseInt(starters, 10) || 0}</b>\n` +
        `🔁 Total /start presses: <b>${parseInt(totalStarts, 10) || 0}</b>\n` +
        `📱 Mini-app users: <b>${parseInt(appUsers, 10) || 0}</b>`);
      return res.status(200).json({ ok: true });
    }

    // Any other text: no-op (acknowledge so Telegram stops retrying).
    return res.status(200).json({ ok: true });
  } catch (err) {
    // Never make Telegram retry forever on our own errors — log via the reply.
    return res.status(200).json({ ok: true, error: (err && err.message) || 'unknown' });
  }
};
