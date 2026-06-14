export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { currency, userId } = req.body;

  if (!currency || !userId) {
    return res.status(400).json({ error: 'currency and userId are required' });
  }

  try {
    const response = await fetch('https://api.nowpayments.io/v1/payment', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        price_amount: 0,
        price_currency: 'usd',
        pay_currency: currency.toLowerCase(),
        order_id: `user_${userId}`,
        order_description: `Deposit for user ${userId}`,
        is_fixed_rate: false,
        is_fee_paid_by_user: false,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(400).json({ error: data.message || 'NOWPayments error' });
    }

    return res.status(200).json({
      address: data.pay_address,
      currency: data.pay_currency.toUpperCase(),
      paymentId: data.payment_id,
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
}
