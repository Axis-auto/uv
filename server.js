// كامل server.js — Enhanced Aramex debugging + multiple payload attempts
const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');
const bodyParser = require('body-parser');
const sgMail = require('@sendgrid/mail');
const soap = require('soap');

const app = express();
app.use(cors({ origin: true }));

// ---------- Configuration & Env-check ----------
const REQUIRED_ENVS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SENDGRID_API_KEY',
  'MAIL_FROM',
  'ARAMEX_WSDL_URL',
  'ARAMEX_USER',
  'ARAMEX_PASSWORD',
  'ARAMEX_ACCOUNT_NUMBER',
  'ARAMEX_ACCOUNT_PIN',
  'ARAMEX_ACCOUNT_ENTITY',
  'ARAMEX_ACCOUNT_COUNTRY',
  'SHIPPER_LINE1',
  'SHIPPER_CITY',
  'SHIPPER_POSTCODE',
  'SHIPPER_COUNTRY_CODE',
  'SHIPPER_NAME',
  'SHIPPER_PHONE'
];

const missingEnvs = REQUIRED_ENVS.filter(k => !process.env[k]);
if (missingEnvs.length) {
  console.warn('⚠️  Warning: the following environment variables are missing or empty:', missingEnvs);
}

// Stripe
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');

// SendGrid
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Aramex WSDL
const ARAMEX_WSDL_URL = process.env.ARAMEX_WSDL_URL || 'https://ws.aramex.net/ShippingAPI.V2/Shipping/Service_1_0.svc?wsdl';
const WEIGHT_PER_PIECE = 1.63;

// full allowedCountries unchanged
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

function allowedCountriesForStripe(list) {
  return list.map(c => (typeof c === 'string' ? c.toUpperCase() : c));
}

// Helper: normalize shipments (object vs array)
function normalizeShipments(args) {
  if (!args || !args.Shipments) return args;
  const s = args.Shipments.Shipment;
  if (Array.isArray(s) && s.length === 1) args.Shipments.Shipment = s[0];
  return args;
}

// NEW: low-level helper to attempt / log CreateShipments variations
async function tryCreateShipmentsVariants(client, originalArgs) {
  // We'll attempt multiple payload shapes and always capture client.lastRequest/lastResponse
  const attempts = [];

  // Variant A: normalized single object
  const a = JSON.parse(JSON.stringify(originalArgs));
  normalizeShipments(a);
  attempts.push({name: 'object', args: a});

  // Variant B: ensure Shipment is an array
  const b = JSON.parse(JSON.stringify(originalArgs));
  if (b && b.Shipments) {
    if (!Array.isArray(b.Shipments.Shipment)) b.Shipments.Shipment = [b.Shipments.Shipment];
  }
  attempts.push({name: 'array', args: b});

  // Variant C: explicit wrapper (alternate namespace-safe attempt) — keep same as array but show difference
  const c = JSON.parse(JSON.stringify(b));
  // nothing special here, but keep as separate attempt for visibility
  attempts.push({name: 'array-2', args: c});

  for (let i = 0; i < attempts.length; i++) {
    const at = attempts[i];
    console.log(`--- ARAMEX ATTEMPT ${i+1} (${at.name}) — sending payload (json preview):`);
    try {
      // log a small preview (avoid huge output)
      console.log(JSON.stringify(at.args, (k, v) => (k === 'ClientInfo' ? '<clientinfo redacted>' : v), 2));
      const response = await client.CreateShipmentsAsync(at.args);
      // always log the raw XML request/response produced by node-soap
      try {
        console.error(`Aramex lastRequest XML (attempt ${i+1}, ${at.name}):\n`, client.lastRequest || '<no lastRequest>');
        console.error(`Aramex lastResponse XML (attempt ${i+1}, ${at.name}):\n`, client.lastResponse || '<no lastResponse>');
      } catch (e) {
        console.error('Could not print lastRequest/lastResponse:', e);
      }
      console.log(`--- Received response for attempt ${i+1} (${at.name}):`, JSON.stringify(response && response[0] ? response[0] : response, null, 2));
      // return response immediately if not HasErrors
      const resObj = response && response[0] ? response[0] : null;
      if (resObj && (!resObj.HasErrors || resObj.HasErrors === false)) {
        console.log(`Aramex accepted payload on attempt ${i+1} (${at.name}).`);
        return response;
      } else {
        // if HasErrors, continue to next attempt but keep last response for inspection
        console.warn(`Aramex reported errors on attempt ${i+1} (${at.name}).`);
        // continue loop to try next variant
      }
    } catch (err) {
      console.error(`CreateShipmentsAsync error on attempt ${i+1} (${at.name}):`, err && err.message ? err.message : err);
      try {
        console.error(`Aramex lastRequest (error) attempt ${i+1}:\n`, client.lastRequest || '<no lastRequest>');
        console.error(`Aramex lastResponse (error) attempt ${i+1}:\n`, client.lastResponse || '<no lastResponse>');
      } catch (e) {
        console.error('Could not print lastRequest/lastResponse after error:', e);
      }
      // continue to next attempt
    }
  }

  // if we exit loop, all attempts failed -> return last attempt's response if available or throw
  throw new Error('All Aramex CreateShipments attempts failed (see logs for each attempt lastRequest/lastResponse).');
}

// Create Checkout Session (unchanged)
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
      shipping_address_collection: { allowed_countries: allowedCountriesForStripe(allowedCountries) },
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

// Webhook
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  console.log('✅ Incoming Stripe webhook headers:', req.headers);
  console.log('✅ Incoming Stripe webhook body length:', req.body.length);

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err && err.message ? err.message : err);
    return res.status(400).send(`Webhook Error: ${err && err.message ? err.message : 'invalid signature'}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerEmail = session.customer_details && session.customer_details.email ? session.customer_details.email : '';
    const customerName = session.customer_details && session.customer_details.name ? session.customer_details.name : '';
    const address = session.customer_details && session.customer_details.address ? session.customer_details.address : {};
    const phone = session.customer_details && session.customer_details.phone ? session.customer_details.phone : (session.customer ? session.customer.phone : '');

    let fullSession;
    try {
      fullSession = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items'] });
    } catch (err) {
      console.warn('Could not retrieve full Stripe session (non-fatal):', err && err.message ? err.message : err);
      fullSession = null;
    }
    const quantity = (fullSession && fullSession.line_items && fullSession.line_items.data && fullSession.line_items.data[0] && fullSession.line_items.data[0].quantity) ? fullSession.line_items.data[0].quantity : (session.quantity || 1);

    const shipperAddress = {
      Line1: process.env.SHIPPER_LINE1 || '',
      Line2: process.env.SHIPPER_LINE2 || '(Registration Village)',
      Line3: process.env.SHIPPER_LINE3 || 'Ground Floor - Shop No. 5&6',
      City: process.env.SHIPPER_CITY || '',
      StateOrProvinceCode: process.env.SHIPPER_STATE || '',
      PostCode: process.env.SHIPPER_POSTCODE || '',
      CountryCode: process.env.SHIPPER_COUNTRY_CODE || '',
      ResidenceType: process.env.SHIPPER_RESIDENCE_TYPE || 'Business'
    };

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
          EmailAddress: process.env.SHIPPER_EMAIL || process.env.MAIL_FROM || '',
          Type: ''
        }
      },
      Consignee: {
        Reference1: '',
        PartyAddress: {
          Line1: address.line1 || (session.customer_details && session.customer_details.name ? session.customer_details.name : ''),
          Line2: address.line2 || '',
          Line3: '',
          City: address.city || '',
          StateOrProvinceCode: address.state || '',
          PostCode: address.postal_code || '',
          CountryCode: address.country || ''
        },
        Contact: {
          PersonName: customerName || '',
          CompanyName: customerName || '',
          PhoneNumber1: phone || '',
          PhoneNumber2: '',
          CellPhone: phone || '',
          EmailAddress: customerEmail || '',
          Type: ''
        }
      },
      Details: {
        ActualWeight: { Value: parseFloat((quantity * WEIGHT_PER_PIECE).toFixed(2)), Unit: "KG" },
        ChargeableWeight: { Value: parseFloat((quantity * WEIGHT_PER_PIECE).toFixed(2)), Unit: "KG" },
        NumberOfPieces: quantity,
        DescriptionOfGoods: "UV Car Inspection Device",
        GoodsOriginCountry: process.env.SHIPPER_COUNTRY_CODE || '',
        ProductGroup: "EXP",
        ProductType: "PDX",
        PaymentType: "P"
      }
    };

    const baseArgs = {
      ClientInfo: {
        UserName: process.env.ARAMEX_USER || '',
        Password: process.env.ARAMEX_PASSWORD || '',
        Version: process.env.ARAMEX_VERSION || 'v2',
        AccountNumber: process.env.ARAMEX_ACCOUNT_NUMBER || '',
        AccountPin: process.env.ARAMEX_ACCOUNT_PIN || '',
        AccountEntity: process.env.ARAMEX_ACCOUNT_ENTITY || '',
        AccountCountryCode: process.env.ARAMEX_ACCOUNT_COUNTRY || ''
      },
      Transaction: { Reference1: session.id || '', Reference2: '', Reference3: '', Reference4: '', Reference5: '' },
      LabelInfo: { ReportID: 9729, ReportType: "URL" },
      Shipments: { Shipment: shipmentObj }
    };

    let client = null;
    try {
      client = await soap.createClientAsync(ARAMEX_WSDL_URL, { timeout: 30000 });
      try {
        const endpoint = (process.env.ARAMEX_WSDL_URL && process.env.ARAMEX_WSDL_URL.indexOf('?') !== -1)
          ? process.env.ARAMEX_WSDL_URL.split('?')[0]
          : process.env.ARAMEX_WSDL_URL;
        client.setEndpoint(endpoint);
      } catch (e) { /* ignore */ }

      // Try variants and log everything
      try {
        const response = await tryCreateShipmentsVariants(client, baseArgs);
        console.log('✅ Aramex final response:', JSON.stringify(response, null, 2));

        const result = response && response[0] ? response[0] : null;
        if (!result) {
          console.error('Aramex: empty response or unexpected format.', response);
        } else if (result.HasErrors) {
          console.error('Aramex shipment creation failed (after all attempts):', result.Notifications || result);
        } else {
          // success path: send email etc (same as before)
          const processed = result.ProcessedShipment || result.ProcessedShipments || null;
          let trackingNumber = 'N/A', trackingUrl = 'N/A';
          if (processed) {
            const p = Array.isArray(processed) ? processed[0] : processed;
            if (p && p.ID) trackingNumber = p.ID;
            if (p && p.ShipmentLabel && p.ShipmentLabel.LabelURL) trackingUrl = p.ShipmentLabel.LabelURL;
          }
          try {
            if (process.env.SENDGRID_API_KEY) {
              const msg = {
                to: customerEmail || process.env.MAIL_FROM,
                from: process.env.MAIL_FROM,
                subject: 'Your Order Confirmation',
                text: `Hello ${customerName || ''}, your order is confirmed. Tracking Number: ${trackingNumber}. Track here: ${trackingUrl}`,
                html: `<strong>Hello ${customerName || ''}</strong><br>Your order is confirmed.<br>Tracking Number: <b>${trackingNumber}</b><br>Track here: <a href="${trackingUrl}">Link</a>`
              };
              await sgMail.send(msg);
              console.log('📧 Email sent to', customerEmail);
            } else {
              console.warn('SendGrid API key not configured - skipping email.');
            }
          } catch (err) {
            console.error('SendGrid send error:', err);
          }
        }
      } catch (err) {
        console.error('All attempts to CreateShipments failed. See above logs for each attempt lastRequest/lastResponse.', err && err.message ? err.message : err);
      }

    } catch (err) {
      console.error('Aramex API error (outer):', (err && err.message) ? err.message : err);
      try { console.error('Aramex lastRequest (outer):\n', client && client.lastRequest); } catch (e) {}
      try { console.error('Aramex lastResponse (outer):\n', client && client.lastResponse); } catch (e) {}
    }
  }

  res.json({ received: true });
});

// health & start (unchanged)
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));

// global error handlers
process.on('unhandledRejection', (reason, p) => console.error('Unhandled Rejection at Promise', p, 'reason:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught Exception thrown:', err));
