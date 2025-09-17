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

// Warn if any required env missing (but don't crash — we will log clearly).
const missingEnvs = REQUIRED_ENVS.filter(k => !process.env[k]);
if (missingEnvs.length) {
  console.warn('⚠️  Warning: the following environment variables are missing or empty:', missingEnvs);
  console.warn('Some functionality (Aramex / Stripe / SendGrid) may fail until these are provided.');
}

// Stripe
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || ''); // will fail if not provided during calls

// SendGrid
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Aramex WSDL URL
const ARAMEX_WSDL_URL = process.env.ARAMEX_WSDL_URL || 'https://ws.aramex.net/ShippingAPI.V2/Shipping/Service_1_0.svc?wsdl';

// Weight per piece (as requested)
const WEIGHT_PER_PIECE = 1.63; // kilograms per piece

// ---------- Utility: full allowed countries list (unchanged, complete) ----------
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

// ---------- Create Checkout Session ----------
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

    // create session
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

// Helper to convert allowedCountries to Stripe's allowed list (Stripe expects 2-letter codes uppercase)
function allowedCountriesForStripe(list) {
  return list.map(c => (typeof c === 'string' ? c.toUpperCase() : c));
}

// ---------- Stripe Webhook (raw body required) ----------
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

    // Retrieve full session with line_items to get quantity if needed
    let fullSession;
    try {
      fullSession = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items'] });
    } catch (err) {
      console.warn('Could not retrieve full Stripe session (non-fatal):', err && err.message ? err.message : err);
      fullSession = null;
    }
    const quantity = (fullSession && fullSession.line_items && fullSession.line_items.data && fullSession.line_items.data[0] && fullSession.line_items.data[0].quantity) ? fullSession.line_items.data[0].quantity : (session.quantity || 1);

    // Build shipper address (from env)
    const shipperAddress = {
      Line1: process.env.SHIPPER_LINE1 || '',
      Line2: process.env.SHIPPER_LINE2 || '(Registration Village)',
      Line3: process.env.SHIPPER_LINE3 || 'Ground Floor - Shop No. 5&6',
      City: process.env.SHIPPER_CITY || '',
      StateOrProvinceCode: process.env.SHIPPER_STATE || '', // keep empty if not applicable
      PostCode: process.env.SHIPPER_POSTCODE || '',
      CountryCode: process.env.SHIPPER_COUNTRY_CODE || '',
      ResidenceType: process.env.SHIPPER_RESIDENCE_TYPE || 'Business'
    };

    // Compose SOAP args according to Aramex docs
    const args = {
      ClientInfo: {
        UserName: process.env.ARAMEX_USER || '',
        Password: process.env.ARAMEX_PASSWORD || '',
        Version: process.env.ARAMEX_VERSION || 'v2',
        AccountNumber: process.env.ARAMEX_ACCOUNT_NUMBER || '',
        AccountPin: process.env.ARAMEX_ACCOUNT_PIN || '',
        AccountEntity: process.env.ARAMEX_ACCOUNT_ENTITY || '',
        AccountCountryCode: process.env.ARAMEX_ACCOUNT_COUNTRY || ''
      },
      Transaction: {
        Reference1: session.id || '',
        Reference2: '',
        Reference3: '',
        Reference4: '',
        Reference5: ''
      },
      LabelInfo: {
        ReportID: 9729,
        ReportType: "URL"
      },
      Shipments: {
        Shipment: [{
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
              Type: '' // <-- IMPORTANT: include Type element (empty string to satisfy schema ordering)
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
              Type: '' // <-- ensure presence
            }
          },
          Details: {
            ActualWeight: {
              Value: parseFloat((quantity * WEIGHT_PER_PIECE).toFixed(2)), // e.g., 1.63, 3.26, ...
              Unit: "KG"
            },
            ChargeableWeight: {
              Value: parseFloat((quantity * WEIGHT_PER_PIECE).toFixed(2)),
              Unit: "KG"
            },
            NumberOfPieces: quantity,
            DescriptionOfGoods: "UV Car Inspection Device",
            GoodsOriginCountry: process.env.SHIPPER_COUNTRY_CODE || '',
            ProductGroup: "EXP",
            ProductType: "PDX",
            PaymentType: "P" // prepaid
          }
        }]
      }
    };

    // Call Aramex SOAP CreateShipments
    try {
      // create client (use the WSDL URL). Increase timeout
      const client = await soap.createClientAsync(ARAMEX_WSDL_URL, { timeout: 30000 });
      // sometimes service endpoint is WSDL url without ?wsdl; ensure correct endpoint
      try {
        const endpoint = (process.env.ARAMEX_WSDL_URL && process.env.ARAMEX_WSDL_URL.indexOf('?') !== -1)
          ? process.env.ARAMEX_WSDL_URL.split('?')[0]
          : process.env.ARAMEX_WSDL_URL;
        client.setEndpoint(endpoint);
      } catch (e) {
        // ignore if cannot set endpoint
      }

      const response = await client.CreateShipmentsAsync(args);

      console.log('✅ Aramex full response:', JSON.stringify(response, null, 2));

      const result = response && response[0] ? response[0] : null;

      if (!result) {
        console.error('Aramex: empty response or unexpected format.', response);
      } else if (result.HasErrors) {
        console.error('Aramex shipment creation failed:', result.Notifications || result);
        // Optionally: send internal alert email to admin if configured
      } else {
        // success path
        const processed = result.ProcessedShipment || result.ProcessedShipments || null;
        // Depending on WSDL, ProcessedShipment may be object or array — attempt to extract tracking
        let trackingNumber = 'N/A';
        let trackingUrl = 'N/A';
        if (processed) {
          // If processed is array or object
          const p = Array.isArray(processed) ? processed[0] : processed;
          if (p && p.ID) trackingNumber = p.ID;
          if (p && p.ShipmentLabel && p.ShipmentLabel.LabelURL) trackingUrl = p.ShipmentLabel.LabelURL;
          if (p && p.ShipmentLabel && p.ShipmentLabel.Contents && typeof p.ShipmentLabel.Contents === 'string') {
            // fallback if LabelURL not present
            trackingUrl = trackingUrl === 'N/A' ? 'Label generated' : trackingUrl;
          }
        }

        // send confirmation email via SendGrid
        try {
          if (!process.env.SENDGRID_API_KEY) {
            console.warn('SendGrid API key not configured - skipping customer email.');
          } else {
            const msg = {
              to: customerEmail || process.env.MAIL_FROM,
              from: process.env.MAIL_FROM,
              subject: 'Your Order Confirmation',
              text: `Hello ${customerName || ''}, your order is confirmed. Tracking Number: ${trackingNumber}. Track here: ${trackingUrl}`,
              html: `<strong>Hello ${customerName || ''}</strong><br>Your order is confirmed.<br>Tracking Number: <b>${trackingNumber}</b><br>Track here: <a href="${trackingUrl}">Link</a>`
            };

            await sgMail.send(msg);
            console.log('📧 Email sent to', customerEmail);
          }
        } catch (err) {
          console.error('SendGrid send error:', err);
        }
      }
    } catch (err) {
      // Detailed logging for SOAP errors
      console.error('Aramex API error:', (err && err.message) ? err.message : err);
      if (err && err.root) {
        console.error('Aramex error root:', JSON.stringify(err.root, null, 2));
      }
      // Do not throw — just log; webhook should still return 200 to Stripe if processed
    }
  }

  // respond to Stripe to acknowledge receipt
  res.json({ received: true });
});

// ---------- health check ----------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------- Start server ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));

// ---------- Global error handlers to avoid silent process exit ----------
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at Promise', p, 'reason:', reason);
  // do not exit to allow container to keep running for debugging
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
  // do not exit here — log for debugging. In production you might want to exit.
});
