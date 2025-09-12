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

      // ✅ تفعيل 3D Secure تلقائيًا
      payment_method_options: {
        card: {
          request_three_d_secure: 'automatic' // أو 'any' لإجبار جميع العملاء
        },
      },

      // ✅ كل الدول المدعومة من Stripe (من الوثائق الرسمية)
      shipping_address_collection: {
        allowed_countries: [
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
