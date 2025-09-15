const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');
const bodyParser = require('body-parser');
const sgMail = require('@sendgrid/mail');
const soap = require('soap');

const app = express();
app.use(cors({ origin: true }));
app.use(bodyParser.json());

// Stripe
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
// === اختبار إرسال البريد مباشرة ===
const testEmail = {
  to: "بريدك_للاختبار@example.com", // ضع بريدك الشخصي هنا
  from: process.env.MAIL_FROM,
  subject: "اختبار إرسال البريد من السيرفر",
  text: "هذه رسالة اختبار من السيرفر للتأكد من SendGrid."
};

sgMail.send(testEmail)
  .then(() => console.log("✅ بريد الاختبار أُرسل بنجاح"))
  .catch(err => {
    console.error("❌ فشل إرسال البريد:", err);
    if (err.response && err.response.body) {
      console.error("تفاصيل الخطأ:", err.response.body);
    }
  });

// Aramex SOAP
const ARAMEX_WSDL_URL = process.env.ARAMEX_WSDL_URL;
const ARAMEX_USERNAME = process.env.ARAMEX_USERNAME;
const ARAMEX_PASSWORD = process.env.ARAMEX_PASSWORD;
const ARAMEX_ACCOUNT_NUMBER = process.env.ARAMEX_ACCOUNT_NUMBER;
const ARAMEX_ACCOUNT_PIN = process.env.ARAMEX_ACCOUNT_PIN;

// ====== إنشاء جلسة الدفع ======
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
    if (quantity === 1) totalAmount = c.single;
    else if (quantity === 2) totalAmount = c.double;
    else totalAmount = c.double + (quantity - 2) * c.extra;

    const unitAmount = Math.floor(totalAmount / quantity);

    const shipping_options = (quantity === 1)
      ? [{ shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: c.shipping, currency }, display_name: 'Standard Shipping', delivery_estimate: { minimum: { unit: 'business_day', value: 5 }, maximum: { unit: 'business_day', value: 7 } } } }]
      : [{ shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: 0, currency }, display_name: 'Free Shipping', delivery_estimate: { minimum: { unit: 'business_day', value: 5 }, maximum: { unit: 'business_day', value: 7 } } } }];

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
      'OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PY',
      'QA','RE','RO','RS','RU','RW',
      'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SZ',
      'TA','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ',
      'UA','UG','US','UY','UZ',
      'VA','VC','VE','VG','VN','VU',
      'WF','WS','XK',
      'YE','YT',
      'ZA','ZM','ZW','ZZ'
    ];

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency,
          product_data: {
            name: quantity === 1 ? 'UV Car Inspection Device (1 pc)' : 'UV Car Inspection Device',
            description: 'A powerful portable device for car inspection.',
            images: ['https://yourdomain.com/images/device.jpg']
          },
          unit_amount: unitAmount
        },
        quantity
      }],
      shipping_address_collection: { allowed_countries: allowedCountries },
      shipping_options,
      phone_number_collection: { enabled: true },
      success_url: 'https://axis-uv.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://axis-uv.com/cancel'
    });

    res.json({ id: session.id });
  } catch (err) {
    console.error('Create session error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ====== Webhook من Stripe ======
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const customerEmail = session.customer_details.email;
    const customerName = session.customer_details.name;
    const address = session.customer_details.address;

    // 1) إنشاء شحنة مع Aramex
    soap.createClient(ARAMEX_WSDL_URL, (err, client) => {
      if (err) return console.error('Aramex client error:', err);

      const shipmentData = {
        ClientInfo: {
          UserName: ARAMEX_USERNAME,
          Password: ARAMEX_PASSWORD,
          AccountNumber: ARAMEX_ACCOUNT_NUMBER,
          AccountPin: ARAMEX_ACCOUNT_PIN,
          Version: "v1"
        },
        LabelInfo: { ReportID: 9729, ReportType: "URL" },
        Shipments: [{
          Shipper: {
            Name: "Axis Auto",
            CellPhone: "0000000000",
            EmailAddress: process.env.MAIL_FROM,
            PartyAddress: { Line1: "Istanbul", CountryCode: "TR" }
          },
          Consignee: {
            Name: customerName,
            CellPhone: session.customer_details.phone,
            EmailAddress: customerEmail,
            PartyAddress: {
              Line1: address.line1,
              City: address.city,
              CountryCode: address.country
            }
          },
          Details: {
            NumberOfPieces: "1",
            DescriptionOfGoods: "UV Car Inspection Device",
            GoodsOriginCountry: "TR",
            Services: "CODS"
          }
        }]
      };

      client.CreateShipments(shipmentData, (err, result) => {
        if (err) return console.error('Aramex error:', err);

        console.log('Aramex result:', JSON.stringify(result, null, 2));

        const trackingNumber = result.Shipments?.ProcessedShipment?.ID || "N/A";
        const trackingUrl = result.Shipments?.ProcessedShipment?.LabelURL || "https://tracking.example.com";

        const msg = {
          to: customerEmail,
          from: process.env.MAIL_FROM,
          subject: 'Your Order Confirmation',
          text: `Hello ${customerName}, your order is confirmed. Tracking Number: ${trackingNumber}. Track here: ${trackingUrl}`,
          html: `<strong>Hello ${customerName}</strong><br>Your order is confirmed.<br>Tracking Number: <b>${trackingNumber}</b><br>Track here: <a href="${trackingUrl}">Link</a>`
        };

        sgMail.send(msg)
          .then(() => console.log('📧 Email sent to', customerEmail))
          .catch(err => {
            console.error('SendGrid error:', err);
            if (err.response && err.response.body) {
              console.error('SendGrid detailed error:', err.response.body);
            }
          });
      });
    });
  }

  res.json({ received: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
