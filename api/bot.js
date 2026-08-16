// Telegram bot webhook. Receives bot updates (messages/commands sent INSIDE the
// bot chat — not the mini app) and:
//   • /start  → records the user as a "bot starter" (unique) + welcomes them.
//   • /stats  → admin-only: replies with how many people have started the bot.
// Secured by a secret token header (set when registering the webhook), so only
// Telegram can post here. Self-contained for reliable Vercel bundling.
// Required env: TELEGRAM_BOT_TOKEN, UPSTASH_REDIS_REST_URL/TOKEN,
//               TELEGRAM_WEBHOOK_SECRET. Optional: WEBAPP_URL, ADMIN_IDS.
const crypto = require('crypto');

const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Constant-time string compare (avoids leaking the secret via response timing).
function safeEqual(a, b) {
  const A = Buffer.from(String(a == null ? '' : a));
  const B = Buffer.from(String(b == null ? '' : b));
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch { return false; }
}

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

// JSON.parse that never throws — mirrors the helper used across api/sync.js.
const parseJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };

// Credit the 15 USDT Stars-bonus coupon after Telegram confirms a paid invoice.
// Called from the webhook on a `successful_payment` message. Server-side only:
// the client never touches this, and the telegram_payment_charge_id makes it
// idempotent so a retried webhook can't mint the coupon twice.
async function creditStarsBonus(msg) {
  try {
    const sp = msg && msg.successful_payment;
    if (!sp) return;
    // Stars payments are always in the XTR currency. Anything else is not a
    // Stars purchase and must never mint the bonus.
    if (sp.currency !== 'XTR') return;

    const chatId = msg.chat && msg.chat.id;
    const payload = String(sp.invoice_payload || '');
    const chargeId = sp.telegram_payment_charge_id;
    if (!chargeId) return;

    // Payload format we send from the invoice: stars_bonus:<taskId>:<tgUserId>
    const parts = payload.split(':');
    if (parts[0] !== 'stars_bonus') return;
    const taskId = parts[1] || 'starsbonus';
    const tgUserId = parts[2] || (msg.from && msg.from.id);
    if (!tgUserId) return;
    // The redis user id used everywhere else (api/balance.js, api/sync.js).
    const userId = 'tg_' + tgUserId;

    // Idempotency: the charge id is the one-shot guard. SADD returns 0 when the
    // charge was already recorded, meaning we already credited this payment.
    const first = await upstash(['SADD', 'stars:charges:' + userId, chargeId]);
    if (first === 0) return;

    // Issue the bonus as a coupon, matching the shape api/sync.js claimTask uses.
    const STARS_BONUS_USDT = 15;
    const now = Date.now();
    const coupon = {
      id: 'c_stars_' + String(taskId).slice(0, 20) + '_' + now.toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      src: 'stars', srcId: taskId,
      title: 'Stars Bonus',
      amount: STARS_BONUS_USDT,
      at: now, exp: now + 7 * 24 * 60 * 60 * 1000, status: 'new',
    };
    const list = parseJSON(await upstash(['GET', `coupons:${userId}`])) || [];
    const next = [coupon].concat(Array.isArray(list) ? list : []).slice(0, 50);
    await upstash(['SET', `coupons:${userId}`, JSON.stringify(next)]);

    // Confirm to the user in the bot chat.
    await tgSend(chatId,
      `🎉 <b>Payment received!</b>\n\nYour <b>${STARS_BONUS_USDT} USDT</b> bonus coupon is ready — open KolonoEX ▸ Tasks ▸ Coupon Center to activate it.`);
  } catch (e) { /* never throw — Telegram would retry the webhook forever */ }
}

module.exports = async function handler(req, res) {
  // Telegram only ever POSTs updates here.
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify the secret token Telegram echoes back on every webhook call.
  // FAIL CLOSED: without a configured secret this endpoint is unauthenticated,
  // and its body is trusted to identify the sender (msg.from.id is checked
  // against the admin allowlist below). An unset secret previously skipped the
  // check entirely, letting anyone POST a forged admin update.
  const want = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!want) return res.status(503).json({ error: 'Webhook secret not configured' });
  if (!safeEqual(req.headers['x-telegram-bot-api-secret-token'], want)) {
    return res.status(401).json({ error: 'bad secret' });
  }

  const update = req.body || {};

  // ── Telegram Stars payments ──
  // A pre_checkout_query must be answered within seconds or the payment fails.
  // We approve every Stars invoice we issued; final crediting is gated on the
  // successful_payment update below.
  if (update.pre_checkout_query) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    try {
      await fetch(`https://api.telegram.org/bot${token}/answerPreCheckoutQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true }),
      });
    } catch (e) { /* ignore */ }
    return res.status(200).json({ ok: true });
  }

  // Only fresh messages — an edited message would otherwise re-run its command
  // (re-incrementing counters, re-triggering /stats) every time it is edited.
  const msg = update.message || null;
  // A successful Stars payment arrives as a message carrying successful_payment
  // (and NO .text). Handle it before the text guard below drops it.
  if (msg && msg.successful_payment) { await creditStarsBonus(msg); return res.status(200).json({ ok: true }); }
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
