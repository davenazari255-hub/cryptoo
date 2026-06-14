// Verifies Telegram WebApp initData so the server can trust the user id.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// Required env: TELEGRAM_BOT_TOKEN
const crypto = require('crypto');

// Returns { id, username, first_name } for a valid initData string, else null.
function verifyTelegram(initData) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !initData || typeof initData !== 'string') return null;

  let params;
  try { params = new URLSearchParams(initData); } catch { return null; }

  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  // Build the data-check-string: keys sorted, "key=value" joined by \n.
  const pairs = [];
  for (const [k, v] of params) pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  // Constant-time compare.
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  // Optional freshness check: reject initData older than 24h.
  const authDate = parseInt(params.get('auth_date'), 10);
  if (authDate && Date.now() / 1000 - authDate > 86400) return null;

  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return null;
    return { id: user.id, username: user.username || null, first_name: user.first_name || null };
  } catch {
    return null;
  }
}

// Resolves the trusted userId string used as the DB key, from a request body
// that carries `initData`. Returns null if verification fails.
function userIdFromReq(body) {
  const u = verifyTelegram(body && body.initData);
  return u ? `tg_${u.id}` : null;
}

module.exports = { verifyTelegram, userIdFromReq };
