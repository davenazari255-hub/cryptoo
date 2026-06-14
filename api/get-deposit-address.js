// Creates a NOWPayments payment and returns a deposit address.
// The user is identified by verified Telegram initData (not a client-supplied
// id), and an ipn_callback_url is set so the webhook credits the deposit.
// Users send ANY amount; balance is credited from actually_paid via the IPN.
const { userIdFromReq } = require('../lib/verifyTelegram');

const MIN_USD = 10;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'NOWPAYMENTS_API_KEY is not configured' });

  const { currency } = req.body || {};
  if (!currency) return res.status(400).json({ error: 'currency is required' });

  // Trust only a Telegram-verified user id.
  const userId = userIdFromReq(req.body);
  if (!userId) return res.status(401).json({ error: 'Telegram authentication failed' });

  const payCurrency = String(currency).toLowerCase();

  // Build the IPN callback URL from the deployment host.
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const ipnUrl = process.env.IPN_CALLBACK_URL || (host ? `${proto}://${host}/api/ipn` : undefined);

  try {
    const response = await fetch('https://api.nowpayments.io/v1/payment', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: MIN_USD,
        price_currency: 'usd',
        pay_currency: payCurrency,
        order_id: `user_${userId}`,
        order_description: `Deposit for ${userId}`,
        ipn_callback_url: ipnUrl,
        is_fee_paid_by_user: true,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || 'NOWPayments error' });
    }

    return res.status(200).json({
      address: data.pay_address,
      payCurrency: (data.pay_currency || payCurrency).toUpperCase(),
      paymentId: data.payment_id,
      payinExtraId: data.payin_extra_id || null,
      network: data.network || null,
      minUsd: MIN_USD,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
};
