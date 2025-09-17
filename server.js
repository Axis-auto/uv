const requiredEnvs = [
  'STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET',
  'ARAMEX_WSDL_URL','ARAMEX_USER','ARAMEX_PASSWORD','ARAMEX_ACCOUNT_NUMBER',
  'ARAMEX_ACCOUNT_PIN','ARAMEX_ACCOUNT_ENTITY','ARAMEX_ACCOUNT_COUNTRY',
  'MAIL_FROM','SENDGRID_API_KEY',
  'SHIPPER_CITY','SHIPPER_COUNTRY_CODE','SHIPPER_EMAIL',
  'SHIPPER_LINE1','SHIPPER_NAME','SHIPPER_PHONE','SHIPPER_POSTCODE','SHIPPER_REFERENCE'
];

const missing = requiredEnvs.filter(k => !process.env[k]);
if (missing.length) {
  console.warn('⚠️ Warning: missing environment variables (not fatal):', missing);
  console.warn('If these are required for production, add them to Render env settings.');
}

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception at startup:', err && err.stack ? err.stack : err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection at startup:', reason && reason.stack ? reason.stack : reason);
  process.exit(1);
});
// ---------- END: Robust startup checks ----------

const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');
const bodyParser = require('body-parser');
const sgMail = require('@sendgrid/mail');
const soap = require('soap');

const app = express();
app.use(cors({ origin: true }));

// Stripe
let stripe;
try {
  stripe = Stripe(process.env.STRIPE_SECRET_KEY);
} catch (e) {
  console.warn('⚠️ Stripe initialization failed:', e && e.message ? e.message : e);
  stripe = null; // so the rest of the server can start for debugging
}

// SendGrid
try {
  if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  } else {
    console.warn('⚠️ SENDGRID_API_KEY not set — emails will not be sent until set.');
  }
} catch (e) {
  console.error('❌ SendGrid initialization error:', e && e.stack ? e.stack : e);
}

// ثوابت
const WEIGHT_PER_PIECE_KG = 1.63; // الوزن لكل قطعة

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

// ====== دالة مساعدة: تجربة Variants لطلب Aramex ======
async function tryCreateWithVariants(client, baseArgs, shipmentObj) {
  const variants = [];

  // Variant A: Shipment ككائن
  const vA = JSON.parse(JSON.stringify(baseArgs));
  vA.Shipments = { Shipment: shipmentObj };
  variants.push({ name: 'ShipmentObject', args: vA });

  // Variant B: Shipment كمصفوفة بطول 1
  const vB = JSON.parse(JSON.stringify(baseArgs));
  vB.Shipments = { Shipment: [ shipmentObj ] };
  variants.push({ name: 'ShipmentArray', args: vB });

  // Variant C: بدون LabelInfo
  const vC = JSON.parse(JSON.stringify(baseArgs));
  delete vC.LabelInfo;
  vC.Shipments = { Shipment: shipmentObj };
  variants.push({ name: 'NoLabelInfo', args: vC });

  for (const v of variants) {
    console.log(`🔁 Trying Aramex variant: ${v.name}`);
    try {
      const resp = await client.CreateShipmentsAsync(v.args);

      // سجّل الـ XML المُرسَل والمُستلم (node-soap يوفر lastRequest/lastResponse)
      try { if (client.lastRequest) console.log('--- client.lastRequest ---\n', client.lastRequest); } catch(e) { }
      try { if (client.lastResponse) console.log('--- client.lastResponse ---\n', client.lastResponse); } catch(e) { }

      console.log('--- response (JS) ---', JSON.stringify(resp, null, 2));

      const result = resp && resp[0];
      if (result && !result.HasErrors) {
        console.log(`✅ Success with variant: ${v.name}`);
        return { success: true, variant: v.name, response: resp };
      } else {
        console.warn(`❌ Variant ${v.name} failed:`, result && result.Notifications ? result.Notifications : result);
      }

    } catch (err) {
      console.error(`⚠️ Error calling CreateShipments (variant ${v.name}):`, err);
      try { if (client.lastRequest) console.log('--- client.lastRequest (on error) ---\n', client.lastRequest); } catch(e) {}
      try { if (client.lastResponse) console.log('--- client.lastResponse (on error) ---\n', client.lastResponse); } catch(e) {}
    }
  }

  return { success: false, message: 'All variants failed' };
}

// ====== Webhook من Stripe (مُحسّن) ======
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

    try {
      // استرجاع الجلسة الكاملة مع line_items
      const fullSession = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items'] });

      // استخراج معلومات العميل مع fallbacks
      const customerName = fullSession.customer_details?.name || fullSession.shipping?.name || fullSession.customer || 'Customer';
      const customerEmail = fullSession.customer_details?.email || fullSession.customer_email || '';
      const customerPhone = fullSession.customer_details?.phone || fullSession.shipping?.phone || '';
      const address = fullSession.customer_details?.address || fullSession.shipping?.address || {};

      const quantity = (fullSession.line_items && fullSession.line_items.data[0] && fullSession.line_items.data[0].quantity) || 1;

      // تحضير عنوان الشاحن (من متغيرات البيئة)
      const shipperAddress = {
        Line1: process.env.SHIPPER_LINE1 || '',
        Line2: process.env.SHIPPER_LINE2 || '(Registration Village)',
        Line3: process.env.SHIPPER_LINE3 || 'Ground Floor - Shop No. 5&6',
        City: process.env.SHIPPER_CITY || '',
        StateOrProvinceCode: process.env.SHIPPER_STATE || '',
        PostCode: process.env.SHIPPER_POSTCODE || '',
        CountryCode: process.env.SHIPPER_COUNTRY_CODE || '',
        ResidenceType: 'Business'
      };

      // وزن الشحنة بناءً على عدد القطع
      const totalWeight = parseFloat((quantity * WEIGHT_PER_PIECE_KG).toFixed(2));

      // بناء كائن الشحنة
      const shipmentObj = {
        Shipper: {
          Reference1: process.env.SHIPPER_REFERENCE || '',
          PartyAddress: shipperAddress,
          Contact: {
            PersonName: process.env.SHIPPER_NAME || '',
            CompanyName: process.env.SHIPPER_NAME || '',
            PhoneNumber1: process.env.SHIPPER_PHONE || '',
            PhoneNumber2: '',
            CellPhone: process.env.SHIPPER_PHONE || '',
            EmailAddress: process.env.SHIPPER_EMAIL || process.env.MAIL_FROM || ''
          }
        },
        Consignee: {
          Reference1: '',
          PartyAddress: {
            Line1: address.line1 || address.name || '',
            Line2: address.line2 || '',
            Line3: '',
            City: address.city || '',
            StateOrProvinceCode: address.state || '',
            PostCode: address.postal_code || address.postcode || '',
            CountryCode: address.country || ''
          },
          Contact: {
            PersonName: customerName,
            CompanyName: customerName,
            PhoneNumber1: customerPhone || '',
            PhoneNumber2: '',
            CellPhone: customerPhone || '',
            EmailAddress: customerEmail || ''
          }
        },
        Details: {
          ActualWeight: { Value: totalWeight, Unit: 'KG' },
          ChargeableWeight: { Value: totalWeight, Unit: 'KG' },
          NumberOfPieces: quantity,
          DescriptionOfGoods: 'UV Car Inspection Device',
          GoodsOriginCountry: process.env.SHIPPER_COUNTRY_CODE || '',
          ProductGroup: 'EXP',
          ProductType: 'PDX',
          PaymentType: 'P' // P = prepaid
        }
      };

      const args = {
        ClientInfo: {
          UserName: process.env.ARAMEX_USER,
          Password: process.env.ARAMEX_PASSWORD,
          Version: process.env.ARAMEX_VERSION || 'v2',
          AccountNumber: process.env.ARAMEX_ACCOUNT_NUMBER,
          AccountPin: process.env.ARAMEX_ACCOUNT_PIN,
          AccountEntity: process.env.ARAMEX_ACCOUNT_ENTITY,
          AccountCountryCode: process.env.ARAMEX_ACCOUNT_COUNTRY
        },
        Transaction: {
          Reference1: session.id,
          Reference2: '',
          Reference3: '',
          Reference4: '',
          Reference5: ''
        },
        LabelInfo: {
          ReportID: 9729,
          ReportType: 'URL'
        },
        Shipments: {
          Shipment: shipmentObj
        }
      };

      // سجل الـ args لأجل تتبع المشاكل
      console.log('➡️ Aramex request args:', JSON.stringify(args, null, 2));

      try {
        const client = await soap.createClientAsync(process.env.ARAMEX_WSDL_URL, { timeout: 30000 });

        // جرّب عدة صيغ آليا
        const attempt = await tryCreateWithVariants(client, args, shipmentObj);

        if (!attempt.success) {
          console.error('All Aramex variants failed. Full logs above.');
          // اختياري: أرسل بريد إداري أو سجل خطأ خارجي
        } else {
          console.log('Aramex succeeded with variant:', attempt.variant);

          // استخرج بيانات التتبع من الاستجابة المُنجحة
          const resp = attempt.response;
          const result = resp && resp[0];

          let trackingNumber = 'N/A';
          let trackingUrl = 'N/A';
          const processed = result && (result.ProcessedShipment || (result.ProcessedShipments && result.ProcessedShipments.ProcessedShipment)) || null;

          if (processed) {
            trackingNumber = processed.ID || (Array.isArray(processed) && processed[0] && processed[0].ID) || trackingNumber;
            trackingUrl = processed.ShipmentLabel && (processed.ShipmentLabel.LabelURL || (processed.ShipmentLabel[0] && processed.ShipmentLabel[0].LabelURL)) || trackingUrl;
          }

          // إرسال بريد للعميل
          const msg = {
            to: customerEmail,
            from: process.env.MAIL_FROM,
            subject: 'Your Order Confirmation',
            text: `Hello ${customerName}, your order is confirmed. Tracking Number: ${trackingNumber}. Track here: ${trackingUrl}`,
            html: `<strong>Hello ${customerName}</strong><br>Your order is confirmed.<br>Tracking Number: <b>${trackingNumber}</b><br>Track here: <a href=\"${trackingUrl}\">Link</a>`
          };

          try {
            await sgMail.send(msg);
            console.log('📧 Email sent to', customerEmail);
          } catch (err) {
            console.error('SendGrid error:', err);
          }
        }

      } catch (err) {
        console.error('Aramex API error (SOAP client):', err);
      }

    } catch (err) {
      console.error('Error processing checkout.session.completed:', err);
    }
  }

  res.json({ received: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
