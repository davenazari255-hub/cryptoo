// Returns the current status of a NOWPayments payment, so the frontend can
// show live progress. Crediting is handled by the IPN webhook, not here.
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'NOWPAYMENTS_API_KEY is not configured' });

  const paymentId = req.query.paymentId || req.query.payment_id;
  if (!paymentId) return res.status(400).json({ error: 'paymentId is required' });

  try {
    const response = await fetch(
      `https://api.nowpayments.io/v1/payment/${encodeURIComponent(paymentId)}`,
      { headers: { 'x-api-key': apiKey } }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || 'NOWPayments error' });
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
    return res.status(500).json({ error: 'Server error: ' + ((err && err.message) || 'unknown') });
  }
}
