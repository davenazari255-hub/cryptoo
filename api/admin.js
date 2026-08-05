// Admin API for managing withdrawal requests. Protected by ADMIN_SECRET (web
// admin.html) OR a verified Telegram admin (the mini app, owner accounts).
// Actions: list (pending), decide (approve | reject | paid).
// reject refunds the held balance back to the user. Self-contained for Vercel.
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

// Verify a Telegram WebApp initData string and return the user (or null).
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
  try { const u = JSON.parse(params.get('user') || 'null'); return (u && u.id) ? u : null; } catch { return null; }
}

// Allowlist of admin Telegram numeric IDs: built-in owner(s) + ADMIN_IDS env
// (comma-separated). The mini app authenticates admins via verified initData.
function adminIds() {
  const env = String(process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return new Set(['5664533861', ...env]);
}
function isTelegramAdmin(initData) {
  const u = verifyTelegram(initData);
  return !!u && adminIds().has(String(u.id));
}

// Push a message into the user's bot chat (outside the mini app). Best-effort.
async function tgSend(userId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !userId) return;
  const chatId = String(userId).startsWith('tg_') ? String(userId).slice(3) : String(userId);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: process.env.WEBAPP_URL ? { inline_keyboard: [[{ text: '🚀 Open KolonoEX', web_app: { url: process.env.WEBAPP_URL } }]] } : undefined }),
    });
  } catch (e) { /* ignore */ }
}

// ── shared partner-commission block ───────────────────────────────────────────
// This block is duplicated verbatim in api/admin.js, because every file in api/
// is its own Vercel bundle and cross-directory imports were unreliable here.
// test_commission.js asserts the two copies are byte-identical, so they cannot
// drift — a drifting money function is exactly how the 150-USDT coupon got
// clamped to 100 earlier in this project.
const SRC_LABEL = { deposit: 'deposit', admin: 'admin credit' };
const SRC_VERB = { deposit: 'deposited', admin: 'was credited' };

// How a referred user is named back to their partner. Falls back to a neutral
// label rather than exposing the raw user id.
async function referredLabel(userId) {
  let prof = null;
  try { prof = JSON.parse(await upstash(['GET', `profile:${userId}`])); } catch {}
  const name = prof && prof.name ? String(prof.name).slice(0, 40) : null;
  const user = prof && prof.username ? String(prof.username).slice(0, 40) : null;
  if (name && user) return `${name} (@${user})`;
  if (name) return name;
  if (user) return `@${user}`;
  return 'a referred user';
}

// Credit a partner a percentage of a referred user's deposit.
async function payPartnerCommission(userId, amount, source) {
  const code = await upstash(['GET', `ref:partner:${userId}`]);
  if (!code) return;
  const owner = await upstash(['GET', `partner:owner:${code}`]);
  if (!owner) return;
  let pct = 0;
  const cfgRaw = await upstash(['GET', `partner:cfg:${code}`]);
  try { const c = JSON.parse(cfgRaw); if (c && isFinite(parseFloat(c.depositPct))) pct = parseFloat(c.depositPct); } catch {}

  // Volume is recorded even at 0% so the partner's list still shows what their
  // referrals deposited, and so raising the rate later has history behind it.
  await upstash(['HINCRBYFLOAT', `partner:vol:${code}`, userId, amount]);
  await upstash(['HINCRBY', `partner:cnt:${code}`, userId, 1]);

  if (!(pct > 0)) return;
  const commission = Math.round(amount * (pct / 100) * 100) / 100;
  if (!(commission > 0)) return;

  await upstash(['INCRBYFLOAT', `bal:${owner}`, commission]);
  await upstash(['INCRBYFLOAT', `partner:earned:${code}`, commission]);
  // Commission is real earned money, unlike paper trading gains. Withdrawals are
  // capped by what a user actually funded (see api/withdraw.js), so without this
  // the commission sat in the balance and could never be taken out.
  await upstash(['INCRBYFLOAT', `payout:earned:${owner}`, commission]);
  // Per-referral ledger. The sorted set gives the ranking for free.
  await upstash(['ZINCRBY', `partner:board:${code}`, commission, userId]);

  const who = await referredLabel(userId);
  await upstash(['LPUSH', `ledger:${owner}`, JSON.stringify({ usd: commission, coin: 'PARTNER',
    note: `Partner commission ${pct}% \u00b7 ${who} \u00b7 $${amount} ${SRC_LABEL[source] || SRC_LABEL.deposit}`, at: Date.now() })]);
  await upstash(['LTRIM', `ledger:${owner}`, 0, 99]);
  await upstash(['LPUSH', `cmd:${owner}`, JSON.stringify({ type: 'message', kind: 'referral',
    title: 'Partner commission \u{1F91D}',
    text: `${who} ${SRC_VERB[source] || SRC_VERB.deposit} $${amount} \u2014 you earned $${commission} (${pct}%). It is in your withdrawable balance.` })]);
  await upstash(['LTRIM', `cmd:${owner}`, 0, 99]);
  await tgSend(owner, `\u{1F91D} <b>Partner commission</b>\n\n<b>${escHtml(who)}</b> ${SRC_VERB[source] || SRC_VERB.deposit} <b>$${amount}</b>.`
    + `\nYou earned <b>$${commission}</b> (${pct}%) \u2014 added to your withdrawable balance.`);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.ADMIN_SECRET;
  const body = req.body || {};
  const secretOk = !!secret && body.secret === secret;
  const tgOk = !!body.initData && isTelegramAdmin(body.initData);
  if (!secretOk && !tgOk) return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (body.action === 'list') {
      const ids = (await upstash(['LRANGE', 'wd:pending', 0, 199])) || [];
      let items = [];
      if (ids.length) items = (await upstash(['MGET', ...ids.map((id) => `wd:item:${id}`)])) || [];
      const pending = items.map(parseJSON).filter(Boolean);
      return res.status(200).json({ pending });
    }

    // ── User management ──
    if (body.action === 'users') {
      const ids = (await upstash(['SMEMBERS', 'users'])) || [];
      if (!ids.length) return res.status(200).json({ users: [] });
      const [profiles, bals, bans, refs] = await Promise.all([
        upstash(['MGET', ...ids.map((id) => `profile:${id}`)]),
        upstash(['MGET', ...ids.map((id) => `bal:${id}`)]),
        upstash(['MGET', ...ids.map((id) => `banned:${id}`)]),
        upstash(['MGET', ...ids.map((id) => `ref:count:${id}`)]),
      ]);
      const users = ids.map((id, i) => {
        const p = parseJSON(profiles[i]) || {};
        return {
          userId: id, username: p.username || null, name: p.name || null,
          joinedAt: p.joinedAt || null, lastSeen: p.lastSeen || null,
          balance: parseFloat(bals[i]) || 0, equity: p.equity || 0, bonus: p.bonus || 0,
          positions: (p.positions || []).length, openOrders: (p.openOrders || []).length,
          referrals: parseInt(refs[i], 10) || 0,
          banned: !!bans[i],
        };
      }).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      return res.status(200).json({ users });
    }

    if (body.action === 'deposits') {
      const rows = (await upstash(['LRANGE', 'deposits:all', 0, 199])) || [];
      const deposits = rows.map(parseJSON).filter(Boolean);
      return res.status(200).json({ deposits });
    }

    if (body.action === 'user') {
      const id = String(body.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      const [profile, bal, banned, wdIds, ledger, refCount, refBy] = await Promise.all([
        upstash(['GET', `profile:${id}`]),
        upstash(['GET', `bal:${id}`]),
        upstash(['GET', `banned:${id}`]),
        upstash(['LRANGE', `wd:user:${id}`, 0, 29]),
        upstash(['LRANGE', `ledger:${id}`, 0, 29]),
        upstash(['GET', `ref:count:${id}`]),
        upstash(['GET', `ref:by:${id}`]),
      ]);
      let withdrawals = [];
      if (wdIds && wdIds.length) {
        const items = await upstash(['MGET', ...wdIds.map((w) => `wd:item:${w}`)]);
        withdrawals = (items || []).map(parseJSON).filter(Boolean);
      }
      return res.status(200).json({
        profile: parseJSON(profile) || { userId: id },
        balance: parseFloat(bal) || 0,
        banned: !!banned,
        withdrawals,
        deposits: (ledger || []).map(parseJSON).filter(Boolean),
        referral: { count: parseInt(refCount, 10) || 0, referredBy: refBy || null },
      });
    }

    if (body.action === 'adjust') {
      const id = String(body.id || '');
      const amount = Math.round((parseFloat(body.amount) || 0) * 100) / 100;
      // Was missing: the notification below reads `note`, and without this the
      // handler threw ReferenceError *after* the balance had already moved —
      // money applied, error shown, nobody notified.
      const note = String(body.note || '').trim();
      if (!id || !amount) return res.status(400).json({ error: 'id and non-zero amount required' });
      const newBal = parseFloat(await upstash(['INCRBYFLOAT', `bal:${id}`, amount]));
      if (newBal < 0) { await upstash(['INCRBYFLOAT', `bal:${id}`, -amount]); return res.status(400).json({ error: 'Would make balance negative' }); }
      // A positive admin credit counts as a deposit (so it unlocks withdrawals).
      if (amount > 0) await upstash(['INCRBYFLOAT', `dep:total:${id}`, amount]);
      await upstash(['LPUSH', `ledger:${id}`, JSON.stringify({ usd: amount, coin: 'ADMIN', note: String(body.note || 'Admin adjustment'), at: Date.now() })]);
      await upstash(['LTRIM', `ledger:${id}`, 0, 99]);
      // The bonus action has always notified; this one only wrote a ledger row,
      // so money appeared in a user's balance with no explanation. Both channels
      // now, like every other money event.
      const up = amount > 0;
      const abs = Math.abs(amount);
      await upstash(['LPUSH', `cmd:${id}`, JSON.stringify({ type: 'message', kind: 'deposit',
        title: up ? 'Balance credited \u{1F4B0}' : 'Balance adjusted',
        text: (up ? '$' + abs + ' has been added to your balance.' : '$' + abs + ' has been deducted from your balance.')
          + (note ? '\n\n' + note : '') })]);
      await upstash(['LTRIM', `cmd:${id}`, 0, 99]);
      await tgSend(id, `\u{1F4B0} <b>Balance ${up ? '+' : '\u2212'}$${abs}</b> has been ${up ? 'added to' : 'deducted from'} your KolonoEX balance.`
        + `${note ? `\n\n\u{1F4DD} ${escHtml(note)}` : ''}`);
      // An admin credit already counts as a deposit everywhere else — it raises
      // dep:total, unlocks withdrawals and drives the deposit tiers — so it must
      // reach the partner too, otherwise a partner-referred user credited by
      // hand was invisible in the partner's own list. Opt out per adjustment
      // with payCommission:false, for corrections and refunds.
      let commissionPaid = false;
      if (amount > 0 && body.payCommission !== false) {
        try { await payPartnerCommission(id, amount, 'admin'); commissionPaid = true; }
        catch (e) { /* best-effort: never fails the adjustment itself */ }
      }
      return res.status(200).json({ ok: true, balance: newBal, commissionPaid });
    }

    if (body.action === 'ban' || body.action === 'unban') {
      const id = String(body.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      if (body.action === 'ban') await upstash(['SET', `banned:${id}`, '1']);
      else await upstash(['DEL', `banned:${id}`]);
      return res.status(200).json({ ok: true, banned: body.action === 'ban' });
    }

const DEFAULT_BANNERS = [
  { id: 'partner', img: 'poster-partner.jpg', tag: 'Partner Program', accent: 'green',
    title: 'Run a crypto channel?', sub: 'Get paid for your audience.',
    hi: '', foot: 'Commission on every trader you bring in',
    cta: 'Apply as a partner', action: 'partner', link: '', on: true },
  { id: 'bonus', img: 'poster-bonus.jpg', tag: 'Coupon Center', accent: 'gold',
    title: 'Every reward is a coupon.', sub: 'Collect them. Activate them. Trade them.',
    hi: '125\u00d7', foot: 'Futures margin \u00b7 up to 125\u00d7 leverage',
    cta: 'Open Coupon Center', action: 'coupons', link: '', on: true },
];

// Whatever the admin saved, normalised so a bad row cannot break the client.
function cleanBanners(list) {
  const ACTIONS = ['partner', 'coupons', 'invite', 'tasks', 'assets', 'trade', 'futures', 'link', 'none'];
  const ACCENTS = ['green', 'gold', 'purple'];
  // Either an absolute https URL or a same-origin image file. Deliberately
  // strict: `javascript:` and `data:` are obvious, but a protocol-relative
  // `//evil.com/a.jpg` also loads from someone else's origin, and a bare
  // `https?://` prefix test would let a quote-breaking value through.
  const cleanImg = (s) => { const v = String(s || '').trim().slice(0, 300);
    if (/^https:\/\/[^\s"'<>\\]+$/i.test(v)) return v;
    if (/^[\w.\-]+(\/[\w.\-]+)*\.(jpe?g|png|webp|avif|gif)$/i.test(v)) return v;
    return ''; };
  const cleanLink = (s) => { const v = String(s || '').trim().slice(0, 300);
    return /^(https?:\/\/|tg:\/\/)/i.test(v) ? v : ''; };
  return (Array.isArray(list) ? list : []).slice(0, 8).map((b, i) => ({
    id: String(b.id || ('b' + i)).slice(0, 24).replace(/[^a-zA-Z0-9_]/g, '') || ('b' + i),
    img: cleanImg(b.img),
    tag: String(b.tag || '').slice(0, 28),
    accent: ACCENTS.includes(b.accent) ? b.accent : 'green',
    title: String(b.title || '').slice(0, 80),
    sub: String(b.sub || '').slice(0, 90),
    hi: String(b.hi || '').slice(0, 18),
    foot: String(b.foot || '').slice(0, 90),
    cta: String(b.cta || 'Learn more').slice(0, 32),
    action: ACTIONS.includes(b.action) ? b.action : 'none',
    link: cleanLink(b.link),
    on: b.on !== false,
  })).filter((b) => b.img || b.title);
}

    // ── Banner management (config:banners) ──
    if (body.action === 'getBanners') {
      const raw = await upstash(['GET', 'config:banners']);
      const parsed = parseJSON(raw);
      return res.status(200).json({ banners: Array.isArray(parsed) ? cleanBanners(parsed) : DEFAULT_BANNERS });
    }
    if (body.action === 'saveBanners') {
      if (!Array.isArray(body.banners)) return res.status(400).json({ error: 'banners array required' });
      const clean = cleanBanners(body.banners);
      await upstash(['SET', 'config:banners', JSON.stringify(clean)]);
      return res.status(200).json({ ok: true, banners: clean });
    }
    if (body.action === 'resetBannersConfig') {
      await upstash(['DEL', 'config:banners']);
      return res.status(200).json({ ok: true, banners: DEFAULT_BANNERS });
    }

    // ── Task management (config:tasks) ──
    const DEFAULT_TASKS = [
      { id: 'welcome', icon: 'ti-gift', title: 'Welcome Bonus', desc: 'Sign in to KolonoEX', reward: 10, metric: 'always', target: 0, go: 'home' },
      { id: 'deposit', icon: 'ti-wallet', title: 'Net Deposit', desc: 'Deposit a total of 100 USDT', reward: 10, metric: 'deposit', target: 100, go: 'assets' },
      { id: 'spot', icon: 'ti-arrows-exchange', title: 'First Spot Trade', desc: 'Trade 100 USDT volume in Spot', reward: 5, metric: 'spotVol', target: 100, go: 'trade' },
      { id: 'futures', icon: 'ti-trending-up', title: 'First Futures Trade', desc: 'Trade 20,000 USDT volume in Futures', reward: 15, metric: 'futVol', target: 20000, go: 'futures' },
      { id: 'tgchannel', icon: 'ti-brand-telegram', title: 'Join our Telegram', desc: 'Join the @KolonoEX channel', reward: 0.5, metric: 'tgChannel', target: 0, go: 'social', link: 'https://t.me/KolonoEX' },
      { id: 'xfollow', icon: 'ti-brand-x', title: 'Follow us on X', desc: 'Follow @KolonoEX on X', reward: 0.5, metric: 'xFollow', target: 0, go: 'social', link: 'https://x.com/KolonoEX' },
    ];
    if (body.action === 'getTasks') {
      const raw = await upstash(['GET', 'config:tasks']);
      const tasks = parseJSON(raw);
      return res.status(200).json({ tasks: Array.isArray(tasks) && tasks.length ? tasks : DEFAULT_TASKS });
    }
    if (body.action === 'saveTasks') {
      const tasks = Array.isArray(body.tasks) ? body.tasks : null;
      if (!tasks) return res.status(400).json({ error: 'tasks array required' });
      const ALLOWED_METRICS = ['always', 'deposit', 'spotVol', 'futVol', 'referral', 'tgChannel', 'xFollow'];
      // Only allow safe http(s)/tg links for the social "Go" button.
      const cleanLink = (s) => { const v = String(s || '').trim().slice(0, 200); return /^(https?:\/\/|tg:\/\/)/i.test(v) ? v : ''; };
      const clean = tasks.slice(0, 12).map((t, i) => ({
        id: String(t.id || ('task' + i)).slice(0, 24).replace(/[^a-zA-Z0-9_]/g, ''),
        icon: String(t.icon || 'ti-gift').slice(0, 40),
        title: String(t.title || 'Task').slice(0, 60),
        desc: String(t.desc || '').slice(0, 120),
        reward: Math.max(0, Math.round((parseFloat(t.reward) || 0) * 100) / 100),
        metric: ALLOWED_METRICS.includes(t.metric) ? t.metric : 'always',
        target: Math.max(0, parseFloat(t.target) || 0),
        go: ['home', 'assets', 'trade', 'futures', 'invite', 'social'].includes(t.go) ? t.go : 'home',
        link: cleanLink(t.link),
      })).filter((t) => t.id);
      await upstash(['SET', 'config:tasks', JSON.stringify(clean)]);
      return res.status(200).json({ ok: true, tasks: clean });
    }
    if (body.action === 'resetTasksConfig') {
      await upstash(['DEL', 'config:tasks']);
      return res.status(200).json({ ok: true, tasks: DEFAULT_TASKS });
    }

    // Reset a user. mode 'tasks' clears only task/check-in progress (a client
    // command). mode 'full' wipes the server balance, deposit total and ledger
    // too, then tells the client to reset its local app to a fresh state.
    if (body.action === 'reset') {
      const id = String(body.id || '');
      const mode = body.mode === 'full' ? 'full' : 'tasks';
      if (!id) return res.status(400).json({ error: 'id required' });
      if (mode === 'full') {
        // Wipe server-side balances/state so the client reconciles to zero.
        // Reward state is server-owned now, so it must be cleared here too or
        // the client would immediately re-adopt the old claims on next sync.
        await upstash(['DEL', `bal:${id}`, `dep:total:${id}`, `ledger:${id}`, `seen:${id}`,
          `task:claimed:${id}`, `checkin:${id}`, `bonus:${id}`, `vol:spot:${id}`, `vol:fut:${id}`,
          // reward state introduced with the Coupon Center
          `coupons:${id}`, `coupon:used:${id}`, `pot:${id}`, `rpot:${id}`, `dep:tiers:${id}`,
          // withdrawal allowance earned as partner commission — it tracks bal:,
          // so a full wipe that zeroes the balance must zero this too
          `payout:earned:${id}`]);
        await upstash(['LPUSH', `cmd:${id}`, JSON.stringify({ type: 'resetAccount' })]);
      } else {
        // Task/check-in progress lives server-side; clear it alongside the
        // client-side command so the reset actually takes effect.
        //
        // `bonus:` is deliberately NOT cleared. It is a balance, not progress:
        // it holds coupons the user already activated plus anything an admin
        // granted by hand, and the panel promises "Balances and positions are
        // kept". Wiping it here destroyed money the user had legitimately
        // banked. Only the earning slate is reset — including unactivated
        // coupons and the collecting pot, so nothing can be claimed twice.
        await upstash(['DEL', `task:claimed:${id}`, `checkin:${id}`,
          `vol:spot:${id}`, `vol:fut:${id}`, `task:tgchannel:${id}`,
          `coupons:${id}`, `coupon:used:${id}`, `pot:${id}`, `rpot:${id}`, `dep:tiers:${id}`]);
        await upstash(['LPUSH', `cmd:${id}`, JSON.stringify({ type: 'resetTasks' })]);
      }
      await upstash(['LTRIM', `cmd:${id}`, 0, 99]);
      await tgSend(id, mode === 'full'
        ? '♻️ <b>Account reset</b>\n\nYour KolonoEX account has been reset by an admin. Open the app for a fresh start.'
        : '♻️ <b>Tasks reset</b>\n\nYour tasks and daily check-in have been reset by an admin.');
      return res.status(200).json({ ok: true, mode });
    }

    // Adjust the user's bonus balance (with an optional note). Delivered to the
    // app via a command and pushed to the user's bot chat.
    if (body.action === 'bonus') {
      const id = String(body.id || '');
      const amount = Math.round((parseFloat(body.amount) || 0) * 100) / 100;
      const note = String(body.note || '').trim();
      if (!id || !amount) return res.status(400).json({ error: 'id and non-zero amount required' });
      // The bonus balance is server-owned, so apply it here — a client-only
      // command would be reverted by the next sync reconciliation. Clamped at 0.
      const nb = parseFloat(await upstash(['INCRBYFLOAT', `bonus:${id}`, amount]));
      await upstash(['SET', `bonus:${id}`, String(nb >= 0 ? Math.round(nb * 100) / 100 : 0)]);
      await upstash(['LPUSH', `cmd:${id}`, JSON.stringify({ type: 'adjustBonus', amount, note, title: amount > 0 ? 'Bonus added 🎁' : 'Bonus updated' })]);
      await upstash(['LTRIM', `cmd:${id}`, 0, 99]);
      const sign = amount > 0 ? '+' : '−';
      await tgSend(id, `🎁 <b>Bonus ${sign}$${Math.abs(amount)}</b> has been ${amount > 0 ? 'added to' : 'deducted from'} your account.${note ? `\n\n📝 ${escHtml(note)}` : ''}`);
      return res.status(200).json({ ok: true });
    }

    // Queue a trade command for the user's app to apply on next sync.
    if (body.action === 'command') {
      const id = String(body.id || '');
      const cmd = body.command;
      const valid = cmd && ['closePosition', 'cancelOrder', 'editPosition', 'message'].includes(cmd.type);
      if (!id || !valid) return res.status(400).json({ error: 'id and a valid command required' });
      await upstash(['LPUSH', `cmd:${id}`, JSON.stringify(cmd)]);
      await upstash(['LTRIM', `cmd:${id}`, 0, 99]);
      // Mirror admin messages into the user's bot chat too.
      if (cmd.type === 'message' && cmd.text) await tgSend(id, `📩 <b>Message from KolonoEX</b>\n\n${escHtml(cmd.text)}`);
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'decide') {
      const id = String(body.id || '');
      const decision = String(body.decision || ''); // approve | reject | paid
      if (!id || !['approve', 'reject', 'paid'].includes(decision)) {
        return res.status(400).json({ error: 'id and a valid decision are required' });
      }
      const rec = parseJSON(await upstash(['GET', `wd:item:${id}`]));
      if (!rec) return res.status(404).json({ error: 'Withdrawal not found' });

      if (decision === 'reject') {
        if (rec.status === 'pending' || rec.status === 'approved') {
          await upstash(['INCRBYFLOAT', `bal:${rec.userId}`, rec.amount]); // refund held funds
        }
        rec.status = 'rejected';
      } else if (decision === 'approve') {
        rec.status = 'approved';
      } else if (decision === 'paid') {
        rec.status = 'paid';
      }
      rec.decidedAt = Date.now();
      await upstash(['SET', `wd:item:${id}`, JSON.stringify(rec)]);
      // Keep approved items in the queue (still need paying); drop on paid/reject.
      if (decision !== 'approve') await upstash(['LREM', 'wd:pending', 0, id]);

      // Notify the user: in-app (next sync) + bot push.
      const amtLabel = (rec.coin && rec.coin !== 'USDT' && rec.coinAmount) ? (rec.coinAmount + ' ' + rec.coin) : (rec.amount + ' USDT');
      if (decision === 'reject') {
        // Refund the SAME coin back to the wallet (and absorb the server USD refund).
        await upstash(['LPUSH', `cmd:${rec.userId}`, JSON.stringify({
          type: 'refundWithdraw', coin: rec.coin || 'USDT', coinAmount: rec.coinAmount || null, usd: rec.amount,
          title: 'Withdrawal rejected', text: amtLabel + ' was rejected and returned to your wallet.',
        })]);
        await tgSend(rec.userId, `❌ <b>Withdrawal rejected</b>\n\n<b>${escHtml(amtLabel)}</b> was rejected and returned to your wallet.`);
      } else {
        const msg = decision === 'paid'
          ? { title: 'Withdrawal completed ✅', text: amtLabel + ' has been sent to your ' + rec.network + ' address.', bot: `✅ <b>Withdrawal completed</b>\n\n<b>${escHtml(amtLabel)}</b> has been sent to your ${escHtml(rec.network)} address.` }
          : { title: 'Withdrawal approved', text: amtLabel + ' approved — being sent shortly.', bot: `🔄 <b>Withdrawal approved</b>\n\n<b>${escHtml(amtLabel)}</b> is approved and being processed.` };
        await upstash(['LPUSH', `cmd:${rec.userId}`, JSON.stringify({ type: 'message', kind: 'withdraw', title: msg.title, text: msg.text })]);
        await tgSend(rec.userId, msg.bot);
      }
      await upstash(['LTRIM', `cmd:${rec.userId}`, 0, 99]);

      return res.status(200).json({ ok: true, withdrawal: rec });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};
