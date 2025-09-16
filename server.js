const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');
const bodyParser = require('body-parser');
const sgMail = require('@sendgrid/mail');
const axios = require('axios');

const app = express();
app.use(cors({ origin: true }));

// Stripe
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Aramex JSON Endpoint
const ARAMEX_API_URL = process.env.ARAMEX_WSDL_URL; 
const ARAMEX_USERNAME = process.env.ARAMEX_USER;
const ARAMEX_PASSWORD = process.env.ARAMEX_PASSWORD;
const ARAMEX_ACCOUNT_NUMBER = process.env.ARAMEX_ACCOUNT_NUMBER;
const ARAMEX_ACCOUNT_PIN = process.env.ARAMEX_ACCOUNT_PIN;
const ARAMEX_ACCOUNT_ENTITY = process.env.ARAMEX_ACCOUNT_ENTITY;
const ARAMEX_ACCOUNT_COUNTRY_CODE = process.env.ARAMEX_ACCOUNT_COUNTRY;
const ARAMEX_VERSION = process.env.ARAMEX_VERSION;

// ====== إنشاء جلسة الدفع ======
app.post('/create-checkout-session', bodyParser.json(), async (req, res) => {
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
      ? [{
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: c.shipping, currency },
            display_name: 'Standard Shipping',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 5 },
              maximum: { unit: 'business_day', value: 7 }
            }
          }
        }]
      : [{
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 0, currency },
            display_name: 'Free Shipping',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 5 },
              maximum: { unit: 'business_day', value: 7 }
            }
          }
        }];

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
  console.log('✅ Incoming Stripe webhook headers:', req.headers);
  console.log('✅ Incoming Stripe webhook body length:', req.body.length);

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('✅ Stripe webhook verified:', event.type);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const customerEmail = session.customer_details.email;
    const customerName = session.customer_details.name;
    const address = session.customer_details.address;

    // تقسيم عنوان الشاحن (Shipper) كما يطلب Aramex باستخدام المتغيرات البيئية
    const shipperAddress = {
      Line1: process.env.SHIPPER_LINE1,
      Line2: "(Registration Village)",  // هذا ثابت، يمكن جعله متغير إذا أردت
      Line3: "Ground Floor - Shop No. 5&6",  // هذا ثابت، يمكن جعله متغير
      City: process.env.SHIPPER_CITY,
      StateOrProvinceCode: "IST",  // افتراضي لإسطنبول، يمكن جعله متغير إذا لزم
      PostCode: process.env.SHIPPER_POSTCODE,  // مصحح: PostalCode → PostCode
      CountryCode: process.env.SHIPPER_COUNTRY_CODE,
      ResidenceType: "Business"  // افتراضي، يمكن تعديله
    };

    // 1) إنشاء شحنة مع Aramex عبر JSON endpoint (بدون Transaction لتجنب أخطاء سابقة)
    const shipmentData = {
      ClientInfo: {
        UserName: process.env.ARAMEX_USER,
        Password: process.env.ARAMEX_PASSWORD,
        AccountNumber: process.env.ARAMEX_ACCOUNT_NUMBER,
        AccountPin: process.env.ARAMEX_ACCOUNT_PIN,
        AccountEntity: process.env.ARAMEX_ACCOUNT_ENTITY,
        AccountCountryCode: process.env.ARAMEX_ACCOUNT_COUNTRY,
        Version: process.env.ARAMEX_VERSION  // استخدام المتغير البيئي
      },
      LabelInfo: { ReportID: 9729, ReportType: "URL" },  // احتفظ به، لكن تحقق من ReportID
      Shipments: [{
        Shipper: {
          Name: process.env.SHIPPER_NAME,  // من المتغير
          Company: process.env.SHIPPER_NAME,  // اختياري، استخدم الاسم نفسه
          CellPhone: process.env.SHIPPER_PHONE,  // من المتغير
          Email: process.env.SHIPPER_EMAIL || process.env.MAIL_FROM,  // من المتغير أو fallback
          PartyAddress: shipperAddress,
          Contact: {  // نوع Contact مطلوب
            PersonName: process.env.SHIPPER_NAME + " Contact",  // مبني على الاسم
            Company: process.env.SHIPPER_NAME,
            PhoneNumber1: process.env.SHIPPER_PHONE,
            CellPhone: process.env.SHIPPER_PHONE,
            Email: process.env.SHIPPER_EMAIL || process.env.MAIL_FROM
          }
        },
        Consignee: {
          Name: customerName,  // Party.Name
          Company: "",  // اختياري
          CellPhone: session.customer_details.phone || "",  // Party.CellPhone
          Email: customerEmail,  // Email
          PartyAddress: {
            Line1: address.line1 || "",
            Line2: address.line2 || "",
            Line3: address.line3 || "",
            City: address.city || "",
            StateOrProvinceCode: address.state || "N/A",
            PostCode: address.postal_code || "00000",  // مصحح: PostalCode → PostCode
            CountryCode: address.country || "US",
            ResidenceType: "Residential"
          },
          Contact: {  // نوع Contact مطلوب
            PersonName: customerName,
            PhoneNumber1: session.customer_details.phone || "",
            CellPhone: session.customer_details.phone || "",
            Email: customerEmail
          }
        },
        Details: {  // تفاصيل الشحنة
          ActualWeight: {
            Value: 1.0,
            Unit: "KG"
          },
          ChargeableWeight: {
            Value: 1.0,
            Unit: "KG"
          },
          NumberOfPieces: 1,
          DescriptionOfGoods: "UV Car Inspection Device",
          GoodsOriginCountry: process.env.SHIPPER_COUNTRY_CODE,
          ProductType: "PDX",
          PaymentType: "PPR",
          Services: ["COD"],
          CollectAmount: {
            Amount: 0.0,
            CurrencyCode: "TRY"
          }
        }
      }]
    };

    try {
      const response = await axios.post(
        ARAMEX_API_URL,
        shipmentData,
        { 
          headers: { 
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          } 
        }
      );

      console.log('✅ Aramex result:', JSON.stringify(response.data, null, 2));

      const processed = response.data?.Shipments?.ProcessedShipment;
      const trackingNumber = processed?.ID || "N/A";
      const trackingUrl = processed?.LabelURL || "https://tracking.example.com";

      // 2) إرسال بريد للعميل
      const msg = {
        to: customerEmail,
        from: process.env.MAIL_FROM,
        subject: 'Your Order Confirmation',
        text: `Hello ${customerName}, your order is confirmed. Tracking Number: ${trackingNumber}. Track here: ${trackingUrl}`,
        html: `<strong>Hello ${customerName}</strong><br>Your order is confirmed.<br>Tracking Number: <b>${trackingNumber}</b><br>Track here: <a href="${trackingUrl}">Link</a>`
      };

      sgMail.send(msg)
        .then(() => console.log('📧 Email sent to', customerEmail))
        .catch(err => console.error('SendGrid error:', err));

    } catch (err) {
      console.error('Aramex API error:', err.response?.data || err.message);
    }
  }

  res.json({ received: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
