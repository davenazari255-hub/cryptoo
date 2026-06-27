// Verifies social task completion server-side. TG-authed.
//   action 'channel' → checks (via the bot) whether the user is a member of the
//   KolonoEX Telegram channel using getChatMember. The bot MUST be an admin of
//   that channel for this to work. Self-contained for reliable Vercel bundling.
// Required env: TELEGRAM_BOT_TOKEN, UPSTASH_REDIS_REST_URL/TOKEN.
// Optional env: TG_CHANNEL (defaults to '@KolonoEX').
const crypto = require('crypto');

async function upstash(args) {
  const URL = process.env.UPSTASH_REDIS_REST_URL, TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!URL || !TOKEN) return null; // best-effort: verification still returns the live result
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    return data && !data.error ? data.result : null;
  } catch { return null; }
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
  try { const u = JSON.parse(params.get('user') || 'null'); return u && u.id ? u : null; } catch { return null; }
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

  const action = String(body.action || '');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'Bot not configured' });

  try {
    if (action === 'channel') {
      const channel = process.env.TG_CHANNEL || '@KolonoEX';
      const url = `https://api.telegram.org/bot${token}/getChatMember`
        + `?chat_id=${encodeURIComponent(channel)}&user_id=${encodeURIComponent(user.id)}`;
      const r = await fetch(url);
      const d = await r.json().catch(() => null);
      // If the bot isn't an admin of the channel Telegram returns ok:false here.
      if (!d || !d.ok || !d.result) {
        return res.status(200).json({ ok: true, joined: false, error: (d && d.description) || 'cannot verify' });
      }
      const st = d.result.status;
      const joined = st === 'creator' || st === 'administrator' || st === 'member'
        || (st === 'restricted' && d.result.is_member === true);
      if (joined) await upstash(['SET', `task:tgchannel:${userId}`, '1']); // remember (best-effort)
      return res.status(200).json({ ok: true, joined });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};
