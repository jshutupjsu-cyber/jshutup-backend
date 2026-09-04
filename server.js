const express = require("express");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const SECRET = process.env.PAYPAL_CLIENT_SECRET;
const ENV = (process.env.PAYPAL_ENV || "live").toLowerCase();
const BASE = ENV === "sandbox"
  ? "https://api-m.sandbox.paypal.com"
  : "https://api-m.paypal.com";

const PRODUCTS = {
  "1min": { amount: "1.99", durationSec: 60 },
  "10min": { amount: "5.99", durationSec: 600 },
  "custom": { amount: "29.99", durationSec: null }
};

async function accessToken() {
  if (!CLIENT_ID || !SECRET) throw new Error("PayPal credentials are missing.");
  const auth = Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64");
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  const data = await r.json();
  if (!r.ok) throw new Error("PayPal authentication failed.");
  return data.access_token;
}

app.get("/", (req, res) => res.json({ ok: true, service: "J.Shutup backend" }));

app.get("/health", (req, res) => res.json({
  ok: true,
  paypalEnv: ENV,
  paypalCredentialsConfigured: Boolean(CLIENT_ID && SECRET)
}));

app.post("/api/orders/create", async (req, res) => {
  try {
    const { productId, minutes } = req.body || {};
    const product = PRODUCTS[productId];
    if (!product) return res.status(400).json({ error: "Invalid product." });

    let durationSec = product.durationSec;
    if (productId === "custom") {
      const m = Number(minutes);
      if (!Number.isInteger(m) || m < 1 || m > 300)
        return res.status(400).json({ error: "Invalid duration." });
      durationSec = m * 60;
    }

    const token = await accessToken();
    const r = await fetch(`${BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          description: `J.Shutup ${productId}`,
          custom_id: String(durationSec),
          amount: { currency_code: "USD", value: product.amount }
        }]
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: "PayPal create failed", details: data });
    res.json({ id: data.id, durationSec });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/orders/:orderID/capture", async (req, res) => {
  try {
    const token = await accessToken();
    const r = await fetch(`${BASE}/v2/checkout/orders/${encodeURIComponent(req.params.orderID)}/capture`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: "PayPal capture failed", details: data });

    const unit = data.purchase_units?.[0];
    res.json({
      status: data.status,
      durationSec: Number(unit?.custom_id) || null,
      orderID: data.id
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`J.Shutup backend on ${PORT} (${ENV})`));
