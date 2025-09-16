// server.js
const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');
const bodyParser = require('body-parser');
const sgMail = require('@sendgrid/mail');
const axios = require('axios');

const app = express();
app.use(cors({ origin: true }));

// ======= Config / Env checks =======
const requiredEnvs = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SENDGRID_API_KEY',
  'MAIL_FROM',
  'ARAMEX_USER',
  'ARAMEX_PASSWORD',
  'ARAMEX_ACCOUNT_NUMBER',
  'ARAMEX_ACCOUNT_PIN',
  'ARAMEX_ACCOUNT_ENTITY',
  'ARAMEX_ACCOUNT_COUNTRY',
  'ARAMEX_WSDL_URL' // used as API URL in code to avoid breaking naming
];

// log missing envs (but don't crash render — useful for debugging)
const missing = requiredEnvs.filter(k => !process.env[k]);
if (missing.length) {
  console.warn('⚠️ Missing required env variables:', missing.join(', '));
}

// Stripe
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// SendGrid
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
} else {
  console.warn('⚠️ SENDGRID_API_KEY not set — emails will fail if attempted via SendGrid.');
}

// Aramex endpoint config (keep existing env name to avoid breaking)
const ARAMEX_API_URL = process.env.ARAMEX_WSDL_URL || '';
const ARAMEX_USERNAME = process.env.ARAMEX_USER;
const ARAMEX_PASSWORD = process.env.ARAMEX_PASSWORD;
const ARAMEX_ACCOUNT_NUMBER = process.env.ARAMEX_ACCOUNT_NUMBER;
const ARAMEX_ACCOUNT_PIN = process.env.ARAMEX_ACCOUNT_PIN;
const ARAMEX_ACCOUNT_ENTITY = process.env.ARAMEX_ACCOUNT_ENTITY;
const ARAMEX_ACCOUNT_COUNTRY_CODE = process.env.ARAMEX_ACCOUNT_COUNTRY;
const ARAMEX_VERSION = process.env.ARAMEX_VERSION || 'v1';

// Shipper defaults from env (used to build Party.Contact and Party.PartyAddress)
// If any are missing we fall back to some safe defaults but we log a warning.
const SHIPPER_NAME = process.env.SHIPPER_NAME || 'Axis Auto';
const SHIPPER_EMAIL = process.env.SHIPPER_EMAIL || process.env.MAIL_FROM || '';
const SHIPPER_PHONE = process.env.SHIPPER_PHONE || '0000000000';
const SHIPPER_LINE1 = process.env.SHIPPER_LINE1 || 'Al Raq’a Al Hamra - Sheikh Mohammed Bin Zayed Road';
const SHIPPER_CITY = process.env.SHIPPER_CITY || 'Istanbul';
const SHIPPER_POSTCODE = process.env.SHIPPER_POSTCODE || '00000';
const SHIPPER_COUNTRY_CODE = process.env.SHIPPER_COUNTRY_CODE || 'TR';
const SHIPPER_REFERENCE = process.env.SHIPPER_REFERENCE || '';

// ====== Helper: build Aramex Party structure ======
function buildPartyFromShipperEnv() {
  return {
    PartyAddress: {
      Line1: SHIPPER_LINE1,
      Line2: process.env.SHIPPER_LINE2 || '',
      Line3: process.env.SHIPPER_LINE3 || '',
      City: SHIPPER_CITY,
      PostCode: SHIPPER_POSTCODE,
      CountryCode: SHIPPER_COUNTRY_CODE
    },
    Contact: {
      PersonName: SHIPPER_NAME,
      CompanyName: SHIPPER_NAME,
      PhoneNumber1: SHIPPER_PHONE,
      PhoneNumber1Ext: '',
      PhoneNumber2: '',
      CellPhone: SHIPPER_PHONE,
      EmailAddress: SHIPPER_EMAIL
    },
    Reference1: SHIPPER_REFERENCE
  };
}

function buildConsigneePartyFromStripe(session) {
  // session.customer_details may be undefined if checkout didn't collect name/address.
  const cust = session.customer_details || {};
  const addr = cust.address || {};
  const phone = cust.phone || cust.phone || '';
  const name = cust.name || (cust.email ? cust.email.split('@')[0] : 'Customer');

  return {
    PartyAddress: {
      Line1: addr.line1 || addr.AddressLine1 || '',
      Line2: addr.line2 || addr.AddressLine2 || '',
      Line3: addr.line3 || '',
      City: addr.city || '',
      PostCode: addr.postal_code || addr.PostalCode || '00000',
      CountryCode: (addr.country || addr.Country || '').toString()
    },
    Contact: {
      PersonName: name,
      CompanyName: name,
      PhoneNumber1: phone || '',
      PhoneNumber1Ext: '',
      PhoneNumber2: '',
      CellPhone: phone || '',
      EmailAddress: cust.email || ''
    }
  };
}

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
// Important: keep raw body parser here for proper signature verification
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  console.log('✅ Incoming Stripe webhook headers:', req.headers);
  console.log('✅ Incoming Stripe webhook body length:', req.body.length);

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    if (!sig) throw new Error('Missing stripe-signature header');
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err && err.message ? err.message : err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('✅ Stripe webhook verified:', event.type);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const customerEmail = session.customer_details?.email || '';
    const customerName = session.customer_details?.name || customerEmail || 'Customer';
    const address = session.customer_details?.address || {};

    // ====== Shipper (Party) - now built from env (PartyAddress + Contact) ======
    const shipperParty = buildPartyFromShipperEnv();

    // ====== Consignee (Party) - built from Stripe session (PartyAddress + Contact) ======
    const consigneeParty = buildConsigneePartyFromStripe(session);

    // ====== Details - include required fields per Aramex spec ======
    const details = {
      NumberOfPieces: 1,
      DescriptionOfGoods: 'UV Car Inspection Device',
      GoodsOriginCountry: SHIPPER_COUNTRY_CODE || 'TR',
      // ActualWeight must be provided as object { Value, Unit }
      ActualWeight: { Value: 1.0, Unit: 'KG' },
      // ProductGroup and ProductType are mandatory fields for shipments
      ProductGroup: 'EXP',  // EXP = Express (change if you need DOM)
      ProductType: 'PPX',   // PPX = Priority Parcel Express (adjust if needed)
      // PaymentType: 'P' -> Prepaid by shipper; change to 'C' if consignee pays
      PaymentType: 'P',
      // If you use COD service, you may need to include CashOnDelivery details.
      // To avoid breaking, we leave Services as-is (existing code used "CODS")
      Services: 'CODS'
    };

    // 1) إنشاء شحنة مع Aramex عبر JSON endpoint
    const shipmentData = {
      ClientInfo: {
        UserName: ARAMEX_USERNAME,
        Password: ARAMEX_PASSWORD,
        AccountNumber: ARAMEX_ACCOUNT_NUMBER,
        AccountPin: ARAMEX_ACCOUNT_PIN,
        AccountEntity: ARAMEX_ACCOUNT_ENTITY,
        AccountCountryCode: ARAMEX_ACCOUNT_COUNTRY_CODE,
        Version: ARAMEX_VERSION
      },
      LabelInfo: { ReportID: 9729, ReportType: "URL" },
      Shipments: [{
        Shipper: shipperParty,
        Consignee: consigneeParty,
        Details: details
      }]
    };

    try {
      if (!ARAMEX_API_URL) {
        throw new Error('ARAMEX API URL is not configured (env ARAMEX_WSDL_URL is empty).');
      }

      console.log('📤 Sending shipmentData to Aramex:', JSON.stringify(shipmentData, null, 2));

      const response = await axios.post(
        ARAMEX_API_URL,
        shipmentData,
        { headers: { 'Content-Type': 'application/json' } }
      );

      console.log('✅ Aramex raw response status:', response.status);
      console.log('✅ Aramex result body:', JSON.stringify(response.data, null, 2));

      // Flexible extraction: Aramex responses differ slightly between versions.
      // Try a few keys to find ProcessedShipment and label URL.
      let processed;
      if (response.data?.ProcessedShipment) {
        processed = response.data.ProcessedShipment;
      } else if (Array.isArray(response.data?.Shipments) && response.data.Shipments[0]?.ProcessedShipment) {
        processed = response.data.Shipments[0].ProcessedShipment;
      } else if (response.data?.Shipments?.ProcessedShipment) {
        processed = response.data.Shipments.ProcessedShipment;
      } else if (response.data?.ProcessedShipments) {
        processed = response.data.ProcessedShipments[0] || null;
      }

      const trackingNumber = processed?.ID || processed?.AWBNumber || 'N/A';
      // Label URL might be under LabelURL, LabelFile, or Label
      const trackingUrl = processed?.LabelURL || processed?.Label?.URL || processed?.LabelFile || 'N/A';

      console.log('📦 Tracing ->', { trackingNumber, trackingUrl });

      // 2) إرسال بريد للعميل (SendGrid)
      if (customerEmail && process.env.SENDGRID_API_KEY) {
        const msg = {
          to: customerEmail,
          from: process.env.MAIL_FROM,
          subject: 'Your Order Confirmation',
          text: `Hello ${customerName}, your order is confirmed. Tracking Number: ${trackingNumber}. Track here: ${trackingUrl}`,
          html: `<strong>Hello ${customerName}</strong><br>Your order is confirmed.<br>Tracking Number: <b>${trackingNumber}</b><br>Track here: <a href="${trackingUrl}">Link</a>`
        };

        try {
          await sgMail.send(msg);
          console.log('📧 Email sent to', customerEmail);
        } catch (err) {
          console.error('SendGrid error:', err && err.response ? err.response.body : err);
        }
      } else {
        console.warn('⚠️ Skipping email send: missing customerEmail or SENDGRID_API_KEY.');
      }

    } catch (err) {
      // Log detailed info for Render logs and continue (don't crash)
      console.error('Aramex API error:', err && err.response ? err.response.data || err.response.statusText : err.message || err);
    }
  }

  // Acknowledge webhook
  res.json({ received: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
