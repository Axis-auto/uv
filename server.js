// server.js (updated with Aramex normalization + chunking + better logging)
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

// Aramex WSDL URL (fallback)
const ARAMEX_WSDL_URL = process.env.ARAMEX_WSDL_URL || 'https://ws.aramex.net/ShippingAPI.V2/Shipping/Service_1_0.svc?wsdl';

// Weight per piece
const WEIGHT_PER_PIECE = 1.63; // kg per piece

// Full allowed countries (unchanged)
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

// --- Helpers ---

// Normalize shipments: if Shipments.Shipment is an array of length 1 convert to an object
function normalizeShipments(args) {
  if (!args || !args.Shipments) return args;
  const s = args.Shipments.Shipment;
  if (Array.isArray(s) && s.length === 1) args.Shipments.Shipment = s[0];
  return args;
}

// Chunk array into smaller arrays of given size
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Mask sensitive fields for logging preview
function maskSensitive(obj) {
  try {
    return JSON.parse(JSON.stringify(obj, (k, v) => {
      if (!k) return v;
      const low = k.toLowerCase();
      if (low.includes('password') || low.includes('pin') || low.includes('accountpin')) return '***';
      return v;
    }));
  } catch (e) {
    return obj;
  }
}

// Create Checkout Session
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
            delivery_estimate: { minimum: { unit: 'business_day', value: 5 }, maximum: { unit: 'business_day', value: 7 } }
          }
        }]
      : [{
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 0, currency },
            display_name: 'Free Shipping',
            delivery_estimate: { minimum: { unit: 'business_day', value: 5 }, maximum: { unit: 'business_day', value: 7 } }
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
    console.error('Create session error:', err && err.message ? err.message : err);
    res.status(500).json({ error: err.message });
  }
});

// Stripe Webhook (raw body required)
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

  console.log('✅ Stripe webhook verified:', event.type);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const customerEmail = session.customer_details && session.customer_details.email ? session.customer_details.email : '';
    const customerName = session.customer_details && session.customer_details.name ? session.customer_details.name : '';
    const address = session.customer_details && session.customer_details.address ? session.customer_details.address : {};
    const phone = session.customer_details && session.customer_details.phone ? session.customer_details.phone : (session.customer ? session.customer.phone : '');

    // get full session for quantity
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
        ShippingDateTime: (new Date()).toISOString(),
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

    // Ensure shipments list (we support single object or array)
    const shipmentsArray = Array.isArray(shipmentObj) ? shipmentObj : [shipmentObj];
    const MAX_PER_REQUEST = parseInt(process.env.ARAMEX_MAX_SHIPMENTS_PER_REQUEST || '50', 10);

    // Prepare SOAP client once
    try {
      const client = await soap.createClientAsync(ARAMEX_WSDL_URL, { timeout: 30000 });

      // optionally set endpoint without query string
      try {
        const endpoint = (process.env.ARAMEX_WSDL_URL && process.env.ARAMEX_WSDL_URL.indexOf('?') !== -1)
          ? process.env.ARAMEX_WSDL_URL.split('?')[0]
          : process.env.ARAMEX_WSDL_URL;
        client.setEndpoint(endpoint);
      } catch (e) { /* ignore endpoint set errors */ }

      // chunk shipments to avoid exceeding server-per-request limits
      const chunks = chunkArray(shipmentsArray, MAX_PER_REQUEST);
      console.log(`→ Will send ${shipmentsArray.length} shipment(s) in ${chunks.length} request(s) (max per request = ${MAX_PER_REQUEST})`);

      const allTrackings = [];
      const allNotifications = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        const args = {
          ClientInfo: {
            UserName: process.env.ARAMEX_USER || '',
            Password: process.env.ARAMEX_PASSWORD || '',
            Version: process.env.ARAMEX_VERSION || 'v2',
            AccountNumber: process.env.ARAMEX_ACCOUNT_NUMBER || '',
            AccountPin: process.env.ARAMEX_ACCOUNT_PIN || '',
            AccountEntity: process.env.ARAMEX_ACCOUNT_ENTITY || '',
            AccountCountryCode: process.env.ARAMEX_ACCOUNT_COUNTRY || '',
            Source: parseInt(process.env.ARAMEX_SOURCE || '24', 10)
          },
          Transaction: { Reference1: session.id || '', Reference2: '', Reference3: '', Reference4: '', Reference5: '' },
          LabelInfo: { ReportID: parseInt(process.env.ARAMEX_REPORT_ID || '9729', 10), ReportType: "URL" },
          Shipments: { Shipment: chunk }
        };

        // sanitize preview log
        try {
          const debugArgs = maskSensitive(args);
          console.log(`→ Prepared Aramex CreateShipments args chunk ${i+1}/${chunks.length} (sanitized):`, JSON.stringify(debugArgs, null, 2));
        } catch (e) {
          console.log(`→ Prepared Aramex args chunk ${i+1}/${chunks.length} (could not stringify fully)`);
        }

        // normalize shape expected by Aramex (object vs array)
        normalizeShipments(args);

        // call Aramex for this chunk
        try {
          const response = await client.CreateShipmentsAsync(args);
          console.log(`✅ Aramex response (chunk ${i+1}/${chunks.length}):`, Array.isArray(response) ? '(array) length ' + response.length : typeof response);

          const result = Array.isArray(response) && response[0] ? response[0] : response;
          if (!result) {
            console.error('Aramex: empty response or unexpected format for chunk', i+1, response);
            allNotifications.push({ Code: 'NO_RESPONSE', Message: `Empty/unexpected response for chunk ${i+1}` });
            continue;
          }

          if (result.HasErrors) {
            console.error('Aramex shipment creation failed (chunk):', result.Notifications || result);
            // normalize notifications
            const notes = result.Notifications && result.Notifications.Notification
              ? (Array.isArray(result.Notifications.Notification) ? result.Notifications.Notification : [result.Notifications.Notification])
              : (result.Notifications || []);
            allNotifications.push(...(notes || []));
            continue;
          } else {
            // success path: extract processed shipments (could be single or multiple)
            const processed = result.ProcessedShipment || result.ProcessedShipments || null;
            if (processed) {
              if (Array.isArray(processed)) {
                processed.forEach(p => {
                  const id = p && p.ID ? p.ID : 'N/A';
                  const url = p && p.ShipmentLabel && p.ShipmentLabel.LabelURL ? p.ShipmentLabel.LabelURL : (p && p.ShipmentLabel ? p.ShipmentLabel : 'N/A');
                  allTrackings.push({ id, url });
                });
              } else {
                const p = processed;
                const id = p && p.ID ? p.ID : 'N/A';
                const url = p && p.ShipmentLabel && p.ShipmentLabel.LabelURL ? p.ShipmentLabel.LabelURL : (p && p.ShipmentLabel ? p.ShipmentLabel : 'N/A');
                allTrackings.push({ id, url });
              }
            } else {
              // sometimes API returns differently — safety
              console.warn('Aramex returned success but no ProcessedShipment(s) found for chunk', i+1, result);
            }
          }

          // log lastRequest snippet (helps debugging account-level errors)
          try {
            if (client && client.lastRequest) {
              console.log('⤷ Aramex lastRequest XML (snippet):', client.lastRequest.substring(0, 2000));
            }
          } catch (e) {
            console.log('⤷ Could not log client.lastRequest:', e && e.message ? e.message : e);
          }

        } catch (err) {
          console.error(`Aramex API call error for chunk ${i+1}:`, (err && err.message) ? err.message : err);
          if (err && err.root) {
            try { console.error('Aramex error root:', JSON.stringify(err.root, null, 2)); } catch (e) { console.error(err.root); }
          }
          allNotifications.push({ Code: 'CALL_ERROR', Message: (err && err.message) ? err.message : 'Unknown error' });
        }
      } // end chunks loop

      // After all chunks: send email if we have tracking info, otherwise log notifications
      if (allTrackings.length) {
        try {
          if (process.env.SENDGRID_API_KEY) {
            const trackingLines = allTrackings.map(t => `Tracking Number: ${t.id} — Label: ${t.url}`).join('\n');
            const htmlLines = allTrackings.map(t => `<li><b>${t.id}</b> — <a href="${t.url}">Label</a></li>`).join('');
            const msg = {
              to: customerEmail || process.env.MAIL_FROM,
              from: process.env.MAIL_FROM,
              subject: 'Your Order Confirmation & Tracking',
              text: `Hello ${customerName || ''}, your order is confirmed.\n\n${trackingLines}`,
              html: `<strong>Hello ${customerName || ''}</strong><br>Your order is confirmed.<br><ul>${htmlLines}</ul>`
            };
            await sgMail.send(msg);
            console.log('📧 Email sent to', customerEmail, 'with tracking info');
          } else {
            console.warn('SendGrid API key not configured - skipping email.');
          }
        } catch (err) {
          console.error('SendGrid send error:', err && err.message ? err.message : err);
        }
      } else {
        console.error('No tracking numbers generated. Aramex notifications:', allNotifications);
      }

    } catch (err) {
      console.error('Aramex client creation / request error:', (err && err.message) ? err.message : err);
      if (err && err.root) {
        try { console.error('Aramex error root:', JSON.stringify(err.root, null, 2)); } catch (e) { console.error(err.root); }
      }
    }
  }

  // respond to Stripe webhook
  res.json({ received: true });
});

// health
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// start
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));

// global handlers
process.on('unhandledRejection', (reason, p) => console.error('Unhandled Rejection at Promise', p, 'reason:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught Exception thrown:', err));
