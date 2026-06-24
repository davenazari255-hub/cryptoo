// Partner program. Users apply to become partners (channel owners / influencers);
// admins review, approve with a custom deposit-commission % and per-task bonus
// overrides, or reject. Approved partners get a unique invite code (par_<code>).
// TG-authed for users; admins via TG admin allowlist OR ADMIN_SECRET.
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
      body: JSON.stringify({ chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (e) { /* ignore */ }
}

// Make a short, URL-safe code from the numeric TG id + entropy.
function genCode(tgId) {
  const rnd = crypto.randomBytes(3).toString('hex');
  return ('p' + String(tgId).slice(-5) + rnd).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16);
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
    // ───────────── ADMIN ─────────────
    if (action === 'list') {
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      const ids = (await upstash(['LRANGE', 'partner:apps', 0, 199])) || [];
      let apps = [];
      if (ids.length) apps = (await upstash(['MGET', ...ids.map((u) => `partner:me:${u}`)])) || [];
      const partners = apps.map(parseJSON).filter(Boolean);
      // attach live stats
      for (const p of partners) {
        if (p.code) {
          p.refCount = parseInt(await upstash(['GET', `partner:refcount:${p.code}`]), 10) || 0;
          p.earned = parseFloat(await upstash(['GET', `partner:earned:${p.code}`])) || 0;
        }
      }
      return res.status(200).json({ partners });
    }
    if (action === 'approve') {
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      const userId = String(body.userId || ''); if (!userId) return res.status(400).json({ error: 'userId required' });
      const app = parseJSON(await upstash(['GET', `partner:me:${userId}`])); if (!app) return res.status(404).json({ error: 'Application not found' });
      const depositPct = Math.max(0, Math.min(90, parseFloat(body.depositPct) || 0));
      const refBonus = Math.max(0, parseFloat(body.refBonus) || 0);
      const taskRewards = (body.taskRewards && typeof body.taskRewards === 'object') ? body.taskRewards : {};
      let code = app.code || genCode(String(userId).replace('tg_', ''));
      const cfg = { depositPct, refBonus, taskRewards };
      await upstash(['SET', `partner:cfg:${code}`, JSON.stringify(cfg)]);
      await upstash(['SET', `partner:owner:${code}`, userId]);
      app.status = 'approved'; app.code = code; app.cfg = cfg; app.decidedAt = Date.now();
      await upstash(['SET', `partner:me:${userId}`, JSON.stringify(app)]);
      await upstash(['LPUSH', `cmd:${userId}`, JSON.stringify({ type: 'message', kind: 'referral', title: 'Partner approved 🤝', text: `You're now a KolonoEX partner! Deposit commission: ${depositPct}%.` })]);
      await upstash(['LTRIM', `cmd:${userId}`, 0, 99]);
      await tgSend(userId, `🤝 <b>Partner application approved!</b>\n\nYou're now a KolonoEX partner.\n• Deposit commission: <b>${depositPct}%</b>\n• Referral bonus: <b>$${refBonus}</b>\n\nOpen the app → Partner to get your link.`);
      return res.status(200).json({ ok: true, code, cfg });
    }
    if (action === 'reject') {
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      const userId = String(body.userId || ''); if (!userId) return res.status(400).json({ error: 'userId required' });
      const app = parseJSON(await upstash(['GET', `partner:me:${userId}`])); if (!app) return res.status(404).json({ error: 'Application not found' });
      app.status = 'rejected'; app.decidedAt = Date.now();
      await upstash(['SET', `partner:me:${userId}`, JSON.stringify(app)]);
      await upstash(['LPUSH', `cmd:${userId}`, JSON.stringify({ type: 'message', kind: 'message', title: 'Partner application', text: 'Your partner application was not approved this time. Feel free to reapply later.' })]);
      await upstash(['LTRIM', `cmd:${userId}`, 0, 99]);
      await tgSend(userId, '🤝 <b>Partner application update</b>\n\nYour application was not approved this time. You can reapply later.');
      return res.status(200).json({ ok: true });
    }
    if (action === 'update') { // edit an already-approved partner's terms
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      const userId = String(body.userId || ''); const app = parseJSON(await upstash(['GET', `partner:me:${userId}`]));
      if (!app || !app.code) return res.status(404).json({ error: 'Approved partner not found' });
      const depositPct = Math.max(0, Math.min(90, parseFloat(body.depositPct) || 0));
      const refBonus = Math.max(0, parseFloat(body.refBonus) || 0);
      const taskRewards = (body.taskRewards && typeof body.taskRewards === 'object') ? body.taskRewards : (app.cfg ? app.cfg.taskRewards : {});
      const cfg = { depositPct, refBonus, taskRewards };
      await upstash(['SET', `partner:cfg:${app.code}`, JSON.stringify(cfg)]);
      app.cfg = cfg; await upstash(['SET', `partner:me:${userId}`, JSON.stringify(app)]);
      return res.status(200).json({ ok: true, cfg });
    }
    if (action === 'delete') { // remove a partner entirely (revokes their link & terms)
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      const userId = String(body.userId || ''); if (!userId) return res.status(400).json({ error: 'userId required' });
      const app = parseJSON(await upstash(['GET', `partner:me:${userId}`]));
      if (app && app.code) {
        await upstash(['DEL', `partner:cfg:${app.code}`, `partner:owner:${app.code}`, `partner:refcount:${app.code}`, `partner:earned:${app.code}`]);
      }
      await upstash(['DEL', `partner:me:${userId}`]);
      await upstash(['LREM', 'partner:apps', 0, userId]);
      await upstash(['LPUSH', `cmd:${userId}`, JSON.stringify({ type: 'message', kind: 'message', title: 'Partner status removed', text: 'Your partner status has been removed. Your partner link is no longer active.' })]);
      await upstash(['LTRIM', `cmd:${userId}`, 0, 99]);
      await tgSend(userId, '🤝 <b>Partner status removed</b>\n\nYour partner status and link have been deactivated by an admin.');
      return res.status(200).json({ ok: true });
    }

    // ───────────── USER (TG-authed) ─────────────
    if (!tgUser) return res.status(401).json({ error: 'Telegram authentication failed' });
    const userId = `tg_${tgUser.id}`;

    if (action === 'me') {
      const me = parseJSON(await upstash(['GET', `partner:me:${userId}`])) || null;
      if (me && me.code) { me.refCount = parseInt(await upstash(['GET', `partner:refcount:${me.code}`]), 10) || 0; me.earned = parseFloat(await upstash(['GET', `partner:earned:${me.code}`])) || 0; }
      return res.status(200).json({ partner: me });
    }
    if (action === 'apply') {
      const existing = parseJSON(await upstash(['GET', `partner:me:${userId}`]));
      if (existing && existing.status === 'approved') return res.status(400).json({ error: 'You are already a partner' });
      if (existing && existing.status === 'pending') return res.status(400).json({ error: 'Your application is already under review' });
      const channel = String(body.channel || '').slice(0, 120).trim();
      const audience = String(body.audience || '').slice(0, 40).trim();
      const note = String(body.note || '').slice(0, 500).trim();
      if (!channel) return res.status(400).json({ error: 'Channel/handle is required' });
      const app = {
        userId, name: tgUser.first_name || null, username: tgUser.username || null,
        channel, audience, note, status: 'pending', appliedAt: Date.now(),
      };
      await upstash(['SET', `partner:me:${userId}`, JSON.stringify(app)]);
      await upstash(['LREM', 'partner:apps', 0, userId]);
      await upstash(['LPUSH', 'partner:apps', userId]);
      await upstash(['LTRIM', 'partner:apps', 0, 499]);
      const note2 = `🤝 <b>New partner application</b>\nFrom: ${escHtml(tgUser.first_name || '')}${tgUser.username ? ' (@' + escHtml(tgUser.username) + ')' : ''}\nChannel: ${escHtml(channel)}\nAudience: ${escHtml(audience || '—')}\nID: <code>${tgUser.id}</code>${note ? '\n\n' + escHtml(note) : ''}`;
      for (const aid of adminIds()) await tgSend(aid, note2);
      return res.status(200).json({ ok: true, partner: app });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};
