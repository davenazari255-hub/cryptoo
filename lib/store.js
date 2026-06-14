// Minimal Upstash Redis (REST) client + balance/ledger helpers.
// No npm deps — uses fetch against the Upstash REST API.
// Required env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function ensureConfigured() {
  if (!URL || !TOKEN) {
    throw new Error('Upstash is not configured (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)');
  }
}

// Run a single Redis command via the Upstash REST API.
async function cmd(args) {
  ensureConfigured();
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error('Upstash error: ' + (data.error || res.status));
  }
  return data.result;
}

const balKey = (userId) => `bal:${userId}`;
const ledgerKey = (userId) => `ledger:${userId}`;
const seenKey = (userId) => `seen:${userId}`;

// Total deposited USD value for a user (real, server-side).
async function getBalance(userId) {
  const v = await cmd(['GET', balKey(userId)]);
  return parseFloat(v) || 0;
}

// Most recent ledger entries (newest first).
async function getLedger(userId, limit = 30) {
  const rows = await cmd(['LRANGE', ledgerKey(userId), 0, limit - 1]);
  return (rows || []).map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}

// Idempotently credit a finished deposit. Returns the new balance, or null if
// this paymentId was already credited (deduped via a per-user set).
async function creditDeposit(userId, paymentId, usd, meta = {}) {
  const added = await cmd(['SADD', seenKey(userId), String(paymentId)]);
  if (added === 0) return null; // already processed

  const amount = Math.round((parseFloat(usd) || 0) * 100) / 100;
  const newBal = await cmd(['INCRBYFLOAT', balKey(userId), amount]);
  const entry = JSON.stringify({ paymentId: String(paymentId), usd: amount, ...meta, at: meta.at || null });
  await cmd(['LPUSH', ledgerKey(userId), entry]);
  await cmd(['LTRIM', ledgerKey(userId), 0, 99]);
  return parseFloat(newBal) || amount;
}

module.exports = { cmd, getBalance, getLedger, creditDeposit };
