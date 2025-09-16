// server.js (final - with required Aramex fields: Contact.Type, ShippingDateTime, ClientInfo.Source)
const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');
const bodyParser = require('body-parser');
const sgMail = require('@sendgrid/mail');
const axios = require('axios');

const app = express();
app.use(cors({ origin: true }));

// ---- Environment / config ----
const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  SENDGRID_API_KEY,
  MAIL_FROM,
  ARAMEX_USER,
  ARAMEX_PASSWORD,
  ARAMEX_ACCOUNT_NUMBER,
  ARAMEX_ACCOUNT_PIN,
  ARAMEX_ACCOUNT_ENTITY,
  ARAMEX_ACCOUNT_COUNTRY,
  ARAMEX_WSDL_URL, // kept name to avoid breaking your Render env
  ARAMEX_VERSION,
  ARAMEX_SOURCE, // optional, default 24
  SHIPPER_NAME,
  SHIPPER_EMAIL,
  SHIPPER_PHONE,
  SHIPPER_LINE1,
  SHIPPER_LINE2,
  SHIPPER_LINE3,
  SHIPPER_CITY,
  SHIPPER_POSTCODE,
  SHIPPER_COUNTRY_CODE,
  SHIPPER_REFERENCE,
  SHIPPER_CONTACT_TYPE,
  CONSIGNEE_CONTACT_TYPE
} = process.env;

// minimal missing env warning
const required = ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','MAIL_FROM','ARAMEX_USER','ARAMEX_PASSWORD','ARAMEX_ACCOUNT_NUMBER','ARAMEX_ACCOUNT_PIN','ARAMEX_ACCOUNT_ENTITY','ARAMEX_ACCOUNT_COUNTRY','ARAMEX_WSDL_URL'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) console.warn('⚠️ Missing env vars:', missing.join(', '));

const stripe = Stripe(STRIPE_SECRET_KEY || '');
if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);

// defaults
const ARAMEX_API_URL = ARAMEX_WSDL_URL || '';
const ARAMEX_VER = ARAMEX_VERSION || 'v1';
const ARAMEX_SRC = ARAMEX_SOURCE || 24;

const SHIPPER = {
  name: SHIPPER_NAME || 'Axis Auto',
  email: SHIPPER_EMAIL || MAIL_FROM || '',
  phone: SHIPPER_PHONE || '0000000000',
  line1: SHIPPER_LINE1 || 'Al Raq’a Al Hamra - Sheikh Mohammed Bin Zayed Road',
  line2: SHIPPER_LINE2 || '',
  line3: SHIPPER_LINE3 || '',
  city: SHIPPER_CITY || 'Istanbul',
  postcode: SHIPPER_POSTCODE || '00000',
  country: SHIPPER_COUNTRY_CODE || 'TR',
  reference: SHIPPER_REFERENCE || '',
  contactType: SHIPPER_CONTACT_TYPE || '' // we send the field (even empty) to satisfy deserializer
};

// helper builders
function buildShipperParty() {
  return {
    PartyAddress: {
      Line1: SHIPPER.line1,
      Line2: SHIPPER.line2,
      Line3: SHIPPER.line3,
      City: SHIPPER.city,
      PostCode: SHIPPER.postcode,
      CountryCode: SHIPPER.country
    },
    Contact: {
      Department: '',
      PersonName: SHIPPER.name,
      Title: '',
      CompanyName: SHIPPER.name,
      PhoneNumber1: SHIPPER.phone,
      PhoneNumber1Ext: '',
      PhoneNumber2: '',
      PhoneNumber2Ext: '',
      FaxNumber: '',
      CellPhone: SHIPPER.phone,
      EmailAddress: SHIPPER.email,
      Type: SHIPPER.contactType // include Type member (may be empty but present)
    },
    Reference1: SHIPPER.reference
  };
}

function buildConsigneePartyFromSession(session) {
  const cust = session.customer_details || {};
  const addr = cust.address || {};
  const phone = session.customer_details?.phone || '';
  const name = session.customer_details?.name || (session.customer_email ? session.customer_email.split('@')[0] : 'Customer');

  return {
    PartyAddress: {
      Line1: addr.line1 || '',
      Line2: addr.line2 || '',
      Line3: addr.line3 || '',
      City: addr.city || '',
      PostCode: addr.postal_code || '00000',
      CountryCode: addr.country || ''
    },
    Contact: {
      Department: '',
      PersonName: name,
      Title: '',
      CompanyName: name,
      PhoneNumber1: phone || '',
      PhoneNumber1Ext: '',
      PhoneNumber2: '',
      PhoneNumber2Ext: '',
      FaxNumber: '',
      CellPhone: phone || '',
      EmailAddress: cust.email || session.customer_email || '',
      Type: CONSIGNEE_CONTACT_TYPE || '' // include Type
    }
  };
}

// ----- Checkout session (same logic as before) -----
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
      ? [{ shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: c.shipping, currency }, display_name: 'Standard Shipping', delivery_estimate: { minimum: { unit: 'business_day', value: 5 }, maximum: { unit: 'business_day', value: 7 } } } }]
      : [{ shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: 0, currency }, display_name: 'Free Shipping', delivery_estimate: { minimum: { unit: 'business_day', value: 5 }, maximum: { unit: 'business_day', value: 7 } } } }];

    const allowedCountries = [ /* same list you had before; omitted for brevity in this snippet */ 'TR','US','GB','DE','FR','AE','EG']; // keep original full list in your file

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

// ----- Stripe webhook (raw body) -----
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  console.log('Webhook headers:', req.headers);
  console.log('Webhook body length:', req.body.length);

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    if (!sig) throw new Error('Missing stripe-signature header');
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Verified event:', event.type);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerEmail = session.customer_details?.email || session.customer_email || '';
    const customerName = session.customer_details?.name || customerEmail || 'Customer';

    // build parties
    const shipperParty = buildShipperParty();
    const consigneeParty = buildConsigneePartyFromSession(session);

    // build details (required/important fields)
    const details = {
      NumberOfPieces: 1,
      DescriptionOfGoods: 'UV Car Inspection Device',
      GoodsOriginCountry: SHIPPER.country || 'TR',
      ActualWeight: { Value: 1.0, Unit: 'KG' }, // required
      ProductGroup: 'EXP', // required
      ProductType: 'PPX',  // required (choose correct code for your product)
      PaymentType: 'P',    // 'P' = prepaid by shipper
      Services: ''         // optional; fill if you need COD etc.
    };

    // ShippingDateTime is marked required in Shipment elements (include current datetime)
    const shippingDateTime = new Date().toISOString();

    const payload = {
      ClientInfo: {
        UserName: ARAMEX_USER,
        Password: ARAMEX_PASSWORD,
        AccountNumber: ARAMEX_ACCOUNT_NUMBER,
        AccountPin: ARAMEX_ACCOUNT_PIN,
        AccountEntity: ARAMEX_ACCOUNT_ENTITY,
        AccountCountryCode: ARAMEX_ACCOUNT_COUNTRY,
        Version: ARAMEX_VER,
        Source: ARAMEX_SRC
      },
      LabelInfo: { ReportID: 9729, ReportType: 'URL' },
      Shipments: [{
        Reference1: session.id || '',
        ShippingDateTime: shippingDateTime,
        Shipper: shipperParty,
        Consignee: consigneeParty,
        Details: details
      }]
    };

    try {
      if (!ARAMEX_API_URL) throw new Error('ARAMEX_API_URL (env ARAMEX_WSDL_URL) not configured.');

      console.log('Sending to Aramex:', JSON.stringify(payload, null, 2));
      const resp = await axios.post(ARAMEX_API_URL, payload, { headers: { 'Content-Type': 'application/json' } });
      console.log('Aramex response status:', resp.status);
      console.log('Aramex response data:', JSON.stringify(resp.data, null, 2));

      // try multiple positions for processed shipment
      let processed = resp.data?.ProcessedShipment || (Array.isArray(resp.data?.Shipments) ? resp.data.Shipments[0]?.ProcessedShipment : resp.data?.Shipments?.ProcessedShipment) || (resp.data?.ProcessedShipments?.[0]) || null;
      const trackingNumber = processed?.ID || processed?.AWBNumber || 'N/A';
      const labelUrl = processed?.LabelURL || processed?.Label?.URL || processed?.LabelFile || null;

      console.log('Tracking:', { trackingNumber, labelUrl });

      // send email via SendGrid if configured
      if (customerEmail && SENDGRID_API_KEY) {
        const msg = {
          to: customerEmail,
          from: MAIL_FROM,
          subject: 'Your Order Confirmation',
          text: `Hello ${customerName}, your order is confirmed. Tracking Number: ${trackingNumber}.`,
          html: `<strong>Hello ${customerName}</strong><br>Your order is confirmed.<br>Tracking Number: <b>${trackingNumber}</b><br>${labelUrl ? `<a href="${labelUrl}">Track/Label</a>` : ''}`
        };
        try { await sgMail.send(msg); console.log('Email sent to', customerEmail); }
        catch (e) { console.error('SendGrid send error:', e && e.response ? e.response.body : e); }
      } else {
        console.warn('Skipping email: customerEmail or SENDGRID_API_KEY missing.');
      }
    } catch (err) {
      console.error('Aramex API error:', err && err.response ? err.response.data || err.response.statusText : err.message || err);
    }
  }

  res.json({ received: true });
});

// start
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
