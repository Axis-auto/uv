// server.js (final - full allowedCountries + manual SOAP to Aramex)
// Requires: npm i axios xml2js stripe express cors body-parser @sendgrid/mail
const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');
const bodyParser = require('body-parser');
const sgMail = require('@sendgrid/mail');
const axios = require('axios');
const { parseStringPromise } = require('xml2js');

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

// Aramex endpoint
const ARAMEX_WSDL_URL = process.env.ARAMEX_WSDL_URL || 'https://ws.aramex.net/ShippingAPI.V2/Shipping/Service_1_0.svc?wsdl';
const ARAMEX_ENDPOINT = (ARAMEX_WSDL_URL && ARAMEX_WSDL_URL.indexOf('?') !== -1) ? ARAMEX_WSDL_URL.split('?')[0] : ARAMEX_WSDL_URL;

// Weight per piece
const WEIGHT_PER_PIECE = 1.63; // kg per piece

// FULL allowed countries list (used for Stripe shipping_address_collection)
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
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function maskSensitive(obj) {
  try {
    return JSON.parse(JSON.stringify(obj, (k, v) => {
      if (!k) return v;
      const low = k.toLowerCase();
      if (low.includes('password') || low.includes('pin') || low.includes('accountpin')) return '***';
      return v;
    }));
  } catch (e) { return obj; }
}
function escapeXml(unsafe) {
  if (unsafe === null || unsafe === undefined) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildCreateShipmentsXml({ clientInfo, transactionRef, labelReportId = 9729, shipments }) {
  let shipmentsXml = shipments.map(sh => {
    const buildAddressXml = (addr) => {
      return `
        <PartyAddress>
          <Line1>${escapeXml(addr.Line1 || '')}</Line1>
          <Line2>${escapeXml(addr.Line2 || '')}</Line2>
          <Line3>${escapeXml(addr.Line3 || '')}</Line3>
          <City>${escapeXml(addr.City || '')}</City>
          <StateOrProvinceCode>${escapeXml(addr.StateOrProvinceCode || '')}</StateOrProvinceCode>
          <PostCode>${escapeXml(addr.PostCode || '')}</PostCode>
          <CountryCode>${escapeXml(addr.CountryCode || '')}</CountryCode>
          <ResidenceType>${escapeXml(addr.ResidenceType || '')}</ResidenceType>
        </PartyAddress>`;
    };
    const buildContactXml = (c) => {
      return `
        <Contact>
          <PersonName>${escapeXml(c.PersonName || '')}</PersonName>
          <CompanyName>${escapeXml(c.CompanyName || '')}</CompanyName>
          <PhoneNumber1>${escapeXml(c.PhoneNumber1 || '')}</PhoneNumber1>
          <PhoneNumber2>${escapeXml(c.PhoneNumber2 || '')}</PhoneNumber2>
          <CellPhone>${escapeXml(c.CellPhone || '')}</CellPhone>
          <EmailAddress>${escapeXml(c.EmailAddress || '')}</EmailAddress>
          <Type>${escapeXml(c.Type || '')}</Type>
        </Contact>`;
    };
    const shipAddrXml = buildAddressXml(sh.Shipper.PartyAddress || {});
    const shipContactXml = buildContactXml(sh.Shipper.Contact || {});
    const consigAddrXml = buildAddressXml(sh.Consignee.PartyAddress || {});
    const consigContactXml = buildContactXml(sh.Consignee.Contact || {});
    const details = sh.Details || {};

    return `
    <Shipment>
      <Shipper>
        <Reference1>${escapeXml(sh.Shipper.Reference1 || '')}</Reference1>
        ${shipAddrXml}
        ${shipContactXml}
      </Shipper>

      <Consignee>
        <Reference1>${escapeXml(sh.Consignee.Reference1 || '')}</Reference1>
        ${consigAddrXml}
        ${consigContactXml}
      </Consignee>

      <Details>
        <ShippingDateTime>${escapeXml(details.ShippingDateTime || new Date().toISOString())}</ShippingDateTime>
        <ActualWeight>
          <Value>${escapeXml(details.ActualWeight && details.ActualWeight.Value != null ? details.ActualWeight.Value : '')}</Value>
          <Unit>${escapeXml(details.ActualWeight && details.ActualWeight.Unit ? details.ActualWeight.Unit : 'KG')}</Unit>
        </ActualWeight>
        <ChargeableWeight>
          <Value>${escapeXml(details.ChargeableWeight && details.ChargeableWeight.Value != null ? details.ChargeableWeight.Value : '')}</Value>
          <Unit>${escapeXml(details.ChargeableWeight && details.ChargeableWeight.Unit ? details.ChargeableWeight.Unit : 'KG')}</Unit>
        </ChargeableWeight>
        <NumberOfPieces>${escapeXml(details.NumberOfPieces || 1)}</NumberOfPieces>
        <DescriptionOfGoods>${escapeXml(details.DescriptionOfGoods || '')}</DescriptionOfGoods>
        <GoodsOriginCountry>${escapeXml(details.GoodsOriginCountry || '')}</GoodsOriginCountry>
        <ProductGroup>${escapeXml(details.ProductGroup || '')}</ProductGroup>
        <ProductType>${escapeXml(details.ProductType || '')}</ProductType>
        <PaymentType>${escapeXml(details.PaymentType || '')}</PaymentType>
      </Details>
    </Shipment>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="utf-8"?>
  <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:tns="http://ws.aramex.net/ShippingAPI/v1/">
    <soap:Body>
      <ShipmentCreationRequest xmlns="http://ws.aramex.net/ShippingAPI/v1/">
        <ClientInfo>
          <UserName>${escapeXml(clientInfo.UserName || '')}</UserName>
          <Password>${escapeXml(clientInfo.Password || '')}</Password>
          <Version>${escapeXml(clientInfo.Version || '')}</Version>
          <AccountNumber>${escapeXml(clientInfo.AccountNumber || '')}</AccountNumber>
          <AccountPin>${escapeXml(clientInfo.AccountPin || '')}</AccountPin>
          <AccountEntity>${escapeXml(clientInfo.AccountEntity || '')}</AccountEntity>
          <AccountCountryCode>${escapeXml(clientInfo.AccountCountryCode || '')}</AccountCountryCode>
          <Source>${escapeXml(clientInfo.Source != null ? clientInfo.Source : '')}</Source>
        </ClientInfo>

        <Transaction>
          <Reference1>${escapeXml(transactionRef || '')}</Reference1>
          <Reference2></Reference2>
          <Reference3></Reference3>
          <Reference4></Reference4>
          <Reference5></Reference5>
        </Transaction>

        <LabelInfo>
          <ReportID>${escapeXml(labelReportId)}</ReportID>
          <ReportType>URL</ReportType>
        </LabelInfo>

        <Shipments>
          ${shipmentsXml}
        </Shipments>
      </ShipmentCreationRequest>
    </soap:Body>
  </soap:Envelope>`;

  return xml;
}

// Create Checkout Session (full implementation)
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

// Stripe Webhook (raw body)
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

    // Build shipment object (shipper from env; consignee from Stripe session)
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

    // Shipments array and chunking
    const shipmentsArray = [ shipmentObj ];
    const MAX_PER_REQUEST = parseInt(process.env.ARAMEX_MAX_SHIPMENTS_PER_REQUEST || '50', 10);
    const chunks = chunkArray(shipmentsArray, MAX_PER_REQUEST);
    console.log(`→ Will send ${shipmentsArray.length} shipment(s) in ${chunks.length} request(s) (max per request = ${MAX_PER_REQUEST})`);

    const clientInfo = {
      UserName: process.env.ARAMEX_USER || '',
      Password: process.env.ARAMEX_PASSWORD || '',
      Version: process.env.ARAMEX_VERSION || 'v2',
      AccountNumber: process.env.ARAMEX_ACCOUNT_NUMBER || '',
      AccountPin: process.env.ARAMEX_ACCOUNT_PIN || '',
      AccountEntity: process.env.ARAMEX_ACCOUNT_ENTITY || '',
      AccountCountryCode: process.env.ARAMEX_ACCOUNT_COUNTRY || '',
      Source: parseInt(process.env.ARAMEX_SOURCE || '24', 10)
    };

    const allTrackings = [];
    const allNotifications = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      const xml = buildCreateShipmentsXml({
        clientInfo,
        transactionRef: session.id || '',
        labelReportId: parseInt(process.env.ARAMEX_REPORT_ID || '9729', 10),
        shipments: chunk
      });

      // log minimal sanitized preview
      console.log(`→ Sending Aramex XML chunk ${i+1}/${chunks.length} (sanitized preview):`, JSON.stringify(maskSensitive({ ClientInfo: { UserName: clientInfo.UserName, Password: '***', AccountNumber: clientInfo.AccountNumber } })));

      try {
        const headers = { 'Content-Type': 'text/xml; charset=utf-8' };
        const resp = await axios.post(ARAMEX_ENDPOINT, xml, { headers, timeout: 30000 });

        if (resp && resp.data) {
          console.log(`⤷ Aramex raw response (chunk ${i+1} - snippet):`, (typeof resp.data === 'string' ? resp.data.substring(0, 2000) : JSON.stringify(resp.data).substring(0,2000)));
        }

        let parsed = null;
        try {
          parsed = await parseStringPromise(resp.data, { explicitArray: false, ignoreAttrs: true, trim: true });
        } catch (e) {
          console.warn('Could not parse Aramex response XML to JSON:', e && e.message ? e.message : e);
        }

        // Heuristic: attempt to find Notification nodes
        let noteArray = [];
        try {
          const top = parsed && parsed['soap:Envelope'] && parsed['soap:Envelope']['soap:Body'] ? (parsed['soap:Envelope']['soap:Body'].ShipmentCreationResponse || parsed['soap:Envelope']['soap:Body']) : parsed;
          if (top && top.Notifications && top.Notifications.Notification) {
            noteArray = Array.isArray(top.Notifications.Notification) ? top.Notifications.Notification : [top.Notifications.Notification];
          } else if (top && top.Notification) {
            noteArray = Array.isArray(top.Notification) ? top.Notification : [top.Notification];
          }
        } catch (e) { /* ignore */ }

        if (noteArray && noteArray.length) {
          console.error('Aramex shipment creation failed (chunk):', noteArray);
          allNotifications.push(...noteArray);
          // if REQ39 found, print the sent xml snippet (masked password/pin)
          noteArray.forEach(n => {
            if (n.Code && String(n.Code).includes('REQ39')) {
              console.error('→ REQ39 detected. Sent XML snippet (first 2000 chars):', xml.substring(0,2000));
            }
          });
          continue;
        }

        // Try to extract ProcessedShipment(s)
        try {
          const top = parsed && parsed['soap:Envelope'] && parsed['soap:Envelope']['soap:Body'] ? parsed['soap:Envelope']['soap:Body'] : parsed;
          const respRoot = top && (top.ShipmentCreationResponse || top);
          const processed = respRoot && (respRoot.ProcessedShipment || respRoot.ProcessedShipments) ? (respRoot.ProcessedShipment || respRoot.ProcessedShipments) : null;
          if (processed) {
            if (Array.isArray(processed)) {
              processed.forEach(p => {
                const id = (p && p.ID) ? p.ID : (p && p.ShipmentID ? p.ShipmentID : 'N/A');
                const labelUrl = p && p.ShipmentLabel && p.ShipmentLabel.LabelURL ? p.ShipmentLabel.LabelURL : (p && p.LabelURL ? p.LabelURL : 'N/A');
                allTrackings.push({ id, url: labelUrl });
              });
            } else {
              const p = processed;
              const id = (p && p.ID) ? p.ID : (p && p.ShipmentID ? p.ShipmentID : 'N/A');
              const labelUrl = p && p.ShipmentLabel && p.ShipmentLabel.LabelURL ? p.ShipmentLabel.LabelURL : (p && p.LabelURL ? p.LabelURL : 'N/A');
              allTrackings.push({ id, url: labelUrl });
            }
          } else {
            allNotifications.push({ Code: 'NO_PROCESSED', Message: 'No ProcessedShipment found for chunk ' + (i+1) });
            console.warn('Aramex: no ProcessedShipment found in response for chunk', i+1);
          }
        } catch (e) {
          console.error('Error extracting processed shipments from Aramex response:', e && e.message ? e.message : e);
        }

      } catch (err) {
        console.error(`Aramex HTTP call error for chunk ${i+1}:`, (err && err.message) ? err.message : err);
        allNotifications.push({ Code: 'CALL_ERROR', Message: (err && err.message) ? err.message : 'Unknown error' });
      }
    } // end chunks loop

    // Send email if we have tracking info
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
  } // end if checkout.session.completed

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
