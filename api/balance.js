// Returns the authenticated user's real (deposited) balance + recent ledger.
// Auth: verified Telegram initData passed in the POST body.
const { userIdFromReq } = require('../lib/verifyTelegram');
const { getBalance, getLedger } = require('../lib/store');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const userId = userIdFromReq(req.body);
  if (!userId) return res.status(401).json({ error: 'Telegram authentication failed' });

  try {
    const [balance, ledger] = await Promise.all([getBalance(userId), getLedger(userId, 30)]);
    return res.status(200).json({ balance, ledger });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};
