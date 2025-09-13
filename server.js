// server.js
const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors({ origin: true }));
app.use(bodyParser.json());

// قراءة مفتاح Stripe من متغير البيئة
const stripeKey = process.env.STRIPE_SECRET_KEY || '';
let stripe = null;

if (stripeKey) {
  try {
    stripe = Stripe(stripeKey);
    console.log('✅ Stripe initialized.');
  } catch (err) {
    console.error('❌ Failed to initialize Stripe:', err);
    stripe = null;
  }
} else {
  console.warn('⚠️ STRIPE_SECRET_KEY is not set. Set the environment variable in Render (or locally) as STRIPE_SECRET_KEY.');
}

// Helper: قائمة الدول (كما في الكود الأصلي)
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

app.post('/create-checkout-session', async (req, res) => {
  try {
    // إذا لم يتم تهيئة stripe: نعيد خطأ واضح بدلاً من حدوث crash
    if (!stripe) {
      console.error('Stripe client not initialized. Check STRIPE_SECRET_KEY environment variable.');
      return res.status(500).json({ error: 'Server misconfiguration: STRIPE_SECRET_KEY not set.' });
    }

    const quantity = Math.max(1, parseInt(req.body.quantity || 1, 10));
    const currency = (req.body.currency || 'usd').toLowerCase();

    // الأسعار لكل عملة (بأصغر وحدة)
    const prices = {
      usd: { single: 79900, shipping: 4000, double: 129900, extra: 70000 },
      eur: { single: 79900, shipping: 4000, double: 129900, extra: 70000 }, // عدّل إن أردت أسعار EUR مغايرة
      try: { single: 2799000, shipping: 150000, double: 4599000, extra: 2400000 }
    };
    const c = prices[currency] || prices['usd'];

    // صورة المنتج ووصفه الأساسي
    const productImage = 'https://github.com/Axis-auto/uv/blob/main/%D8%B5%D9%88%D8%B1%D8%A9%20%D8%AC%D8%A7%D9%86%D8%A8%D9%8A%D8%A9%20(1).jpg?raw=true';
    const baseDescription = 'A powerful, portable device for inspecting car body, paint, AC leaks, and hidden repair traces.';

    // بناء line_items طبقاً لسياسة التسعير (دون تعريض المجمل للخطأ)
    const line_items = [];

    if (quantity === 1) {
      // قطعة واحدة: سعر الوحدة 799 (الشحن سيضاف في shipping_options)
      line_items.push({
        price_data: {
          currency,
          product_data: {
            name: `UV Car Inspection Device`,
            description: `${baseDescription} (Quantity: ${quantity})`,
            images: [productImage]
          },
          unit_amount: c.single
        },
        quantity: 1
      });
    } else if (quantity === 2) {
      // باكج قطعتين: سعر إجمالي 1299 -> نعرضه كسطر واحد بسعر unit_amount = 129900 (quantity=1)
      // لكن لنرى العدد للعميل نضعه في الوصف
      line_items.push({
        price_data: {
          currency,
          product_data: {
            name: `UV Car Inspection Device (2 pcs bundle)`,
            description: `${baseDescription} (Quantity: ${quantity})`,
            images: [productImage]
          },
          unit_amount: c.double
        },
        quantity: 1
      });
    } else {
      // quantity >= 3
      // نعرض باكج القطعتين كسطر 1 (unit_amount = c.double, quantity=1)
      // ونضيف سطر للقطع الإضافية: كل قطعة بقيمة c.extra (quantity = extras)
      line_items.push({
        price_data: {
          currency,
          product_data: {
            name: `UV Car Inspection Device (2 pcs bundle)`,
            description: `${baseDescription} (Bundle part of total Quantity: ${quantity})`,
            images: [productImage]
          },
          unit_amount: c.double
        },
        quantity: 1
      });

      const extras = quantity - 2;
      line_items.push({
        price_data: {
          currency,
          product_data: {
            name: `Additional UV Device (per extra unit)`,
            description: `Extra unit — adds to the 2-piece package. (Extras count: ${extras})`,
            images: [productImage]
          },
          unit_amount: c.extra
        },
        quantity: extras
      });
    }

    // خيارات الشحن: شحن مدفوع فقط عندما quantity === 1
    const shipping_options = (quantity === 1) ? [
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
    ] : [
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

    // إنشاء جلسة Checkout
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items,
      metadata: { total_quantity: String(quantity) },
      shipping_address_collection: { allowed_countries: allowedCountries },
      shipping_options,
      phone_number_collection: { enabled: true },
      success_url: 'https://axis-auto.github.io/uv/success.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://axis-auto.github.io/uv/cancel.html'
    });

    console.log(`Created checkout session ${session.id} - quantity=${quantity} currency=${currency}`);
    res.json({ id: session.id });
  } catch (err) {
    console.error('Create session error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// تشغيل السيرفر
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port} (NODE ${process.version})`));
