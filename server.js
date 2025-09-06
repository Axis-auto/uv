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

      // ✅ السماح بجميع الدول المدعومة من Stripe
      shipping_address_collection: {
        allowed_countries: [
          'AE','AF','AL','AM','AO','AR','AT','AU','AZ','BA','BD','BE','BF','BG','BH','BI','BJ','BN','BO','BR','BS','BT',
          'BW','BY','BZ','CA','CD','CF','CG','CH','CI','CL','CM','CN','CO','CR','CV','CY','CZ','DE','DJ','DK','DM','DO',
          'DZ','EC','EE','EG','ER','ES','ET','FI','FJ','FM','FO','FR','GA','GB','GD','GE','GH','GI','GL','GM','GN','GQ',
          'GR','GT','GW','GY','HK','HN','HR','HT','HU','ID','IE','IL','IN','IQ','IS','IT','JM','JO','JP','KE','KG','KH',
          'KI','KM','KN','KR','KW','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MG',
          'MH','MK','ML','MM','MN','MO','MR','MT','MU','MV','MW','MX','MY','MZ','NA','NE','NG','NI','NL','NO','NP','NR',
          'NZ','OM','PA','PE','PG','PH','PK','PL','PT','PW','PY','QA','RO','RS','RU','RW','SA','SB','SC','SE','SG','SI',
          'SK','SL','SM','SN','SO','SR','ST','SV','SZ','TD','TG','TH','TJ','TL','TN','TO','TR','TT','TV','TZ','UA','UG',
          'US','UY','UZ','VC','VE','VN','VU','WS','YE','ZA','ZM','ZW'
        ]
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
