// Creates a NOWPayments payment and returns a dedicated deposit address.
// Standard NOWPayments flow: each call generates a fresh pay_address for the
// given (currency, amount). The frontend polls /api/check-payment for status.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'NOWPAYMENTS_API_KEY is not configured' });

  const { currency, amount, userId } = req.body || {};

  if (!currency || !userId) {
    return res.status(400).json({ error: 'currency and userId are required' });
  }

  const usd = parseFloat(amount);
  if (!usd || usd <= 0) {
    return res.status(400).json({ error: 'A positive amount is required' });
  }

  const payCurrency = String(currency).toLowerCase();

  try {
    const response = await fetch('https://api.nowpayments.io/v1/payment', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        price_amount: usd,
        price_currency: 'usd',
        pay_currency: payCurrency,
        order_id: `user_${userId}`,
        order_description: `Deposit for user ${userId}`,
        is_fee_paid_by_user: true,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      // NOWPayments returns a descriptive `message` (e.g. amount below minimum).
      return res.status(response.status).json({ error: data.message || 'NOWPayments error' });
    }

    return res.status(200).json({
      address: data.pay_address,
      payAmount: data.pay_amount,
      payCurrency: (data.pay_currency || payCurrency).toUpperCase(),
      priceAmount: data.price_amount,
      paymentId: data.payment_id,
      payinExtraId: data.payin_extra_id || null, // memo/tag for chains that need it (TON, etc.)
      network: data.network || null,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Server error contacting NOWPayments' });
  }
}
