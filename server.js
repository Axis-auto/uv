const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');
const bodyParser = require('body-parser');
const sgMail = require('@sendgrid/mail');

const app = express();
app.use(cors({ origin: true }));
app.use(bodyParser.json());

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// دالة إرسال الإيميل عبر SendGrid
async function sendShipmentEmail(to, trackingNumber) {
  const msg = {
    to,
    from: 'no-reply@axis-auto.com', // 👈 استبدلها ببريدك الموثق في SendGrid
    subject: 'تفاصيل شحنتك من Axis Auto',
    html: `
      <h3>شكرًا لطلبك 🎉</h3>
      <p>رقم الشحنة الخاصة بك هو: <b>${trackingNumber}</b></p>
      <p>يمكنك تتبعها عبر <a href="https://www.aramex.com">Aramex</a>.</p>
    `,
  };

  try {
    await sgMail.send(msg);
    console.log(`📧 تم إرسال الإيميل إلى ${to}`);
  } catch (error) {
    console.error('خطأ في إرسال الإيميل:', error);
  }
}

// إنشاء جلسة الدفع (الكود الأصلي)
app.post('/create-checkout-session', async (req, res) => {
  try {
    const quantity = Math.max(1, parseInt(req.body.quantity || 1, 10));
    const currency = (req.body.currency || 'usd').toLowerCase();

    const prices = {
      usd: { single: 79900, shipping: 4000, double: 129900, extra: 70000 },
      eur: { single: 79900, shipping: 4000, double: 129900, extra: 70000 },
      try: { single: 2799000, shipping: 150000, double: 4599000, extra: 2400000 }
    };
    const c = prices[currency] || prices['usd'];

    let totalAmount;
    if (quantity === 1) {
      totalAmount = c.single;
    } else if (quantity === 2) {
      totalAmount = c.double;
    } else {
      totalAmount = c.double + (quantity - 2) * c.extra;
    }

    const unitAmount = Math.floor(totalAmount / quantity);

    const shipping_options = (quantity === 1)
      ? [
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: c.shipping, currency },
              display_name: 'Standard Shipping',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 5 },
                maximum: { unit: 'business_day', value: 7 }
              }
            }
          }
        ]
      : [
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: 0, currency },
              display_name: 'Free Shipping',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 5 },
                maximum: { unit: 'business_day', value: 7 }
              }
            }
          }
        ];

    const allowedCountries = ['US', 'TR', 'AE', 'SA', 'GB', 'DE', 'FR', 'CA']; // 👈 قلصت القائمة للاختصار

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: quantity === 1 
                ? 'UV Car Inspection Device (1 pc)' 
                : 'UV Car Inspection Device',
              description: 'A powerful, portable device for inspecting car body, paint, AC leaks, and hidden repair traces.',
              images: [
                'https://github.com/Axis-auto/uv/blob/main/صورة%20جانبية%20(1).jpg?raw=true'
              ]
            },
            unit_amount: unitAmount
          },
          quantity
        }
      ],
      shipping_address_collection: { allowed_countries: allowedCountries },
      shipping_options,
      phone_number_collection: { enabled: true },
      success_url: 'https://axis-uv.com/success.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://axis-uv.com/cancel.html'
    });

    res.json({ id: session.id });
  } catch (err) {
    console.error('Create session error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Webhook Stripe
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // 👇 هنا لاحقًا سننشئ شحنة عبر Aramex
    const trackingNumber = 'TEST123456'; // رقم تتبع مؤقت للتجربة

    // إرسال إيميل للعميل
    if (session.customer_details && session.customer_details.email) {
      await sendShipmentEmail(session.customer_details.email, trackingNumber);
    }
  }

  res.json({ received: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
