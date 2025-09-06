// server.js
const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors({
  origin: true // مؤقتاً يسمح لأي موقع - بعد التجربة يمكنك تغييره إلى: 'https://axis-auto.github.io'
}));
app.use(bodyParser.json());

// مفتاح Stripe السري (يجب أن يكون متغيّر بيئي في Render باسم STRIPE_SECRET_KEY)
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.post('/create-checkout-session', async (req, res) => {
  try {
    const quantity = Math.max(1, parseInt(req.body.quantity || 1, 10));

    // حساب السعر بالديناميكية (بالسنت)
    let amount;
    if (quantity === 1) {
      amount = 79900 + 4000;       // $799 + $40 شحن = $839
    } else if (quantity === 2) {
      amount = 129900;             // $1299 (شحن مجاني)
    } else {
      amount = 129900 + (quantity - 2) * 70000; // +$700 لكل قطعة إضافية
    }

    // إنشاء جلسة Checkout
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

      // ✅ السماح بجميع الدول
      shipping_address_collection: {
        allowed_countries: ['*']
      },
      phone_number_collection: {
        enabled: true
      },

      // روابط النجاح والإلغاء
      success_url: 'https://axis-auto.github.io/uv/success.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://axis-auto.github.io/uv/cancel.html'
    });

    // ✅ إرجاع session.id (حتى يستخدمه الفرونت إند مع stripe.redirectToCheckout)
    res.json({ id: session.id });
  } catch (err) {
    console.error('Create session error:', err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
