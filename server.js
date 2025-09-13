// server.js
const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors({ origin: true }));
app.use(bodyParser.json());

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.post('/create-checkout-session', async (req, res) => {
  try {
    const quantity = Math.max(1, parseInt(req.body.quantity || 1, 10));
    const currency = (req.body.currency || 'usd').toLowerCase();

    // الأسعار
    const prices = {
      usd: { single: 79900, shipping: 4000, double: 129900, extra: 70000 },
      eur: { single: 79900, shipping: 4000, double: 129900, extra: 70000 },
      try: { single: 2799000, shipping: 150000, double: 4599000, extra: 2400000 }
    };
    const c = prices[currency] || prices['usd'];

    // حساب المجموع
    let totalAmount;
    if (quantity === 1) {
      totalAmount = c.single;
    } else if (quantity === 2) {
      totalAmount = c.double;
    } else {
      totalAmount = c.double + (quantity - 2) * c.extra;
    }

    // unit amount
    const unitAmount = Math.floor(totalAmount / quantity);

    // خيارات الشحن
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

    // الدول
    const allowedCountries = [
      'AC','AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AT','AU','AW','AX','AZ',
      'BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ',
      'CA','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CV','CW','CY','CZ',
      'DE','DJ','DK','DM','DO','DZ',
      'EC','EE','EG','EH','ER','ES','ET',
      'FI','FJ','FK','FO','FR',
      'GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY',
      'HK','HN','HR','HT','HU',
      'ID','IE','IL','IM','IN','IO','IQ','IS','IT',
      'JE','JM','JO','JP',
      'KE','KG','KH','KI','KM','KN','KR','KW','KY','KZ',
      'LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY',
      'MA','MC','MD','ME','MF','MG','MK','ML','MM','MN','MO','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ',
      'NA','NC','NE','NG','NI','NL','NO','NP','NR','NU','NZ',
      'OM',
      'PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PY',
      'QA',
      'RE','RO','RS','RU','RW',
      'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SZ',
      'TA','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ',
      'UA','UG','US','UY','UZ',
      'VA','VC','VE','VG','VN','VU',
      'WF','WS','XK',
      'YE','YT',
      'ZA','ZM','ZW',
      'ZZ'
    ];

    // إنشاء جلسة
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: quantity === 1 
                ? 'UV Car Inspection Device (1 pc)' // 👈 يظهر العدد عند قطعة واحدة
                : 'UV Car Inspection Device',
              description: 'A powerful, portable device for inspecting car body, paint, AC leaks, and hidden repair traces.',
              images: [
                'https://github.com/Axis-auto/uv/blob/main/%D8%B5%D9%88%D8%B1%D8%A9%20%D8%AC%D8%A7%D9%86%D8%A8%D9%8A%D8%A9%20(1).jpg?raw=true'
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
      success_url: 'https://axis-auto.github.io/uv/success.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://axis-auto.github.io/uv/cancel.html'
    });

    res.json({ id: session.id });
  } catch (err) {
    console.error('Create session error:', err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
