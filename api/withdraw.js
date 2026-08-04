// Withdrawal requests. TG-authed. Creates a PENDING request and atomically
// holds (deducts) the user's real balance. Funds are only sent after an admin
// approves in /admin.html — never automatically. Self-contained for Vercel.
const crypto = require('crypto');

const WD_MIN = 10; // minimum withdrawal in USD/USDT
const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Coins the user may withdraw, and the Binance symbol used to price them.
// USDT is the settlement unit and is always worth exactly 1 USD here.
const WD_COINS = { USDT: null, BTC: 'BTCUSDT', ETH: 'ETHUSDT', BNB: 'BNBUSDT', SOL: 'SOLUSDT', TRX: 'TRXUSDT', TON: 'TONUSDT' };
// Allowed networks per coin — rejects arbitrary client-supplied network strings.
const WD_NETS = {
  USDT: ['TRC20', 'ERC20', 'BEP20'], BTC: ['Bitcoin'], ETH: ['ERC20'],
  BNB: ['BSC'], SOL: ['Solana'], TRX: ['TRON'], TON: ['TON'],
};

// Server-side spot price in USD. NEVER trust a client-supplied price or USD
// value — the USD debited from the balance is derived from this and the
// requested coin amount, so a forged `amount` cannot under-charge a payout.
async function coinPriceUsd(coin) {
  if (coin === 'USDT') return 1;
  const symbol = WD_COINS[coin];
  if (!symbol) return null;
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
    if (!r.ok) return null;
    const d = await r.json();
    const p = parseFloat(d && d.price);
    return isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

async function tgSend(userId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN; if (!token || !userId) return;
  const chatId = String(userId).startsWith('tg_') ? String(userId).slice(3) : String(userId);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: process.env.WEBAPP_URL ? { inline_keyboard: [[{ text: '🚀 Open KolonoEX', web_app: { url: process.env.WEBAPP_URL } }]] } : undefined }),
    });
  } catch (e) { /* ignore */ }
}

// ── Upstash REST (throws on failure — balance ops must be reliable) ──
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

// ── Telegram initData verification ──
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

const parseJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };

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

  try {
    if (await upstash(['GET', `banned:${userId}`])) return res.status(403).json({ error: 'Account suspended' });

    // List this user's own withdrawal history.
    if (body.action === 'list') {
      const ids = (await upstash(['LRANGE', `wd:user:${userId}`, 0, 29])) || [];
      let items = [];
      if (ids.length) items = (await upstash(['MGET', ...ids.map((id) => `wd:item:${id}`)])) || [];
      const withdrawals = items.map(parseJSON).filter(Boolean);
      return res.status(200).json({ withdrawals });
    }

    // Create a withdrawal request.
    const coin = (String(body.coin || 'USDT').trim().toUpperCase()) || 'USDT';
    const network = String(body.network || '').trim();
    const address = String(body.address || '').trim();
    const memo = body.memo ? String(body.memo).trim() : null;

    if (!Object.prototype.hasOwnProperty.call(WD_COINS, coin)) return res.status(400).json({ error: 'Unsupported coin' });
    if (!network) return res.status(400).json({ error: 'Network is required' });
    if (!WD_NETS[coin].includes(network)) return res.status(400).json({ error: `Unsupported network for ${coin}` });
    if (!address || address.length < 16) return res.status(400).json({ error: 'A valid destination address is required' });

    // ── Authoritative amount derivation ──
    // The payout is denominated in `coin`, so the COIN AMOUNT is the source of
    // truth and the USD debit is computed from it at the server-side price.
    // `body.amount` is ignored entirely: trusting it allowed a request to debit
    // $10 while instructing the admin to pay out an arbitrary coin quantity.
    const reqCoinAmt = parseFloat(body.coinAmount != null ? body.coinAmount : body.amount);
    if (!isFinite(reqCoinAmt) || reqCoinAmt <= 0) return res.status(400).json({ error: 'A valid amount is required' });

    const price = await coinPriceUsd(coin);
    if (!price) return res.status(503).json({ error: 'Price feed unavailable, please try again' });

    const amt = Math.round(reqCoinAmt * price * 100) / 100;  // USD actually held/debited
    const coinAmount = String(reqCoinAmt);                    // what the admin will pay out
    if (!(amt >= WD_MIN)) return res.status(400).json({ error: `Minimum withdrawal is $${WD_MIN}` });

    // Gate: a payout must be backed by real money. Two sources qualify —
    // what the user deposited, and what they genuinely earned in cash
    // (partner commission). Paper-traded coin gains never do.
    //
    // payout:earned used to be missing entirely, which made partner commission
    // unspendable: it landed in bal: but the cap below was deposits-only, so a
    // partner who had never deposited could not withdraw a cent of it.
    const depositTotal = parseFloat(await upstash(['GET', `dep:total:${userId}`])) || 0;
    const earnedCash = Math.max(0, parseFloat(await upstash(['GET', `payout:earned:${userId}`])) || 0);
    const allowance = Math.round((depositTotal + earnedCash) * 100) / 100;
    if (allowance < WD_MIN) {
      return res.status(400).json({ error: `You must deposit at least $${WD_MIN} before withdrawing` });
    }
    if (amt > allowance + 1e-9) {
      return res.status(400).json({ error: `Withdrawal exceeds your deposited and earned total ($${allowance})` });
    }

    // Atomically hold the funds: deduct first, then verify we didn't go negative.
    let deducted = false;
    try {
      const newBalStr = await upstash(['INCRBYFLOAT', `bal:${userId}`, -amt]);
      deducted = true;
      const newBal = parseFloat(newBalStr);
      if (!isFinite(newBal) || newBal < -1e-9) {
        await upstash(['INCRBYFLOAT', `bal:${userId}`, amt]); // refund
        return res.status(400).json({ error: 'Insufficient balance' });
      }

      const id = crypto.randomUUID();
      const rec = {
        id, userId, username: user.username || null, name: user.first_name || null,
        coin, coinAmount, network, address, memo, amount: amt,
        priceUsd: price, // server-side rate used to derive `amount` (audit trail)
        status: 'pending', createdAt: Date.now(),
      };
      await upstash(['SET', `wd:item:${id}`, JSON.stringify(rec)]);
      await upstash(['LPUSH', 'wd:pending', id]);
      await upstash(['LPUSH', `wd:user:${userId}`, id]);
      await upstash(['LTRIM', `wd:user:${userId}`, 0, 49]);

      // Notify the user: in-app (next sync) + bot push.
      const amtLabel = (coin !== 'USDT' && coinAmount) ? (coinAmount + ' ' + coin) : (amt + ' USDT');
      await upstash(['LPUSH', `cmd:${userId}`, JSON.stringify({ type: 'message', kind: 'withdraw', title: 'Withdrawal requested', text: amtLabel + ' on ' + network + ' — pending review.' })]);
      await upstash(['LTRIM', `cmd:${userId}`, 0, 99]);
      await tgSend(userId, `📤 <b>Withdrawal requested</b>\n\n<b>${escHtml(amtLabel)}</b> via ${escHtml(network)}\nDebited: $${amt} USDT\n\nYour request is pending review. You'll be notified once it's processed.`);

      return res.status(200).json({ ok: true, balance: newBal, withdrawal: rec });
    } catch (e) {
      if (deducted) { try { await upstash(['INCRBYFLOAT', `bal:${userId}`, amt]); } catch {} } // best-effort refund
      throw e;
    }
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};
