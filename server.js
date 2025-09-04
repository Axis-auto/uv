// server.js
const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors({
  origin: true // مؤقتاً يسمح لأي أصل - يفضل تغييره لاحقاً إلى https://USERNAME.github.io
}));
app.use(bodyParser.json());

// STRIPE_SECRET_KEY سيأتي من متغير بيئي على Render
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.post('/create-checkout-session', async (req, res) => {
  try {
    const quantity = Math.max(1, parseInt(req.body.quantity || 1, 10));

    // حساب السعر بالديناميكية (بالسنت)
    let amount;
    if (quantity === 1) {
      amount = 79900 + 4000;       // $799 + $40 شحن => 83900 سنت
    } else if (quantity === 2) {
      amount = 129900;             // $1299 => 129900 سنت
    } else {
      amount = 129900 + (quantity - 2) * 70000; // +$700 لكل قطعة إضافية
    }

    // عدّل success_url و cancel_url إلى صفحاتك على GitHub Pages
    const YOUR_GH_PAGES_BASE = process.env.GH_PAGES_BASE || 'https://USERNAME.github.io/REPO';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: 'جهاز فحص السيارات — AXIS UV' },
            unit_amount: amount
          },
          quantity: 1
        }
      ],
      metadata: { quantity: String(quantity) },
      success_url: `${YOUR_GH_PAGES_BASE}/thank-you.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${YOUR_GH_PAGES_BASE}/cancel.html`
    });

    res.json({ id: session.id });
  } catch (err) {
    console.error('Create session error:', err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
