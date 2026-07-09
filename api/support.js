// Support chat + tickets. TG-authed for users; admins authed via TG admin
// allowlist OR ADMIN_SECRET. Live chat when an admin is online (heartbeat),
// otherwise messages become tickets answered later. Self-contained for Vercel.
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

const parseJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

// Built-in owner + ADMIN_IDS env (comma-separated).
function adminIds() {
  const env = String(process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return new Set(['5664533861', ...env]);
}

async function tgSend(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN; if (!token || !chatId) return;
  const id = String(chatId).startsWith('tg_') ? String(chatId).slice(3) : String(chatId);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: process.env.WEBAPP_URL ? { inline_keyboard: [[{ text: '🚀 Open KolonoEX', web_app: { url: process.env.WEBAPP_URL } }]] } : undefined }),
    });
  } catch (e) { /* ignore */ }
}

const ONLINE_TTL = 45000;      // an admin heartbeat is "online" for 45s
const HISTORY_CAP = 120;       // messages kept per conversation
const MSG_MAX = 1000;          // max chars per message

// Is any admin currently online? Prunes stale entries first.
async function anyAdminOnline() {
  const now = Date.now();
  try {
    await upstash(['ZREMRANGEBYSCORE', 'support:online', 0, now - ONLINE_TTL]);
    const n = await upstash(['ZCARD', 'support:online']);
    return (parseInt(n, 10) || 0) > 0;
  } catch { return false; }
}

async function pushMessage(userId, msg) {
  await upstash(['LPUSH', `support:msgs:${userId}`, JSON.stringify(msg)]);
  await upstash(['LTRIM', `support:msgs:${userId}`, 0, HISTORY_CAP - 1]);
}
async function getMessages(userId) {
  const rows = (await upstash(['LRANGE', `support:msgs:${userId}`, 0, HISTORY_CAP - 1])) || [];
  return rows.map(parseJSON).filter(Boolean).reverse(); // oldest → newest
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const action = String(body.action || '');
  const secret = process.env.ADMIN_SECRET;
  const tgUser = verifyTelegram(body.initData);
  const isAdmin = (!!secret && body.secret === secret) || (!!tgUser && adminIds().has(String(tgUser.id)));

  try {
    // ───────────── ADMIN ACTIONS ─────────────
    if (action === 'heartbeat') {
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      const who = tgUser ? String(tgUser.id) : 'secret';
      await upstash(['ZADD', 'support:online', Date.now(), who]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'offline') {
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      const who = tgUser ? String(tgUser.id) : 'secret';
      await upstash(['ZREM', 'support:online', who]);
      return res.status(200).json({ ok: true });
    }
    if (action === 'conversations') {
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      const ids = (await upstash(['ZREVRANGE', 'support:index', 0, 99])) || [];
      let metas = [];
      if (ids.length) metas = (await upstash(['MGET', ...ids.map((u) => `support:meta:${u}`)])) || [];
      const conversations = ids.map((u, i) => ({ userId: u, ...(parseJSON(metas[i]) || {}) }));
      return res.status(200).json({ conversations });
    }
    if (action === 'thread') {
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      const userId = String(body.userId || ''); if (!userId) return res.status(400).json({ error: 'userId required' });
      const messages = await getMessages(userId);
      // Mark admin-side read.
      const meta = parseJSON(await upstash(['GET', `support:meta:${userId}`])) || {};
      meta.unreadAdmin = 0; await upstash(['SET', `support:meta:${userId}`, JSON.stringify(meta)]);
      return res.status(200).json({ messages });
    }
    if (action === 'reply') {
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      const userId = String(body.userId || ''); const text = String(body.text || '').slice(0, MSG_MAX).trim();
      if (!userId || !text) return res.status(400).json({ error: 'userId and text required' });
      const at = Date.now();
      const msg = { id: at + '-a', from: 'admin', text, at };
      await pushMessage(userId, msg);
      const meta = parseJSON(await upstash(['GET', `support:meta:${userId}`])) || {};
      meta.lastText = text; meta.lastAt = at; meta.lastFrom = 'admin';
      meta.unreadUser = (parseInt(meta.unreadUser, 10) || 0) + 1; meta.unreadAdmin = 0;
      await upstash(['SET', `support:meta:${userId}`, JSON.stringify(meta)]);
      await upstash(['ZADD', 'support:index', at, userId]);
      // Notify the user: in-app command + bot push.
      await upstash(['LPUSH', `cmd:${userId}`, JSON.stringify({ type: 'supportReply', text, at })]);
      await upstash(['LTRIM', `cmd:${userId}`, 0, 99]);
      await tgSend(userId, `💬 <b>Support replied</b>\n\n${escHtml(text)}`);
      return res.status(200).json({ ok: true, message: msg });
    }

    // ───────────── USER ACTIONS (TG-authed) ─────────────
    if (!tgUser) return res.status(401).json({ error: 'Telegram authentication failed' });
    const userId = `tg_${tgUser.id}`;
    const online = await anyAdminOnline();

    if (action === 'status') {
      // Lightweight: online flag + unread count for the headphones badge.
      const meta = parseJSON(await upstash(['GET', `support:meta:${userId}`])) || {};
      return res.status(200).json({ online, unread: parseInt(meta.unreadUser, 10) || 0 });
    }
    if (action === 'history') {
      const messages = await getMessages(userId);
      const meta = parseJSON(await upstash(['GET', `support:meta:${userId}`])) || {};
      meta.unreadUser = 0; await upstash(['SET', `support:meta:${userId}`, JSON.stringify(meta)]);
      return res.status(200).json({ online, messages });
    }
    if (action === 'send') {
      const text = String(body.text || '').slice(0, MSG_MAX).trim();
      if (!text) return res.status(400).json({ error: 'text required' });
      const at = Date.now();
      const msg = { id: at + '-u', from: 'user', text, at };
      await pushMessage(userId, msg);
      const meta = {
        userId, name: tgUser.first_name || null, username: tgUser.username || null,
        lastText: text, lastAt: at, lastFrom: 'user',
        unreadAdmin: (parseInt((parseJSON(await upstash(['GET', `support:meta:${userId}`])) || {}).unreadAdmin, 10) || 0) + 1,
        unreadUser: 0,
      };
      await upstash(['SET', `support:meta:${userId}`, JSON.stringify(meta)]);
      await upstash(['ZADD', 'support:index', at, userId]);
      // Notify every admin via the bot (so tickets reach them even when offline).
      const note = `🆘 <b>Support message</b>\nFrom: ${escHtml(tgUser.first_name || '')}${tgUser.username ? ' (@' + escHtml(tgUser.username) + ')' : ''}\nID: <code>${tgUser.id}</code>\n\n${escHtml(text)}`;
      for (const aid of adminIds()) { if (aid !== 'secret') await tgSend(aid, note); }
      return res.status(200).json({ ok: true, online, message: msg });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};
