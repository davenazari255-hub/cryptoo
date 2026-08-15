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

// ── Photos ────────────────────────────────────────────────────────────────
// Images are not stored in Redis. They are uploaded to Telegram once (which
// doubles as the notification the admin/user receives in the bot anyway), and
// only the resulting file_id is kept on the message. Rendering goes through the
// signed proxy below, because the raw Telegram file URL contains the bot token.
const IMG_MAX_BYTES = 5 * 1024 * 1024;

function imgKey() {
  return process.env.ADMIN_SECRET || process.env.TELEGRAM_BOT_TOKEN || 'kolonoex';
}
function imgSig(fileId) {
  return crypto.createHmac('sha256', imgKey()).update(String(fileId)).digest('hex').slice(0, 20);
}
function imgUrl(fileId) {
  return `/api/support?action=img&id=${encodeURIComponent(fileId)}&t=${imgSig(fileId)}`;
}
// Accepts the small JPEG the client produced by down-scaling on a canvas.
function parseDataUrl(s) {
  const m = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(s || ''));
  if (!m) return null;
  let buf; try { buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64'); } catch { return null; }
  if (!buf.length || buf.length > IMG_MAX_BYTES) return null;
  return { buf, mime: m[1] === 'image/jpg' ? 'image/jpeg' : m[1] };
}
const chatIdOf = (id) => (String(id).startsWith('tg_') ? String(id).slice(3) : String(id));

// Upload the bytes once; returns the largest file_id Telegram gives back.
async function tgUploadPhoto(chatId, buf, mime, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN; if (!token || !chatId) return null;
  try {
    const fd = new FormData();
    fd.append('chat_id', chatIdOf(chatId));
    if (caption) { fd.append('caption', String(caption).slice(0, 1024)); fd.append('parse_mode', 'HTML'); }
    fd.append('photo', new Blob([buf], { type: mime || 'image/jpeg' }), 'photo.jpg');
    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: fd });
    const d = await r.json();
    const ph = d && d.ok && d.result && d.result.photo;
    return ph && ph.length ? ph[ph.length - 1].file_id : null;
  } catch { return null; }
}
// Re-send an already uploaded photo to another chat — no bytes on the wire.
async function tgSendPhotoId(chatId, fileId, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN; if (!token || !chatId || !fileId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatIdOf(chatId), photo: fileId, caption: caption ? String(caption).slice(0, 1024) : undefined, parse_mode: 'HTML' }),
    });
  } catch { /* ignore */ }
}

const ONLINE_TTL = 45000;      // an admin heartbeat is "online" for 45s
const HISTORY_CAP = 120;       // messages kept per conversation
const MSG_MAX = 1000;          // max chars per message

// Is any admin currently online? Prunes stale entries first.
// "Is any admin online" is a single global fact, not a per-user one, yet it was
// recomputed — two commands — on every request from every user. On a warm
// instance the answer cannot meaningfully change from one second to the next,
// so it is memoised briefly. This is per-instance and deliberately short: the
// worst case is a badge that is a few seconds stale.
let onlineCache = { at: 0, value: false };
const ONLINE_CACHE_MS = 15000;

async function anyAdminOnline() {
  const now = Date.now();
  if (now - onlineCache.at < ONLINE_CACHE_MS) return onlineCache.value;
  try {
    // The stale-entry sweep used to run on every read. It is housekeeping, not
    // a read, and ZCARD over a handful of admins with expired scores is
    // harmless — so it moved to the write path, where an admin actually
    // announces themselves.
    const rows = (await upstash(['ZRANGEBYSCORE', 'support:online', now - ONLINE_TTL, '+inf', 'LIMIT', 0, 1])) || [];
    const value = rows.length > 0;
    onlineCache = { at: now, value };
    return value;
  } catch { return false; }
}

async function pushMessage(userId, msg) {
  await upstash(['LPUSH', `support:msgs:${userId}`, JSON.stringify(msg)]);
  await upstash(['LTRIM', `support:msgs:${userId}`, 0, HISTORY_CAP - 1]);
}
async function getMessages(userId) {
  const rows = (await upstash(['LRANGE', `support:msgs:${userId}`, 0, HISTORY_CAP - 1])) || [];
  return rows.map(parseJSON).filter(Boolean).reverse().map(withImg); // oldest → newest
}
// The stored message only carries the Telegram file_id; the signed URL is
// derived at read time so the signing key can rotate without rewriting history.
function withImg(m) {
  if (m && m.photo) return { ...m, img: imgUrl(m.photo) };
  return m;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Signed image proxy (GET). The Telegram file URL embeds the bot token, so it
  // can never reach the client; the signature stops the endpoint from being an
  // open relay for arbitrary file_ids.
  if (req.method === 'GET') {
    const q = req.query || {};
    if (String(q.action || '') !== 'img') return res.status(405).json({ error: 'Method not allowed' });
    const fileId = String(q.id || ''), sig = String(q.t || '');
    if (!fileId || !sig) return res.status(400).json({ error: 'id and t required' });
    let ok = false;
    try { const a = Buffer.from(imgSig(fileId)), b = Buffer.from(sig);
      ok = a.length === b.length && crypto.timingSafeEqual(a, b); } catch { ok = false; }
    if (!ok) return res.status(403).json({ error: 'Bad signature' });
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return res.status(500).json({ error: 'Bot not configured' });
    try {
      const gf = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
      const gd = await gf.json();
      const path = gd && gd.ok && gd.result && gd.result.file_path;
      if (!path) return res.status(404).json({ error: 'File not found' });
      const fr = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
      if (!fr.ok) return res.status(502).json({ error: 'Fetch failed' });
      const buf = Buffer.from(await fr.arrayBuffer());
      res.setHeader('Content-Type', fr.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
      return res.status(200).send(buf);
    } catch (e) {
      return res.status(500).json({ error: 'Proxy error' });
    }
  }

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
      // Sweep here instead of on every user's read: this fires a few times a
      // minute from one admin, not once per user per poll.
      await upstash(['ZREMRANGEBYSCORE', 'support:online', 0, Date.now() - ONLINE_TTL]);
      onlineCache = { at: 0, value: false };   // let the next read see it at once
      return res.status(200).json({ ok: true });
    }
    if (action === 'offline') {
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      const who = tgUser ? String(tgUser.id) : 'secret';
      await upstash(['ZREM', 'support:online', who]);
      onlineCache = { at: 0, value: false };
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
      const img = body.image ? parseDataUrl(body.image) : null;
      if (body.image && !img) return res.status(400).json({ error: 'Invalid or oversized image' });
      if (!userId || (!text && !img)) return res.status(400).json({ error: 'userId and text or image required' });
      const at = Date.now();
      const msg = { id: at + '-a', from: 'admin', text, at };
      // Upload once to the user's own chat: that upload *is* the notification.
      if (img) {
        const cap = `💬 <b>Support replied</b>${text ? '\n\n' + escHtml(text) : ''}`;
        const fileId = await tgUploadPhoto(userId, img.buf, img.mime, cap);
        if (!fileId) return res.status(502).json({ error: 'Image upload failed' });
        msg.photo = fileId;
      }
      await pushMessage(userId, msg);
      const meta = parseJSON(await upstash(['GET', `support:meta:${userId}`])) || {};
      meta.lastText = text || '📷 Photo'; meta.lastAt = at; meta.lastFrom = 'admin';
      meta.unreadUser = (parseInt(meta.unreadUser, 10) || 0) + 1; meta.unreadAdmin = 0;
      await upstash(['SET', `support:meta:${userId}`, JSON.stringify(meta)]);
      await upstash(['ZADD', 'support:index', at, userId]);
      // Notify the user: in-app command + bot push.
      await upstash(['LPUSH', `cmd:${userId}`, JSON.stringify({ type: 'supportReply', text, at, img: msg.photo ? imgUrl(msg.photo) : undefined })]);
      await upstash(['LTRIM', `cmd:${userId}`, 0, 99]);
      if (!msg.photo) await tgSend(userId, `💬 <b>Support replied</b>\n\n${escHtml(text)}`);
      return res.status(200).json({ ok: true, message: withImg(msg) });
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
      const img = body.image ? parseDataUrl(body.image) : null;
      if (body.image && !img) return res.status(400).json({ error: 'Invalid or oversized image' });
      if (!text && !img) return res.status(400).json({ error: 'text or image required' });
      const at = Date.now();
      const msg = { id: at + '-u', from: 'user', text, at };
      const who = `${escHtml(tgUser.first_name || '')}${tgUser.username ? ' (@' + escHtml(tgUser.username) + ')' : ''}`;
      const note = `🆘 <b>Support message</b>\nFrom: ${who}\nID: <code>${tgUser.id}</code>${text ? '\n\n' + escHtml(text) : ''}`;
      // One upload to the first admin; every other admin gets the file_id.
      const admins = [...adminIds()].filter((a) => a !== 'secret');
      if (img) {
        let fileId = null;
        for (const aid of admins) { fileId = await tgUploadPhoto(aid, img.buf, img.mime, note); if (fileId) break; }
        if (!fileId) return res.status(502).json({ error: 'Image upload failed' });
        msg.photo = fileId;
      }
      await pushMessage(userId, msg);
      const meta = {
        userId, name: tgUser.first_name || null, username: tgUser.username || null,
        lastText: text || '📷 Photo', lastAt: at, lastFrom: 'user',
        unreadAdmin: (parseInt((parseJSON(await upstash(['GET', `support:meta:${userId}`])) || {}).unreadAdmin, 10) || 0) + 1,
        unreadUser: 0,
      };
      await upstash(['SET', `support:meta:${userId}`, JSON.stringify(meta)]);
      await upstash(['ZADD', 'support:index', at, userId]);
      // Notify every admin via the bot (so tickets reach them even when offline).
      if (msg.photo) {
        let first = true;
        for (const aid of admins) { if (first) { first = false; continue; } await tgSendPhotoId(aid, msg.photo, note); }
      } else {
        for (const aid of admins) await tgSend(aid, note);
      }
      return res.status(200).json({ ok: true, online, message: withImg(msg) });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};
