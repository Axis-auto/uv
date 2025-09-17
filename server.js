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

// Stripe init
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');

// SendGrid (optional)
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Aramex endpoint (use base URL without ?wsdl)
const ARAMEX_WSDL_URL = process.env.ARAMEX_WSDL_URL || 'https://ws.aramex.net/ShippingAPI.V2/Shipping/Service_1_0.svc?wsdl';
const ARAMEX_ENDPOINT = ARAMEX_WSDL_URL.indexOf('?') !== -1 ? ARAMEX_WSDL_URL.split('?')[0] : ARAMEX_WSDL_URL;

// constants
const WEIGHT_PER_PIECE = 1.63; // kg per piece
const DECLARED_VALUE_PER_PIECE = 200; // AED per piece (kept for declared value if needed)
const CUSTOMS_VALUE_PER_PIECE = 250; // AED per piece for customs (as requested)
const DEFAULT_SOURCE = parseInt(process.env.ARAMEX_SOURCE || '24', 10);
const DEFAULT_REPORT_ID = parseInt(process.env.ARAMEX_REPORT_ID || '9729', 10);

// Full allowed countries for Stripe shipping collection
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
function allowedCountriesForStripe(list) { return list.map(c => (typeof c === 'string' ? c.toUpperCase() : c)); }

// helpers
function escapeXml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function maskForLog(obj){
  try { return JSON.parse(JSON.stringify(obj, (k,v)=>{ if(!k) return v; const lk=k.toLowerCase(); if(lk.includes('password')||lk.includes('pin')||lk.includes('secret')||lk.includes('apikey')) return '***'; return v;})); }
  catch(e){ return obj; }
}

// Build Aramex ShipmentCreation XML - WITH DIMENSIONS ELEMENT
function buildShipmentCreationXml({ clientInfo, transactionRef, labelReportId, shipment }) {
  const sa = shipment.Shipper.PartyAddress || {};
  const sc = shipment.Shipper.Contact || {};
  const ca = shipment.Consignee.PartyAddress || {};
  const cc = shipment.Consignee.Contact || {};
  const d = shipment.Details || {};

  // Standard box dimensions for UV device
  const length = 30; // cm
  const width = 20; // cm
  const height = 15; // cm

  // Prepare customs value fallback (ensure numeric non-empty)
  const customsValue = (d.CustomsValueAmount && (d.CustomsValueAmount.Value != null && d.CustomsValueAmount.Value !== '')) ? d.CustomsValueAmount.Value : '';

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://ws.aramex.net/ShippingAPI/v1/">
  <soap:Header/>
  <soap:Body>
    <tns:ShipmentCreationRequest>
      <tns:ClientInfo>
        <tns:UserName>${escapeXml(clientInfo.UserName || '')}</tns:UserName>
        <tns:Password>${escapeXml(clientInfo.Password || '')}</tns:Password>
        <tns:Version>${escapeXml(clientInfo.Version || '')}</tns:Version>
        <tns:AccountNumber>${escapeXml(clientInfo.AccountNumber || '')}</tns:AccountNumber>
        <tns:AccountPin>${escapeXml(clientInfo.AccountPin || '')}</tns:AccountPin>
        <tns:AccountEntity>${escapeXml(clientInfo.AccountEntity || '')}</tns:AccountEntity>
        <tns:AccountCountryCode>${escapeXml(clientInfo.AccountCountryCode || '')}</tns:AccountCountryCode>
        <tns:Source>${escapeXml(clientInfo.Source != null ? clientInfo.Source : '')}</tns:Source>
      </tns:ClientInfo>
      <tns:Transaction>
        <tns:Reference1>${escapeXml(transactionRef || '')}</tns:Reference1>
        <tns:Reference2></tns:Reference2>
        <tns:Reference3></tns:Reference3>
        <tns:Reference4></tns:Reference4>
        <tns:Reference5></tns:Reference5>
      </tns:Transaction>
      <tns:Shipments>
        <tns:Shipment>
          <tns:Reference1>${escapeXml(shipment.Reference1 || '')}</tns:Reference1>
          <tns:Reference2></tns:Reference2>
          <tns:Reference3></tns:Reference3>

          <!-- Shipper: include account info here as well (Aramex expects it inside Shipper) -->
          <tns:Shipper>
            <tns:Reference1>${escapeXml(shipment.Shipper.Reference1 || '')}</tns:Reference1>
            <tns:AccountNumber>${escapeXml(clientInfo.AccountNumber || '')}</tns:AccountNumber>
            <tns:AccountPin>${escapeXml(clientInfo.AccountPin || '')}</tns:AccountPin>
            <tns:AccountEntity>${escapeXml(clientInfo.AccountEntity || '')}</tns:AccountEntity>
            <tns:AccountCountryCode>${escapeXml(clientInfo.AccountCountryCode || '')}</tns:AccountCountryCode>
            <tns:PartyAddress>
              <tns:Line1>${escapeXml(sa.Line1 || '')}</tns:Line1>
              <tns:Line2>${escapeXml(sa.Line2 || '')}</tns:Line2>
              <tns:Line3>${escapeXml(sa.Line3 || '')}</tns:Line3>
              <tns:City>${escapeXml(sa.City || '')}</tns:City>
              <tns:StateOrProvinceCode>${escapeXml(sa.StateOrProvinceCode || '')}</tns:StateOrProvinceCode>
              <tns:PostCode>${escapeXml(sa.PostCode || '')}</tns:PostCode>
              <tns:CountryCode>${escapeXml(sa.CountryCode || '')}</tns:CountryCode>
            </tns:PartyAddress>
            <tns:Contact>
              <tns:PersonName>${escapeXml(sc.PersonName || '')}</tns:PersonName>
              <tns:CompanyName>${escapeXml(sc.CompanyName || '')}</tns:CompanyName>
              <tns:PhoneNumber1>${escapeXml(sc.PhoneNumber1 || '')}</tns:PhoneNumber1>
              <tns:PhoneNumber2>${escapeXml(sc.PhoneNumber2 || '')}</tns:PhoneNumber2>
              <tns:CellPhone>${escapeXml(sc.CellPhone || '')}</tns:CellPhone>
              <tns:EmailAddress>${escapeXml(sc.EmailAddress || '')}</tns:EmailAddress>
              <tns:Type>${escapeXml(sc.Type || '')}</tns:Type>
            </tns:Contact>
          </tns:Shipper>

          <tns:Consignee>
            <tns:Reference1>${escapeXml(shipment.Consignee.Reference1 || '')}</tns:Reference1>
            <tns:PartyAddress>
              <tns:Line1>${escapeXml(ca.Line1 || '')}</tns:Line1>
              <tns:Line2>${escapeXml(ca.Line2 || '')}</tns:Line2>
              <tns:Line3>${escapeXml(ca.Line3 || '')}</tns:Line3>
              <tns:City>${escapeXml(ca.City || '')}</tns:City>
              <tns:StateOrProvinceCode>${escapeXml(ca.StateOrProvinceCode || '')}</tns:StateOrProvinceCode>
              <tns:PostCode>${escapeXml(ca.PostCode || '')}</tns:PostCode>
              <tns:CountryCode>${escapeXml(ca.CountryCode || '')}</tns:CountryCode>
            </tns:PartyAddress>
            <tns:Contact>
              <tns:PersonName>${escapeXml(cc.PersonName || '')}</tns:PersonName>
              <tns:CompanyName>${escapeXml(cc.CompanyName || '')}</tns:CompanyName>
              <tns:PhoneNumber1>${escapeXml(cc.PhoneNumber1 || '')}</tns:PhoneNumber1>
              <tns:PhoneNumber2>${escapeXml(cc.PhoneNumber2 || '')}</tns:PhoneNumber2>
              <tns:CellPhone>${escapeXml(cc.CellPhone || '')}</tns:CellPhone>
              <tns:EmailAddress>${escapeXml(cc.EmailAddress || '')}</tns:EmailAddress>
              <tns:Type>${escapeXml(cc.Type || '')}</tns:Type>
            </tns:Contact>
          </tns:Consignee>

          <tns:ThirdParty>
            <tns:Reference1></tns:Reference1>
            <tns:PartyAddress>
              <tns:Line1></tns:Line1>
              <tns:Line2></tns:Line2>
              <tns:Line3></tns:Line3>
              <tns:City></tns:City>
              <tns:StateOrProvinceCode></tns:StateOrProvinceCode>
              <tns:PostCode></tns:PostCode>
              <tns:CountryCode></tns:CountryCode>
            </tns:PartyAddress>
            <tns:Contact>
              <tns:PersonName></tns:PersonName>
              <tns:CompanyName></tns:CompanyName>
              <tns:PhoneNumber1></tns:PhoneNumber1>
              <tns:PhoneNumber2></tns:PhoneNumber2>
              <tns:CellPhone></tns:CellPhone>
              <tns:EmailAddress></tns:EmailAddress>
              <tns:Type></tns:Type>
            </tns:Contact>
          </tns:ThirdParty>

          <tns:ShippingDateTime>${escapeXml(d.ShippingDateTime || new Date().toISOString())}</tns:ShippingDateTime>
          <tns:Comments>${escapeXml(d.DescriptionOfGoods || '')}</tns:Comments>
          <tns:PickupLocation></tns:PickupLocation>
          <tns:OperationsInstructions></tns:OperationsInstructions>
          <tns:AccountingInstrcutions></tns:AccountingInstrcutions>

          <tns:Details>
            <tns:Dimensions>
              <tns:Length>${length}</tns:Length>
              <tns:Width>${width}</tns:Width>
              <tns:Height>${height}</tns:Height>
              <tns:Unit>CM</tns:Unit>
            </tns:Dimensions>

            <tns:ActualWeight>
              <tns:Unit>${escapeXml(d.ActualWeight && d.ActualWeight.Unit ? d.ActualWeight.Unit : 'KG')}</tns:Unit>
              <tns:Value>${escapeXml(d.ActualWeight && d.ActualWeight.Value != null ? d.ActualWeight.Value : '')}</tns:Value>
            </tns:ActualWeight>

            <tns:ChargeableWeight>
              <tns:Unit>${escapeXml(d.ChargeableWeight && d.ChargeableWeight.Unit ? d.ChargeableWeight.Unit : 'KG')}</tns:Unit>
              <tns:Value>${escapeXml(d.ChargeableWeight && d.ChargeableWeight.Value != null ? d.ChargeableWeight.Value : '')}</tns:Value>
            </tns:ChargeableWeight>

            <tns:DescriptionOfGoods>${escapeXml(d.DescriptionOfGoods || '')}</tns:DescriptionOfGoods>
            <tns:GoodsOriginCountry>${escapeXml(d.GoodsOriginCountry || '')}</tns:GoodsOriginCountry>
            <tns:NumberOfPieces>${escapeXml(d.NumberOfPieces || 1)}</tns:NumberOfPieces>

            <tns:ProductGroup>${escapeXml(d.ProductGroup || '')}</tns:ProductGroup>
            <tns:ProductType>${escapeXml(d.ProductType || '')}</tns:ProductType>
            <tns:PaymentType>${escapeXml(d.PaymentType || '')}</tns:PaymentType>

            <tns:PaymentOptions></tns:PaymentOptions>

            <!-- Ensure CustomsValueAmount present (CurrencyCode before Value) -->
            <tns:CustomsValueAmount>
              <tns:CurrencyCode>${escapeXml((d.CustomsValueAmount && d.CustomsValueAmount.CurrencyCode) || 'AED')}</tns:CurrencyCode>
              <tns:Value>${escapeXml(customsValue !== '' ? customsValue : '')}</tns:Value>
            </tns:CustomsValueAmount>

            <tns:CashOnDeliveryAmount>
              <tns:CurrencyCode>AED</tns:CurrencyCode>
              <tns:Value>0</tns:Value>
            </tns:CashOnDeliveryAmount>

            <tns:InsuranceAmount>
              <tns:CurrencyCode>AED</tns:CurrencyCode>
              <tns:Value>0</tns:Value>
            </tns:InsuranceAmount>

            <tns:CollectAmount>
              <tns:CurrencyCode>AED</tns:CurrencyCode>
              <tns:Value>0</tns:Value>
            </tns:CollectAmount>

            <tns:Services></tns:Services>

            <tns:Items>
              <tns:ShipmentItem>
                <tns:PackageType>Box</tns:PackageType>
                <tns:Quantity>${escapeXml(d.NumberOfPieces || 1)}</tns:Quantity>
                <tns:Weight>
                  <tns:Unit>KG</tns:Unit>
                  <tns:Value>${escapeXml(d.ActualWeight && d.ActualWeight.Value != null ? d.ActualWeight.Value : '')}</tns:Value>
                </tns:Weight>
                <tns:Comments>${escapeXml(d.DescriptionOfGoods || '')}</tns:Comments>

                <!-- Item-level customs value to satisfy dutiable cases -->
                <tns:ItemValue>
                  <tns:CurrencyCode>${escapeXml((d.CustomsValueAmount && d.CustomsValueAmount.CurrencyCode) || 'AED')}</tns:CurrencyCode>
                  <tns:Value>${escapeXml(customsValue !== '' ? customsValue : '')}</tns:Value>
                </tns:ItemValue>

                <tns:Reference></tns:Reference>
              </tns:ShipmentItem>
            </tns:Items>

          </tns:Details>
        </tns:Shipment>
      </tns:Shipments>
      <tns:LabelInfo>
        <tns:ReportID>${escapeXml(labelReportId)}</tns:ReportID>
        <tns:ReportType>URL</tns:ReportType>
      </tns:LabelInfo>
    </tns:ShipmentCreationRequest>
  </soap:Body>
</soap:Envelope>`;

  return xml;
}

// ----------------- Checkout creation -----------------
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

    const sessionParams = {
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
      cancel_url: 'https://axis-uv.com/cancel',
      metadata: { quantity: String(quantity) }
    };

    if (req.body.customer_email) sessionParams.customer_email = req.body.customer_email;

    const session = await stripe.checkout.sessions.create(sessionParams);

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

    // retrieve full session (expand customer and line_items) to get full shipping info
    let fullSession = null;
    try {
      fullSession = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items', 'customer'] });
    } catch (err) {
      console.warn('Could not retrieve full Stripe session (non-fatal):', err && err.message ? err.message : err);
      fullSession = session; // fallback to the minimal session from the event
    }

    const customerEmail = (fullSession.customer_details && fullSession.customer_details.email) ? fullSession.customer_details.email : (fullSession.customer && fullSession.customer.email ? fullSession.customer.email : '');
    const customerName = (fullSession.shipping && fullSession.shipping.name) ? fullSession.shipping.name : (fullSession.customer_details && fullSession.customer_details.name ? fullSession.customer_details.name : (fullSession.customer && fullSession.customer.name ? fullSession.customer.name : ''));
    const phone = (fullSession.customer && fullSession.customer.phone) ||
                  (fullSession.customer_details && fullSession.customer_details.phone) ||
                  (fullSession.shipping && fullSession.shipping.phone) ||
                  session.customer || '';

    const quantity = (fullSession && fullSession.line_items && fullSession.line_items.data && fullSession.line_items.data[0] && fullSession.line_items.data[0].quantity) ? fullSession.line_items.data[0].quantity : (session.quantity || parseInt((fullSession.metadata && fullSession.metadata.quantity) || '1', 10));

    const totalWeight = parseFloat((quantity * WEIGHT_PER_PIECE).toFixed(2));
    // declared value kept for records (not used for customs calculation per your request)
    const totalDeclaredValue = quantity * DECLARED_VALUE_PER_PIECE; // 200 AED per piece
    // customs value per your rule: 250 AED per piece, multiplied by quantity
    const totalCustomsValue = quantity * CUSTOMS_VALUE_PER_PIECE;

    const shipping = (fullSession && fullSession.shipping) ? fullSession.shipping : (fullSession && fullSession.customer_details && fullSession.customer_details.address ? { address: fullSession.customer_details.address, name: fullSession.customer_details.name } : null);

    const consigneeAddress = {
      Line1: (shipping && shipping.address && (shipping.address.line1 || shipping.address.address_line1)) ? (shipping.address.line1 || shipping.address.address_line1) : '',
      Line2: (shipping && shipping.address && (shipping.address.line2 || shipping.address.address_line2)) ? (shipping.address.line2 || shipping.address.address_line2) : '',
      Line3: '',
      City: (shipping && shipping.address && (shipping.address.city || shipping.address.locality)) ? (shipping.address.city || shipping.address.locality) : '',
      StateOrProvinceCode: (shipping && shipping.address && (shipping.address.state || shipping.address.region)) ? (shipping.address.state || shipping.address.region) : '',
      PostCode: (shipping && shipping.address && (shipping.address.postal_code || shipping.address.postcode)) ? (shipping.address.postal_code || shipping.address.postcode) : '',
      CountryCode: (shipping && shipping.address && shipping.address.country) ? shipping.address.country : ''
    };

    const consigneeContact = {
      PersonName: (shipping && shipping.name) ? shipping.name : customerName || '',
      CompanyName: (shipping && shipping.name) ? shipping.name : customerName || '',
      PhoneNumber1: phone || '',
      PhoneNumber2: '',
      CellPhone: phone || '',
      EmailAddress: customerEmail || '',
      Type: ''
    };

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

    // Build shipment object and set CustomsValueAmount based on quantity * CUSTOMS_VALUE_PER_PIECE
    // Also set ProductType and DescriptionOfGoods to the string you requested
    const productTypeString = 'Parts Machines and Electronics UV inspectiondevice AXIS Model UVRA100 B';
    const descriptionString = 'Parts Machines and Electronics UV inspectiondevice AXIS Model UVRA100 B';

    const shipmentObj = {
      Reference1: session.id || '',
      Shipper: { Reference1: process.env.SHIPPER_REFERENCE || '', PartyAddress: shipperAddress, Contact: shipperContact },
      Consignee: { Reference1: '', PartyAddress: consigneeAddress, Contact: consigneeContact },
      Details: {
        ShippingDateTime: new Date().toISOString(),
        ActualWeight: { Value: totalWeight, Unit: "KG" },
        ChargeableWeight: { Value: totalWeight, Unit: "KG" },
        NumberOfPieces: quantity,
        DescriptionOfGoods: descriptionString,
        GoodsOriginCountry: process.env.SHIPPER_COUNTRY_CODE || '',
        // customs value set per your rule (CurrencyCode before Value)
        CustomsValueAmount: { Value: totalCustomsValue, CurrencyCode: "AED" },
        ProductGroup: "EXP",
        ProductType: productTypeString,
        PaymentType: "P"
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

    let trackingId = null;
    let labelUrl = null;
    let aramexError = null;

    try {
      // Guard: ensure essential Aramex account fields present
      if (!clientInfo.AccountNumber || !clientInfo.AccountEntity || !clientInfo.AccountPin) {
        const missing = [
          !clientInfo.AccountNumber && 'ARAMEX_ACCOUNT_NUMBER',
          !clientInfo.AccountEntity && 'ARAMEX_ACCOUNT_ENTITY',
          !clientInfo.AccountPin && 'ARAMEX_ACCOUNT_PIN'
        ].filter(Boolean);
        const msg = `Missing Aramex account config: ${missing.join(', ')}`;
        console.error('❌', msg);
        aramexError = msg;
        throw new Error(msg);
      }

      console.log('→ Creating Aramex shipment for order:', session.id);
      console.log('→ Shipment details:', JSON.stringify(maskForLog({
        quantity,
        weight: totalWeight,
        declaredValue: totalDeclaredValue,
        customsValue: totalCustomsValue,
        destination: consigneeAddress.CountryCode,
        account: clientInfo.AccountNumber,
        productType: productTypeString,
        dimensions: '30x20x15 CM'
      })));

      const xml = buildShipmentCreationXml({
        clientInfo,
        transactionRef: session.id || '',
        labelReportId: DEFAULT_REPORT_ID,
        shipment: shipmentObj
      });

      // sanitized XML preview for logs (hide password/pin)
      const safeXml = xml.replace(/(<tns:Password>).*?(<\/tns:Password>)/g, '$1***$2').replace(/(<tns:AccountPin>).*?(<\/tns:AccountPin>)/g, '$1***$2');
      console.log('→ XML length:', xml.length, 'characters');
      console.log('→ XML preview (sanitized):', safeXml.substring(0, 1600));

      const headers = {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'http://ws.aramex.net/ShippingAPI/v1/Service_1_0/CreateShipments'
      };

      const resp = await axios.post(ARAMEX_ENDPOINT, xml, { headers, timeout: 30000 });

      if (resp && resp.data) {
        console.log('⤷ Aramex raw response (snippet):', (typeof resp.data === 'string' ? resp.data.substring(0,2000) : JSON.stringify(resp.data).substring(0,2000)));
      }

      let parsed = null;
      try {
        parsed = await parseStringPromise(resp.data, { explicitArray: false, ignoreAttrs: true, trim: true });
      } catch (e) {
        console.warn('Could not parse Aramex response XML:', e && e.message ? e.message : e);
      }

      // Collect errors/notifications from multiple possible locations
      let hasErrors = false;
      let notifications = [];

      try {
        const body = parsed && (parsed['s:Envelope'] && parsed['s:Envelope']['s:Body'] ? parsed['s:Envelope']['s:Body'] : parsed);
        const respRoot = body && (body.ShipmentCreationResponse || body);

        if (respRoot && (respRoot.HasErrors === 'true' || respRoot.HasErrors === true)) hasErrors = true;

        const collectNotificationsFromNode = (node) => {
          if (!node) return [];
          if (Array.isArray(node.Notification)) return node.Notification;
          if (node.Notification) return [node.Notification];
          return [];
        };

        if (respRoot && respRoot.Notifications) {
          notifications = notifications.concat(collectNotificationsFromNode(respRoot.Notifications));
        }

        const shipmentsNode = respRoot && respRoot.Shipments && respRoot.Shipments.ProcessedShipment;
        if (shipmentsNode) {
          const processed = Array.isArray(shipmentsNode) ? shipmentsNode : [shipmentsNode];
          for (const p of processed) {
            if (p.HasErrors === 'true' || p.HasErrors === true) hasErrors = true;
            if (p.Notifications) notifications = notifications.concat(collectNotificationsFromNode(p.Notifications));
          }
        }

      } catch (e) {
        console.warn('Could not parse error info:', e && e.message ? e.message : e);
      }

      if (hasErrors || notifications.length > 0) {
        console.error('❌ Aramex returned errors:', notifications);
        aramexError = notifications.map(n => {
          const code = n.Code || n.code || '';
          const msg  = n.Message || n.message || (typeof n === 'string' ? n : JSON.stringify(n));
          return code ? `${code}: ${msg}` : msg;
        }).join('; ');
      } else {
        try {
          const body = parsed && (parsed['s:Envelope'] && parsed['s:Envelope']['s:Body'] ? parsed['s:Envelope']['s:Body'] : parsed);
          const respRoot = body && (body.ShipmentCreationResponse || body);
          const shipments = respRoot && respRoot.Shipments && respRoot.Shipments.ProcessedShipment ? respRoot.Shipments.ProcessedShipment : null;

          if (shipments) {
            const shipment = Array.isArray(shipments) ? shipments[0] : shipments;
            trackingId = shipment && shipment.ID ? shipment.ID : null;
            labelUrl = shipment && shipment.ShipmentLabel && shipment.ShipmentLabel.LabelURL ? shipment.ShipmentLabel.LabelURL : null;

            if (trackingId) {
              console.log('✅ Aramex shipment created successfully!');
              console.log('→ Tracking ID:', trackingId);
              console.log('→ Label URL:', labelUrl);
            }
          }
        } catch(e) {
          console.warn('Could not extract shipment info:', e && e.message ? e.message : e);
        }
      }

    } catch (err) {
      console.error('❌ Aramex API error:', err && err.message ? err.message : err);
      if (err.response && err.response.data) {
        console.error('❌ Aramex response data:', err.response.data);
      }
      // aramexError may have been set earlier
      aramexError = aramexError || (err && err.message ? err.message : 'Unknown Aramex API error');
    }

    // Send email notification (if configured)
    if (process.env.SENDGRID_API_KEY && customerEmail) {
      try {
        let emailContent = `Thank you for your order!

Order Details:
- Quantity: ${quantity}
- Total Weight: ${totalWeight} KG
- Declared Value: ${totalDeclaredValue} AED
- Customs Value: ${totalCustomsValue} AED
- Dimensions: 30x20x15 CM
`;

        if (trackingId) {
          emailContent += `
Shipping Information:
- Tracking ID: ${trackingId}
`;
          if (labelUrl) {
            emailContent += `- Shipping Label: ${labelUrl}
`;
          }
        } else if (aramexError) {
          emailContent += `
Shipping Status: Processing (${aramexError})
`;
        } else {
          emailContent += `
Shipping Status: Processing
`;
        }

        emailContent += `
Best regards,
Axis UV Team`;

        const msg = {
          to: customerEmail,
          from: process.env.MAIL_FROM,
          subject: 'Order Confirmation - UV Car Inspection Device',
          text: emailContent
        };
        await sgMail.send(msg);
        console.log('✅ Email sent to:', customerEmail);
      } catch (emailErr) {
        console.error('❌ Email sending failed:', emailErr && emailErr.message ? emailErr.message : emailErr);
      }
    }

    console.log('✅ Webhook processed successfully');
    if (trackingId) {
      console.log('→ Shipment created with tracking:', trackingId);
    } else {
      console.log('→ Shipment creation failed:', aramexError || 'Unknown error');
    }
  }

  res.status(200).send('OK');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('🔧 Environment check:', missingEnvs.length ? `Missing: ${missingEnvs.join(', ')}` : 'All required env vars present');
});
