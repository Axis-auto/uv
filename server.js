// server.js — Aramex XML with soapenv/v1 prefixes + SOAPAction + detailed error logs
const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');
const bodyParser = require('body-parser');
const sgMail = require('@sendgrid/mail');
const axios = require('axios');
const { parseStringPromise } = require('xml2js');

const app = express();
app.use(cors({ origin: true }));

// ---------- ENV check ----------
const REQUIRED_ENVS = [
  'STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','MAIL_FROM',
  'ARAMEX_WSDL_URL','ARAMEX_USER','ARAMEX_PASSWORD','ARAMEX_ACCOUNT_NUMBER',
  'ARAMEX_ACCOUNT_PIN','ARAMEX_ACCOUNT_ENTITY','ARAMEX_ACCOUNT_COUNTRY',
  'SHIPPER_LINE1','SHIPPER_CITY','SHIPPER_POSTCODE','SHIPPER_COUNTRY_CODE','SHIPPER_NAME','SHIPPER_PHONE'
];
const missingEnvs = REQUIRED_ENVS.filter(k => !process.env[k]);
if (missingEnvs.length) console.warn('⚠️ Missing envs:', missingEnvs);

// Stripe init (unchanged behavior)
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');

// SendGrid (optional)
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Aramex endpoint (use base URL without ?wsdl)
const ARAMEX_WSDL_URL = process.env.ARAMEX_WSDL_URL || 'https://ws.aramex.net/ShippingAPI.V2/Shipping/Service_1_0.svc?wsdl';
const ARAMEX_ENDPOINT = ARAMEX_WSDL_URL.indexOf('?') !== -1 ? ARAMEX_WSDL_URL.split('?')[0] : ARAMEX_WSDL_URL;

// constants
const WEIGHT_PER_PIECE = 1.63; // kg per piece
const DEFAULT_SOURCE = parseInt(process.env.ARAMEX_SOURCE || '24', 10);
const DEFAULT_REPORT_ID = parseInt(process.env.ARAMEX_REPORT_ID || '9729', 10);
const MAX_PER_REQUEST = parseInt(process.env.ARAMEX_MAX_SHIPMENTS_PER_REQUEST || '50', 10);

// Full allowed countries for Stripe shipping collection (kept)
const allowedCountries = [ /* full list same as before — keep it */ 
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
function allowedCountriesForStripe(list) { return list.map(c => (typeof c === 'string' ? c.toUpperCase() : c)); }

// helpers
function escapeXml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
function chunkArray(arr, size){ const out=[]; for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }
function maskForLog(obj){
  try { return JSON.parse(JSON.stringify(obj, (k,v)=>{ if(!k) return v; const lk=k.toLowerCase(); if(lk.includes('password')||lk.includes('pin')) return '***'; return v;})); }
  catch(e){ return obj; }
}

// Build Aramex ShipmentCreation XML with soapenv and v1 prefixes (matches Aramex examples)
function buildShipmentCreationXml({ clientInfo, transactionRef, labelReportId, shipments }) {
  const shipmentsXml = shipments.map(sh=>{
    const sa = sh.Shipper.PartyAddress || {};
    const sc = sh.Shipper.Contact || {};
    const ca = sh.Consignee.PartyAddress || {};
    const cc = sh.Consignee.Contact || {};
    const d = sh.Details || {};

    return `
      <v1:Shipment>
        <v1:Shipper>
          <v1:Reference1>${escapeXml(sh.Shipper.Reference1 || '')}</v1:Reference1>
          <v1:PartyAddress>
            <v1:Line1>${escapeXml(sa.Line1 || '')}</v1:Line1>
            <v1:Line2>${escapeXml(sa.Line2 || '')}</v1:Line2>
            <v1:Line3>${escapeXml(sa.Line3 || '')}</v1:Line3>
            <v1:City>${escapeXml(sa.City || '')}</v1:City>
            <v1:StateOrProvinceCode>${escapeXml(sa.StateOrProvinceCode || '')}</v1:StateOrProvinceCode>
            <v1:PostCode>${escapeXml(sa.PostCode || '')}</v1:PostCode>
            <v1:CountryCode>${escapeXml(sa.CountryCode || '')}</v1:CountryCode>
            <v1:ResidenceType>${escapeXml(sa.ResidenceType || '')}</v1:ResidenceType>
          </v1:PartyAddress>
          <v1:Contact>
            <v1:PersonName>${escapeXml(sc.PersonName || '')}</v1:PersonName>
            <v1:CompanyName>${escapeXml(sc.CompanyName || '')}</v1:CompanyName>
            <v1:PhoneNumber1>${escapeXml(sc.PhoneNumber1 || '')}</v1:PhoneNumber1>
            <v1:PhoneNumber2>${escapeXml(sc.PhoneNumber2 || '')}</v1:PhoneNumber2>
            <v1:CellPhone>${escapeXml(sc.CellPhone || '')}</v1:CellPhone>
            <v1:EmailAddress>${escapeXml(sc.EmailAddress || '')}</v1:EmailAddress>
            <v1:Type>${escapeXml(sc.Type || '')}</v1:Type>
          </v1:Contact>
        </v1:Shipper>

        <v1:Consignee>
          <v1:Reference1>${escapeXml(sh.Consignee.Reference1 || '')}</v1:Reference1>
          <v1:PartyAddress>
            <v1:Line1>${escapeXml(ca.Line1 || '')}</v1:Line1>
            <v1:Line2>${escapeXml(ca.Line2 || '')}</v1:Line2>
            <v1:Line3>${escapeXml(ca.Line3 || '')}</v1:Line3>
            <v1:City>${escapeXml(ca.City || '')}</v1:City>
            <v1:StateOrProvinceCode>${escapeXml(ca.StateOrProvinceCode || '')}</v1:StateOrProvinceCode>
            <v1:PostCode>${escapeXml(ca.PostCode || '')}</v1:PostCode>
            <v1:CountryCode>${escapeXml(ca.CountryCode || '')}</v1:CountryCode>
          </v1:PartyAddress>
          <v1:Contact>
            <v1:PersonName>${escapeXml(cc.PersonName || '')}</v1:PersonName>
            <v1:CompanyName>${escapeXml(cc.CompanyName || '')}</v1:CompanyName>
            <v1:PhoneNumber1>${escapeXml(cc.PhoneNumber1 || '')}</v1:PhoneNumber1>
            <v1:PhoneNumber2>${escapeXml(cc.PhoneNumber2 || '')}</v1:PhoneNumber2>
            <v1:CellPhone>${escapeXml(cc.CellPhone || '')}</v1:CellPhone>
            <v1:EmailAddress>${escapeXml(cc.EmailAddress || '')}</v1:EmailAddress>
            <v1:Type>${escapeXml(cc.Type || '')}</v1:Type>
          </v1:Contact>
        </v1:Consignee>

        <v1:Details>
          <v1:ShippingDateTime>${escapeXml(d.ShippingDateTime || new Date().toISOString())}</v1:ShippingDateTime>
          <v1:ActualWeight>
            <v1:Value>${escapeXml(d.ActualWeight && d.ActualWeight.Value != null ? d.ActualWeight.Value : '')}</v1:Value>
            <v1:Unit>${escapeXml(d.ActualWeight && d.ActualWeight.Unit ? d.ActualWeight.Unit : 'KG')}</v1:Unit>
          </v1:ActualWeight>
          <v1:ChargeableWeight>
            <v1:Value>${escapeXml(d.ChargeableWeight && d.ChargeableWeight.Value != null ? d.ChargeableWeight.Value : '')}</v1:Value>
            <v1:Unit>${escapeXml(d.ChargeableWeight && d.ChargeableWeight.Unit ? d.ChargeableWeight.Unit : 'KG')}</v1:Unit>
          </v1:ChargeableWeight>
          <v1:NumberOfPieces>${escapeXml(d.NumberOfPieces || 1)}</v1:NumberOfPieces>
          <v1:DescriptionOfGoods>${escapeXml(d.DescriptionOfGoods || '')}</v1:DescriptionOfGoods>
          <v1:GoodsOriginCountry>${escapeXml(d.GoodsOriginCountry || '')}</v1:GoodsOriginCountry>
          <v1:ProductGroup>${escapeXml(d.ProductGroup || '')}</v1:ProductGroup>
          <v1:ProductType>${escapeXml(d.ProductType || '')}</v1:ProductType>
          <v1:PaymentType>${escapeXml(d.PaymentType || '')}</v1:PaymentType>
        </v1:Details>
      </v1:Shipment>`;
  }).join('\n');

  // Envelope uses soapenv and v1 namespaces (matches Aramex docs/examples)
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v1="http://ws.aramex.net/ShippingAPI/v1/">
  <soapenv:Header/>
  <soapenv:Body>
    <v1:ShipmentCreationRequest>
      <v1:ClientInfo>
        <v1:UserName>${escapeXml(clientInfo.UserName || '')}</v1:UserName>
        <v1:Password>${escapeXml(clientInfo.Password || '')}</v1:Password>
        <v1:Version>${escapeXml(clientInfo.Version || '')}</v1:Version>
        <v1:AccountNumber>${escapeXml(clientInfo.AccountNumber || '')}</v1:AccountNumber>
        <v1:AccountPin>${escapeXml(clientInfo.AccountPin || '')}</v1:AccountPin>
        <v1:AccountEntity>${escapeXml(clientInfo.AccountEntity || '')}</v1:AccountEntity>
        <v1:AccountCountryCode>${escapeXml(clientInfo.AccountCountryCode || '')}</v1:AccountCountryCode>
        <v1:Source>${escapeXml(clientInfo.Source != null ? clientInfo.Source : '')}</v1:Source>
      </v1:ClientInfo>

      <v1:Transaction>
        <v1:Reference1>${escapeXml(transactionRef || '')}</v1:Reference1>
        <v1:Reference2></v1:Reference2>
        <v1:Reference3></v1:Reference3>
        <v1:Reference4></v1:Reference4>
        <v1:Reference5></v1:Reference5>
      </v1:Transaction>

      <v1:LabelInfo>
        <v1:ReportID>${escapeXml(labelReportId)}</v1:ReportID>
        <v1:ReportType>URL</v1:ReportType>
      </v1:LabelInfo>

      <v1:Shipments>
        ${shipmentsXml}
      </v1:Shipments>
    </v1:ShipmentCreationRequest>
  </soapenv:Body>
</soapenv:Envelope>`;

  return xml;
}

// ----------------- Checkout creation (kept as-is) -----------------
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

// ----------------- Webhook: receive completed session and create Aramex shipment -----------------
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

    const totalWeight = parseFloat((quantity * WEIGHT_PER_PIECE).toFixed(2));

    const shipperAddress = {
      Line1: process.env.SHIPPER_LINE1 || '',
      Line2: process.env.SHIPPER_LINE2 || '',
      Line3: process.env.SHIPPER_LINE3 || '',
      City: process.env.SHIPPER_CITY || '',
      StateOrProvinceCode: process.env.SHIPPER_STATE || '',
      PostCode: process.env.SHIPPER_POSTCODE || '',
      CountryCode: process.env.SHIPPER_COUNTRY_CODE || '',
      ResidenceType: process.env.SHIPPER_RESIDENCE_TYPE || 'Business'
    };

    const shipperContact = {
      PersonName: process.env.SHIPPER_NAME || '',
      CompanyName: process.env.SHIPPER_NAME || '',
      PhoneNumber1: process.env.SHIPPER_PHONE || '',
      PhoneNumber2: '',
      CellPhone: process.env.SHIPPER_PHONE || '',
      EmailAddress: process.env.SHIPPER_EMAIL || process.env.MAIL_FROM || '',
      Type: ''
    };

    const consigneeAddress = {
      Line1: (session.shipping && session.shipping.address && session.shipping.address.line1) ? session.shipping.address.line1 : (address.line1 || (session.customer_details && session.customer_details.name ? session.customer_details.name : "")),
      Line2: (session.shipping && session.shipping.address && session.shipping.address.line2) ? session.shipping.address.line2 : (address.line2 || ""),
      Line3: '',
      City: (session.shipping && session.shipping.address && session.shipping.address.city) ? session.shipping.address.city : (address.city || ""),
      StateOrProvinceCode: (session.shipping && session.shipping.address && session.shipping.address.state) ? session.shipping.address.state : (address.state || ""),
      PostCode: (session.shipping && session.shipping.address && session.shipping.address.postal_code) ? session.shipping.address.postal_code : (address.postal_code || ""),
      CountryCode: (session.shipping && session.shipping.address && session.shipping.address.country) ? session.shipping.address.country : (address.country || "")
    };
    const consigneeContact = {
      PersonName: (session.shipping && session.shipping.name) ? session.shipping.name : (customerName || ""),
      CompanyName: (session.shipping && session.shipping.name) ? session.shipping.name : (customerName || ""),
      PhoneNumber1: (session.shipping && session.shipping.address && session.shipping.address.phone) ? session.shipping.address.phone : (phone || ""),
      PhoneNumber2: '',
      CellPhone: (session.shipping && session.shipping.address && session.shipping.address.phone) ? session.shipping.address.phone : (phone || ""),
      EmailAddress: customerEmail || '',
      Type: ''
    };

    const shipmentObj = {
      Shipper: { Reference1: process.env.SHIPPER_REFERENCE || '', PartyAddress: shipperAddress, Contact: shipperContact },
      Consignee: { Reference1: '', PartyAddress: consigneeAddress, Contact: consigneeContact },
      Details: {
        ShippingDateTime: new Date().toISOString(),
        ActualWeight: { Value: totalWeight, Unit: "KG" },
        ChargeableWeight: { Value: totalWeight, Unit: "KG" },
        NumberOfPieces: quantity,
        DescriptionOfGoods: "UV Car Inspection Device",
        GoodsOriginCountry: process.env.SHIPPER_COUNTRY_CODE || '',
        ProductGroup: "EXP",
        ProductType: "PDX",
        PaymentType: "P" // prepaid
      }
    };

    // Prepare Aramex client info
    const clientInfo = {
      UserName: process.env.ARAMEX_USER || '',
      Password: process.env.ARAMEX_PASSWORD || '',
      Version: process.env.ARAMEX_VERSION || 'v2',
      AccountNumber: process.env.ARAMEX_ACCOUNT_NUMBER || '',
      AccountPin: process.env.ARAMEX_ACCOUNT_PIN || '',
      AccountEntity: process.env.ARAMEX_ACCOUNT_ENTITY || '',
      AccountCountryCode: process.env.ARAMEX_ACCOUNT_COUNTRY || '',
      Source: DEFAULT_SOURCE
    };

    const shipmentsArray = [ shipmentObj ];
    const chunks = chunkArray(shipmentsArray, MAX_PER_REQUEST);
    console.log(`→ Will send ${shipmentsArray.length} shipment(s) in ${chunks.length} request(s)`);

    const allTrackings = [];
    const allNotifications = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const xml = buildShipmentCreationXml({
        clientInfo,
        transactionRef: session.id || '',
        labelReportId: DEFAULT_REPORT_ID,
        shipments: chunk
      });

      console.log(`→ Sending Aramex XML chunk ${i+1}/${chunks.length} (sanitized):`, JSON.stringify(maskForLog({ AccountNumber: clientInfo.AccountNumber, UserName: clientInfo.UserName })));

      try {
        // IMPORTANT: set SOAPAction header (value from WSDL for CreateShipments)
        const headers = {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': 'http://tempuri.org/IShipmentAPIService/CreateShipments'
        };
        const resp = await axios.post(ARAMEX_ENDPOINT, xml, { headers, timeout: 30000 });

        if (resp && resp.data) console.log(`⤷ Aramex raw response (snippet):`, (typeof resp.data === 'string' ? resp.data.substring(0,2000) : JSON.stringify(resp.data).substring(0,2000)));

        let parsed = null;
        try { parsed = await parseStringPromise(resp.data, { explicitArray: false, ignoreAttrs: true, trim: true }); } catch (e) { console.warn('Could not parse Aramex response XML:', e && e.message ? e.message : e); }

        // look for Notifications or ProcessedShipment
        let notes = [];
        try {
          const body = parsed && (parsed['soapenv:Envelope'] && parsed['soapenv:Envelope']['soapenv:Body'] ? parsed['soapenv:Envelope']['soapenv:Body'] : parsed);
          const respRoot = body && (body.ShipmentCreationResponse || body);
          if (respRoot && respRoot.Notifications && respRoot.Notifications.Notification) {
            notes = Array.isArray(respRoot.Notifications.Notification) ? respRoot.Notifications.Notification : [respRoot.Notifications.Notification];
          } else if (respRoot && respRoot.Notification) {
            notes = Array.isArray(respRoot.Notification) ? respRoot.Notification : [respRoot.Notification];
          }
        } catch(e){ /* ignore */ }

        if (notes && notes.length) {
          console.error('Aramex returned Notifications:', notes);
          allNotifications.push(...notes);
          notes.forEach(n => { if (n.Code && String(n.Code).includes('REQ39')) {
            console.error('→ REQ39 detected. Sent XML (first 2000 chars):', xml.substring(0,2000));
          }});
          continue;
        }

        // Try extract processed shipments
        try {
          const body = parsed && (parsed['soapenv:Envelope'] && parsed['soapenv:Envelope']['soapenv:Body'] ? parsed['soapenv:Envelope']['soapenv:Body'] : parsed);
          const respRoot = body && (body.ShipmentCreationResponse || body);
          const processed = respRoot && (respRoot.ProcessedShipment || respRoot.ProcessedShipments) ? (respRoot.ProcessedShipment || respRoot.ProcessedShipments) : null;
          if (processed) {
            if (Array.isArray(processed)) {
              processed.forEach(p => {
                const id = p && p.ID ? p.ID : (p && p.ShipmentID ? p.ShipmentID : 'N/A');
                const url = p && p.ShipmentLabel && p.ShipmentLabel.LabelURL ? p.ShipmentLabel.LabelURL : 'N/A';
                allTrackings.push({ id, url });
              });
            } else {
              const p = processed;
              const id = p && p.ID ? p.ID : (p && p.ShipmentID ? p.ShipmentID : 'N/A');
              const url = p && p.ShipmentLabel && p.ShipmentLabel.LabelURL ? p.ShipmentLabel.LabelURL : 'N/A';
              allTrackings.push({ id, url });
            }
          } else {
            console.warn('No ProcessedShipment found for chunk', i+1);
            allNotifications.push({ Code: 'NO_PROCESSED', Message: 'No ProcessedShipment' });
          }
        } catch (e) {
          console.error('Error extracting processed shipments:', e && e.message ? e.message : e);
          allNotifications.push({ Code: 'PARSE_ERROR', Message: e && e.message ? e.message : String(e) });
        }

      } catch (err) {
        // Improved error logs: show status and response body (SOAP Fault often comes back with HTTP 500)
        console.error(`Aramex HTTP call error for chunk ${i+1}:`, (err && err.message) ? err.message : err);
        if (err.response) {
          try {
            console.error('Aramex response status:', err.response.status);
            const respData = typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data);
            console.error('Aramex response data (snippet):', respData.substring(0,4000));
          } catch (e) { console.error('Could not log err.response.data:', e && e.message ? e.message : e); }
        }
        console.error('Sent XML (first 2000 chars):', xml.substring(0,2000));
        allNotifications.push({ Code: 'HTTP_ERROR', Message: (err && err.message) ? err.message : 'Unknown' });
      }
    } // end chunks

    // Send email (kept same logic)
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
          console.log('📧 Email sent to', customerEmail);
        } else {
          console.warn('SendGrid not configured - skipping email.');
        }
      } catch (err) {
        console.error('SendGrid send error:', err && err.message ? err.message : err);
      }
    } else {
      console.error('No tracking numbers generated. Notifications:', allNotifications);
    }
  }

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
