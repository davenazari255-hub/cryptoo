// Admin API for managing withdrawal requests. Protected by ADMIN_SECRET.
// Actions: list (pending), decide (approve | reject | paid).
// reject refunds the held balance back to the user. Self-contained for Vercel.
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.ADMIN_SECRET;
  const body = req.body || {};
  if (!secret) return res.status(500).json({ error: 'ADMIN_SECRET is not configured' });
  if (body.secret !== secret) return res.status(401).json({ error: 'Unauthorized' });

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
      const [profiles, bals, bans] = await Promise.all([
        upstash(['MGET', ...ids.map((id) => `profile:${id}`)]),
        upstash(['MGET', ...ids.map((id) => `bal:${id}`)]),
        upstash(['MGET', ...ids.map((id) => `banned:${id}`)]),
      ]);
      const users = ids.map((id, i) => {
        const p = parseJSON(profiles[i]) || {};
        return {
          userId: id, username: p.username || null, name: p.name || null,
          joinedAt: p.joinedAt || null, lastSeen: p.lastSeen || null,
          balance: parseFloat(bals[i]) || 0, equity: p.equity || 0,
          positions: (p.positions || []).length, openOrders: (p.openOrders || []).length,
          banned: !!bans[i],
        };
      }).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      return res.status(200).json({ users });
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
      if (!id || !amount) return res.status(400).json({ error: 'id and non-zero amount required' });
      const newBal = parseFloat(await upstash(['INCRBYFLOAT', `bal:${id}`, amount]));
      if (newBal < 0) { await upstash(['INCRBYFLOAT', `bal:${id}`, -amount]); return res.status(400).json({ error: 'Would make balance negative' }); }
      await upstash(['LPUSH', `ledger:${id}`, JSON.stringify({ usd: amount, coin: 'ADMIN', note: String(body.note || 'Admin adjustment'), at: Date.now() })]);
      await upstash(['LTRIM', `ledger:${id}`, 0, 99]);
      return res.status(200).json({ ok: true, balance: newBal });
    }

    if (body.action === 'ban' || body.action === 'unban') {
      const id = String(body.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      if (body.action === 'ban') await upstash(['SET', `banned:${id}`, '1']);
      else await upstash(['DEL', `banned:${id}`]);
      return res.status(200).json({ ok: true, banned: body.action === 'ban' });
    }

    // Queue a trade command for the user's app to apply on next sync.
    if (body.action === 'command') {
      const id = String(body.id || '');
      const cmd = body.command;
      const valid = cmd && ['closePosition', 'cancelOrder', 'editPosition', 'message'].includes(cmd.type);
      if (!id || !valid) return res.status(400).json({ error: 'id and a valid command required' });
      await upstash(['LPUSH', `cmd:${id}`, JSON.stringify(cmd)]);
      await upstash(['LTRIM', `cmd:${id}`, 0, 99]);
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

      return res.status(200).json({ ok: true, withdrawal: rec });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};
