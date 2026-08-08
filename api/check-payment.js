// Returns the current status of a NOWPayments payment, so the frontend can
// show live progress. Crediting is handled by the IPN webhook, not here.
//
// Authenticated: NOWPayments payment ids are sequential integers, so an
// unauthenticated lookup let anyone enumerate every user's deposit history
// (amounts, currencies, status) through our own API key. The caller must now
// prove Telegram identity AND own the payment (recorded by get-deposit-address).
// Self-contained for reliable Vercel bundling.
const crypto = require('crypto');

// ── Upstash REST helper (best-effort: returns null on any failure) ──
async function upstash(args) {
  const URL = process.env.UPSTASH_REDIS_REST_URL, TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!URL || !TOKEN) return null;
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

// ── Telegram initData verification (inlined) ──
function verifyTelegram(initData) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !initData || typeof initData !== 'string') return null;
  let params;
  try { params = new URLSearchParams(initData); } catch { return null; }
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const pairs = [];
  for (const [k, v] of params) pairs.push(`${k}=${v}`);
  pairs.sort();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calc = crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  try {
    const a = Buffer.from(calc, 'hex'), b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch { return null; }
  const authDate = parseInt(params.get('auth_date'), 10);
  if (authDate && Date.now() / 1000 - authDate > 86400) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? user : null;
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Payment provider not configured' });

  const body = req.body || {};

  // ── Reconciliation ────────────────────────────────────────────────────
  // Answers one question: is there money that reached NOWPayments but never
  // reached a user's balance? It re-runs the exact owner resolution the IPN
  // handler uses, then asks Redis whether that payment was actually credited,
  // so a mismatch here is a real gap and not a difference of method.
  //
  // Strictly read-only — it credits nothing and writes nothing. Gated by its
  // own secret so it can be turned off by deleting one environment variable.
  if (body.action === 'audit') {
    const want = process.env.AUDIT_SECRET;
    const got = String(body.secret || '');
    if (!want || got.length !== want.length ||
        !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // NOWPayments' list endpoint needs a full account login (JWT), not the API
    // key, so the provider cannot be enumerated from here. Approach it from the
    // other side instead: every deposit address this app hands out is recorded
    // as pay:owner:<paymentId>, so Redis knows every payment we ever created.
    // Ask the provider about each one and compare.
    const limit = Math.min(3000, Math.max(1, parseInt(body.limit, 10) || 1500));

    // An empty result must be distinguishable from a failed query, or "no
    // deposits" and "the scan is broken" look identical.
    const scanErrors = [];
    // The shared helper swallows the reason, which is exactly what is needed
    // here. This one keeps it.
    async function raw(args) {
      const URL = process.env.UPSTASH_REDIS_REST_URL, TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!URL || !TOKEN) return { error: 'no upstash config' };
      try {
        const r = await fetch(URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        });
        const t = await r.text();
        let j = null; try { j = JSON.parse(t); } catch { return { error: `HTTP ${r.status}: ${t.slice(0, 200)}` }; }
        if (j && j.error) return { error: `HTTP ${r.status}: ${String(j.error).slice(0, 200)}` };
        return { result: j ? j.result : null };
      } catch (e) { return { error: 'fetch: ' + (e && e.message) }; }
    }

    async function scanAll(pattern) {
      const out = [];
      let cursor = '0', guard = 0;
      do {
        const { result: page, error } = await raw(['SCAN', cursor, 'MATCH', pattern, 'COUNT', 500]);
        if (error || !page) { scanErrors.push(pattern + ' → ' + (error || 'null')); break; }
        cursor = String(page[0]);
        (page[1] || []).forEach((k) => out.push(String(k)));
      } while (cursor !== '0' && out.length < limit && ++guard < 200);
      return out;
    }

    const ids = (await scanAll('pay:owner:*')).map((k) => k.slice('pay:owner:'.length));
    const addrs = await scanAll('payaddr:*');
    const allKeys = await scanAll('*');
    const dbsize = await raw(['DBSIZE']);

    const one = async (id) => {
      try {
        const r = await fetch(`https://api.nowpayments.io/v1/payment/${encodeURIComponent(id)}`,
                              { headers: { 'x-api-key': apiKey } });
        if (!r.ok) return { id, error: r.status };
        return { id, p: await r.json() };
      } catch { return { id, error: 'unreachable' }; }
    };

    // A little concurrency, but not enough to get rate-limited.
    const results = [];
    for (let i = 0; i < ids.length; i += 6) {
      results.push(...await Promise.all(ids.slice(i, i + 6).map(one)));
    }

    const rows = [];
    for (const r of results) {
      if (r.error) { rows.push({ id: r.id, error: r.error }); continue; }
      const p = r.p;
      const owner = await upstash(['GET', `pay:owner:${r.id}`]);
      // creditDeposit() guards with SADD seen:<user> <paymentId>, so membership
      // is the definitive record that this payment was credited exactly once.
      const credited = owner
        ? (await upstash(['SISMEMBER', `seen:${owner}`, String(p.payment_id)])) === 1
        : null;
      const paid = parseFloat(p.actually_paid) || 0;
      const expect = parseFloat(p.pay_amount) || 0;
      const price = parseFloat(p.price_amount) || 0;
      rows.push({
        id: p.payment_id, status: p.payment_status,
        created: p.created_at, updated: p.updated_at,
        coin: p.pay_currency, network: p.network || null,
        payAmount: p.pay_amount, actuallyPaid: p.actually_paid,
        usd: expect > 0 ? Math.round((paid / expect) * price * 100) / 100 : price,
        orderId: p.order_id || null, address: p.pay_address || null,
        owner: owner || null, credited,
      });
    }

    const paidRows = rows.filter((r) => ['finished', 'partially_paid', 'confirmed', 'sending']
      .includes(r.status));
    return res.status(200).json({
      knownPayments: ids.length,
      storedAddresses: addrs.length,
      dbsize,
      scanErrors,
      // Key shapes actually present, so a naming mismatch is visible at a glance.
      keyShapes: allKeys.reduce((a, k) => {
        const s = k.split(':')[0]; a[s] = (a[s] || 0) + 1; return a; }, {}),
      byStatus: rows.reduce((a, r) => { const k = r.status || ('error ' + r.error);
        a[k] = (a[k] || 0) + 1; return a; }, {}),
      // The only rows that mean money moved but a balance did not.
      missing: paidRows.filter((r) => r.credited !== true),
      paid: paidRows,
      creditedTotalUsd: Math.round(rows.filter((r) => r.credited === true)
        .reduce((t, r) => t + (r.usd || 0), 0) * 100) / 100,
    });
  }

  const user = verifyTelegram(body.initData);
  if (!user) return res.status(401).json({ error: 'Telegram authentication failed' });
  const userId = `tg_${user.id}`;

  const paymentId = body.paymentId || body.payment_id;
  if (!paymentId) return res.status(400).json({ error: 'paymentId is required' });

  // Authorise: this payment must have been created by this user.
  const owner = await upstash(['GET', `pay:owner:${paymentId}`]);
  if (!owner) return res.status(404).json({ error: 'Payment not found' });
  if (String(owner) !== userId) return res.status(403).json({ error: 'Not your payment' });

  try {
    const response = await fetch(
      `https://api.nowpayments.io/v1/payment/${encodeURIComponent(paymentId)}`,
      { headers: { 'x-api-key': apiKey } }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Could not fetch payment status' });
    }

    return res.status(200).json({
      paymentId: data.payment_id,
      // waiting | confirming | confirmed | sending | partially_paid | finished | failed | refunded | expired
      status: data.payment_status,
      payAmount: data.pay_amount,
      actuallyPaid: data.actually_paid,
      payCurrency: data.pay_currency,
      priceAmount: data.price_amount,
      priceCurrency: data.price_currency,
      outcomeAmount: data.outcome_amount,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
