// ============================================================
// J.Shutup — Backend Server
// This is the ONLY piece of the system allowed to know your
// PayPal Secret Key and decide how much anything costs.
// The website (frontend) never calculates prices itself.
// ============================================================

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());               // allows your website to call this server
app.use(express.json());

const PORT = process.env.PORT || 4000;

// PayPal switches between two "worlds": sandbox (fake money, for testing)
// and live (real money). Both need their own Client ID + Secret.
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_ENV = process.env.PAYPAL_ENV || 'sandbox'; // 'sandbox' or 'live'

const PAYPAL_API_BASE = PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

// ------------------------------------------------------------
// PRODUCT CATALOG — the real prices live HERE, not in the browser.
// If someone tampers with the website's JavaScript, it doesn't
// matter: this list is what actually gets charged.
// ------------------------------------------------------------
const PRODUCTS = {
  '1min':  { label: '1 Minute',  amount: '1.99',  durationSec: 60 },
  '10min': { label: '10 Minutes', amount: '5.99',  durationSec: 600 },
  'custom': { label: 'Custom', amount: '29.99' } // durationSec comes from user's minute choice, capped below
};

// ------------------------------------------------------------
// Ask PayPal for a temporary access token using your secret key.
// ------------------------------------------------------------
async function getAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error('Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET environment variables.');
  }
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error('Failed to get PayPal access token: ' + await res.text());
  const data = await res.json();
  return data.access_token;
}

// ------------------------------------------------------------
// STEP 1 of checkout: create an order on PayPal's side.
// The website calls this first, PayPal replies with an orderID,
// and the website hands that orderID to the PayPal payment popup.
// ------------------------------------------------------------
app.post('/api/orders/create', async (req, res) => {
  try {
    const { productId, minutes } = req.body;
    const product = PRODUCTS[productId];
    if (!product) return res.status(400).json({ error: 'Unknown product' });

    let durationSec = product.durationSec;
    if (productId === 'custom') {
      const m = Math.min(300, Math.max(1, parseInt(minutes, 10) || 1));
      durationSec = m * 60;
    }

    const accessToken = await getAccessToken();
    const orderRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          description: `J.Shutup — ${product.label}`,
          amount: { currency_code: 'USD', value: product.amount },
          custom_id: JSON.stringify({ productId, durationSec })
        }]
      })
    });

    const orderData = await orderRes.json();
    if (!orderRes.ok) return res.status(500).json({ error: orderData });

    res.json({ id: orderData.id, durationSec });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// STEP 2 of checkout: after the customer approves payment in the
// PayPal popup, the website calls this to actually CAPTURE the
// money. Only after this succeeds should the site unlock anything.
// ------------------------------------------------------------
app.post('/api/orders/:orderID/capture', async (req, res) => {
  try {
    const { orderID } = req.params;
    const accessToken = await getAccessToken();

    const captureRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderID}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const captureData = await captureRes.json();
    if (!captureRes.ok) return res.status(500).json({ error: captureData });

    const status = captureData.status; // should be 'COMPLETED'
    let durationSec = 60;
    try {
      const customId = captureData.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id
        || captureData.purchase_units?.[0]?.custom_id;
      if (customId) durationSec = JSON.parse(customId).durationSec;
    } catch (e) { /* fall back to default */ }

    res.json({ status, durationSec, orderID });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------
// Webhook: PayPal calls THIS endpoint directly (server to server)
// to confirm a payment truly went through, independent of whether
// the customer's browser stayed open. Point PayPal's dashboard at:
//   https://YOUR-BACKEND-URL/api/paypal/webhook
// NOTE: this basic version just logs the event. Before going live
// with real money at scale, add PayPal's signature verification
// (see PayPal docs: "Verify webhook signature").
// ------------------------------------------------------------
app.post('/api/paypal/webhook', (req, res) => {
  console.log('PayPal webhook received:', req.body?.event_type);
  // TODO: verify signature, then update your database / order records here.
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('J.Shutup backend is running. PayPal env: ' + PAYPAL_ENV);
});

app.listen(PORT, () => {
  console.log(`J.Shutup backend listening on port ${PORT} (PayPal env: ${PAYPAL_ENV})`);
});
