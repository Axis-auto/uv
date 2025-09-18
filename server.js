const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");
const bodyParser = require("body-parser");
const sgMail = require("@sendgrid/mail");
const axios = require("axios");
const { parseStringPromise } = require("xml2js");

const app = express();
app.use(cors({ origin: true }));

// ---------- ENV check ----------
const REQUIRED_ENVS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "MAIL_FROM",
  "ARAMEX_WSDL_URL",
  "ARAMEX_USER",
  "ARAMEX_PASSWORD",
  "ARAMEX_ACCOUNT_NUMBER",
  "ARAMEX_ACCOUNT_PIN",
  "ARAMEX_ACCOUNT_ENTITY",
  "ARAMEX_ACCOUNT_COUNTRY",
  "SHIPPER_LINE1",
  "SHIPPER_CITY",
  "SHIPPER_POSTCODE",
  "SHIPPER_COUNTRY_CODE",
  "SHIPPER_NAME",
  "SHIPPER_PHONE",
];
const missingEnvs = REQUIRED_ENVS.filter((k) => !process.env[k]);
if (missingEnvs.length) console.warn("⚠️ Missing envs:", missingEnvs);

// Stripe init
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");

// SendGrid (optional)
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Aramex endpoint (use base URL without ?wsdl)
const ARAMEX_WSDL_URL = process.env.ARAMEX_WSDL_URL || "https://ws.aramex.net/ShippingAPI.V2/Shipping/Service_1_0.svc?wsdl";
const ARAMEX_ENDPOINT = ARAMEX_WSDL_URL.indexOf("?") !== -1 ? ARAMEX_WSDL_URL.split("?")[0] : ARAMEX_WSDL_URL;

// constants
const WEIGHT_PER_PIECE = 1.63; // kg per piece
const DECLARED_VALUE_PER_PIECE = 200; // AED per piece (kept for declared value if needed)
const CUSTOMS_VALUE_PER_PIECE = 250; // AED per piece for customs (as requested)
const DEFAULT_SOURCE = parseInt(process.env.ARAMEX_SOURCE || "24", 10);
const DEFAULT_REPORT_ID = parseInt(process.env.ARAMEX_REPORT_ID || "9729", 10);

// Full allowed countries for Stripe shipping collection
const allowedCountries = [
  "AC", "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AT", "AU", "AW", "AX", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY", "BZ",
  "CA", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CV", "CW", "CY", "CZ",
  "DE", "DJ", "DK", "DM", "DO", "DZ",
  "EC", "EE", "EG", "EH", "ER", "ES", "ET",
  "FI", "FJ", "FK", "FO", "FR",
  "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY",
  "HK", "HN", "HR", "HT", "HU",
  "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IS", "IT",
  "JE", "JM", "JO", "JP",
  "KE", "KG", "KH", "KI", "KM", "KN", "KR", "KW", "KY", "KZ",
  "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY",
  "MA", "MC", "MD", "ME", "MF", "MG", "MK", "ML", "MM", "MN", "MO", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ",
  "NA", "NC", "NE", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ",
  "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PY",
  "QA", "RE", "RO", "RS", "RU", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SZ",
  "TA", "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ",
  "UA", "UG", "US", "UY", "UZ",
  "VA", "VC", "VE", "VG", "VN", "VU",
  "WF", "WS", "XK",
  "YE", "YT",
  "ZA", "ZM", "ZW", "ZZ",
];
function allowedCountriesForStripe(list) {
  return list.map((c) => (typeof c === "string" ? c.toUpperCase() : c));
}

// helpers
function escapeXml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\'/g, "&apos;");
}

function maskForLog(obj) {
  try {
    return JSON.parse(
      JSON.stringify(obj, (k, v) => {
        if (!k) return v;
        const lk = k.toLowerCase();
        if (lk.includes("password") || lk.includes("pin") || lk.includes("secret") || lk.includes("apikey")) return "***";
        return v;
      })
    );
  } catch (e) {
    return obj;
  }
}

// Address validation and normalization functions
function normalizeCity(city, countryCode) {
  if (!city) return "";

  // Common city name mappings for UAE
  const cityMappings = {
    AE: {
      sharjah: "Sharjah",
      dubai: "Dubai",
      "abu dhabi": "Abu Dhabi",
      ajman: "Ajman",
      fujairah: "Fujairah",
      "ras al khaimah": "Ras Al Khaimah",
      "umm al quwain": "Umm Al Quwain",
    },
  };

  const normalizedCity = city.trim();
  const countryMappings = cityMappings[countryCode?.toUpperCase()];

  if (countryMappings) {
    const lowerCity = normalizedCity.toLowerCase();
    return countryMappings[lowerCity] || normalizedCity;
  }

  return normalizedCity;
}

function validateAndNormalizePostCode(postCode, countryCode) {
  if (!postCode) return "";

  const normalized = postCode.toString().trim();

  // Country-specific postal code validation and normalization
  switch (countryCode?.toUpperCase()) {
    case "US":
      // US ZIP codes: 5 digits or 5+4 format
      const usMatch = normalized.match(/^(\d{5})(-?\d{4})?$/);
      return usMatch ? usMatch[1] + (usMatch[2] ? usMatch[2].replace("-", "") : "") : normalized;

    case "CA":
      // Canadian postal codes: A1A 1A1 format
      const caMatch = normalized.toUpperCase().match(/^([A-Z]\d[A-Z])\s*(\d[A-Z]\d)$/);
      return caMatch ? `${caMatch[1]} ${caMatch[2]}` : normalized;

    case "GB":
      // UK postal codes: various formats
      return normalized.toUpperCase();

    case "AE":
      // UAE doesn't use postal codes, return empty string
      return "";

    case "DE":
      // German postal codes: 5 digits
      const deMatch = normalized.match(/^\d{5}$/);
      return deMatch ? normalized : "";

    case "FR":
      // French postal codes: 5 digits
      const frMatch = normalized.match(/^\d{5}$/);
      return frMatch ? normalized : "";

    case "TR":
      // Turkish postal codes: 5 digits
      const trMatch = normalized.match(/^\d{5}$/);
      return trMatch ? normalized : "";

    default:
      // For other countries, return as-is but ensure it's not too long
      return normalized.length > 10 ? normalized.substring(0, 10) : normalized;
  }
}

function validatePhoneNumber(phone, countryCode) {
  if (!phone) return "";

  // Remove all non-digit characters except +
  let cleaned = phone.replace(/[^\d+]/g, "");

  // If it starts with +, keep it, otherwise add country code if needed
  if (!cleaned.startsWith("+")) {
    // Add common country codes
    switch (countryCode?.toUpperCase()) {
      case "AE":
        if (!cleaned.startsWith("971")) {
          cleaned = "971" + cleaned;
        }
        break;
      case "US":
      case "CA":
        if (!cleaned.startsWith("1")) {
          cleaned = "1" + cleaned;
        }
        break;
      case "GB":
        if (!cleaned.startsWith("44")) {
          cleaned = "44" + cleaned;
        }
        break;
      case "TR":
        if (!cleaned.startsWith("90")) {
          cleaned = "90" + cleaned;
        }
        break;
    }
    cleaned = "+" + cleaned;
  }

  return cleaned;
}

// Extract shipping address from session - FIXED VERSION
function extractShippingAddress(session) {
  console.log("→ Extracting shipping address from session...");

  // Try multiple possible locations for shipping address
  let shippingAddress = null;

  // Method 1: Check shipping_details.address (if available)
  if (session.shipping_details && session.shipping_details.address) {
    console.log("→ Found shipping address in shipping_details.address");
    shippingAddress = session.shipping_details.address;
  }
  // Method 2: Check shipping.address (alternative location)
  else if (session.shipping && session.shipping.address) {
    console.log("→ Found shipping address in shipping.address");
    shippingAddress = session.shipping.address;
  }
  // Method 3: Check customer_details.address (fallback)
  else if (session.customer_details && session.customer_details.address) {
    console.log("→ Found address in customer_details.address (using as shipping address)");
    shippingAddress = session.customer_details.address;
  }

  if (shippingAddress) {
    console.log("→ Extracted shipping address:", JSON.stringify(shippingAddress, null, 2));
    return shippingAddress;
  }

  console.log("→ No shipping address found in any location");
  return null;
}

// Validate required fields for Aramex shipment
function validateRequiredFields(session, shippingAddress) {
  const errors = [];
  
  // Check customer name (prioritize shipping address name, then customer details name)
  const customerName = shippingAddress?.name || session.customer_details?.name;
  if (!customerName || customerName.trim() === "") {
    errors.push("Customer name is required but not provided by Stripe");
  }
  
  // Check customer email
  const customerEmail = session.customer_details?.email;
  if (!customerEmail || customerEmail.trim() === "") {
    errors.push("Customer email is required but not provided by Stripe");
  }
  
  // Check customer phone
  const customerPhone = session.customer_details?.phone;
  if (!customerPhone || customerPhone.trim() === "") {
    errors.push("Customer phone is required but not provided by Stripe");
  }
  
  // Check shipping address
  if (!shippingAddress) {
    errors.push("Shipping address is required but not provided by Stripe");
  } else {
    if (!shippingAddress.line1 || shippingAddress.line1.trim() === "") {
      errors.push("Shipping address line 1 is required but not provided");
    }
    if (!shippingAddress.city || shippingAddress.city.trim() === "") {
      errors.push("Shipping city is required but not provided");
    }
    if (!shippingAddress.country || shippingAddress.country.trim() === "") {
      errors.push("Shipping country is required but not provided");
    }
  }
  
  return errors;
}

// Build Aramex ShipmentCreation XML - WITH STRICT VALIDATION
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

  // Normalize and validate addresses
  const shipperCity = normalizeCity(sa.City, sa.CountryCode) || "Dubai"; // Default to Dubai if empty
  const consigneeCity = normalizeCity(ca.City, ca.CountryCode);
  const shipperPostCode = validateAndNormalizePostCode(sa.PostCode, sa.CountryCode);
  const consigneePostCode = validateAndNormalizePostCode(ca.PostCode, ca.CountryCode);

  // Validate and normalize phone numbers
  const shipperPhone = validatePhoneNumber(sc.PhoneNumber1 || sc.CellPhone, sa.CountryCode);
  const consigneePhone = validatePhoneNumber(cc.PhoneNumber1 || cc.CellPhone, ca.CountryCode);

  // Ensure country code is not empty
  const consigneeCountryCode = ca.CountryCode || "US"; // Default to US if empty
  const shipperCountryCode = sa.CountryCode || "AE"; // Default to AE for shipper

  // Prepare customs value fallback (ensure numeric non-empty)
  const customsValue = d.CustomsValueAmount && (d.CustomsValueAmount.Value != null && d.CustomsValueAmount.Value !== "") ? d.CustomsValueAmount.Value : "";

  // Consignee contact fallbacks to ensure Aramex required fields are present
  const ccPersonName = (cc.PersonName || cc.EmailAddress || shipment.Consignee.Reference1 || "Customer").toString();
  const ccCompanyName = (cc.CompanyName || ccPersonName || "Individual").toString();
  const ccPhone = (cc.PhoneNumber1 || cc.CellPhone || consigneePhone || "").toString();
  const ccEmail = (cc.EmailAddress || "").toString();

  console.log("→ Address validation results:", {
    shipperCity,
    consigneeCity,
    shipperCountryCode,
    consigneeCountryCode,
    consigneePostCode,
    shipperPostCode,
  });

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://ws.aramex.net/ShippingAPI/v1/">
  <soap:Header/>
  <soap:Body>
    <tns:ShipmentCreationRequest>
      <tns:ClientInfo>
        <tns:UserName>${escapeXml(clientInfo.UserName || "")}</tns:UserName>
        <tns:Password>${escapeXml(clientInfo.Password || "")}</tns:Password>
        <tns:Version>${escapeXml(clientInfo.Version || "")}</tns:Version>
        <tns:AccountNumber>${escapeXml(clientInfo.AccountNumber || "")}</tns:AccountNumber>
        <tns:AccountPin>${escapeXml(clientInfo.AccountPin || "")}</tns:AccountPin>
        <tns:AccountEntity>${escapeXml(clientInfo.AccountEntity || "")}</tns:AccountEntity>
        <tns:AccountCountryCode>${escapeXml(clientInfo.AccountCountryCode || "")}</tns:AccountCountryCode>
        <tns:Source>${escapeXml(clientInfo.Source != null ? clientInfo.Source : "")}</tns:Source>
      </tns:ClientInfo>
      <tns:Transaction>
        <tns:Reference1>${escapeXml(transactionRef || "")}</tns:Reference1>
        <tns:Reference2></tns:Reference2>
        <tns:Reference3></tns:Reference3>
        <tns:Reference4></tns:Reference4>
        <tns:Reference5></tns:Reference5>
      </tns:Transaction>
      <tns:Shipments>
        <tns:Shipment>
          <tns:Reference1>${escapeXml(shipment.Reference1 || "")}</tns:Reference1>
          <tns:Reference2></tns:Reference2>
          <tns:Reference3></tns:Reference3>

          <!-- Shipper: include account info here as well (Aramex expects it inside Shipper) -->
          <tns:Shipper>
            <tns:Reference1>${escapeXml(shipment.Shipper.Reference1 || "")}</tns:Reference1>
            <tns:AccountNumber>${escapeXml(clientInfo.AccountNumber || "")}</tns:AccountNumber>
            <tns:AccountPin>${escapeXml(clientInfo.AccountPin || "")}</tns:AccountPin>
            <tns:AccountEntity>${escapeXml(clientInfo.AccountEntity || "")}</tns:AccountEntity>
            <tns:AccountCountryCode>${escapeXml(clientInfo.AccountCountryCode || "")}</tns:AccountCountryCode>
            <tns:PartyAddress>
              <tns:Line1>${escapeXml(sa.Line1 || "")}</tns:Line1>
              <tns:Line2>${escapeXml(sa.Line2 || "")}</tns:Line2>
              <tns:Line3>${escapeXml(sa.Line3 || "")}</tns:Line3>
              <tns:City>${escapeXml(shipperCity)}</tns:City>
              <tns:StateOrProvinceCode>${escapeXml(sa.StateOrProvinceCode || "")}</tns:StateOrProvinceCode>
              <tns:PostCode>${escapeXml(shipperPostCode)}</tns:PostCode>
              <tns:CountryCode>${escapeXml(shipperCountryCode)}</tns:CountryCode>
            </tns:PartyAddress>
            <tns:Contact>
              <tns:PersonName>${escapeXml(sc.PersonName || "")}</tns:PersonName>
              <tns:CompanyName>${escapeXml(sc.CompanyName || "")}</tns:CompanyName>
              <tns:PhoneNumber1>${escapeXml(shipperPhone)}</tns:PhoneNumber1>
              <tns:PhoneNumber2>${escapeXml(sc.PhoneNumber2 || "")}</tns:PhoneNumber2>
              <tns:CellPhone>${escapeXml(shipperPhone)}</tns:CellPhone>
              <tns:EmailAddress>${escapeXml(sc.EmailAddress || "")}</tns:EmailAddress>
              <tns:Type>${escapeXml(sc.Type || "")}</tns:Type>
            </tns:Contact>
          </tns:Shipper>

          <tns:Consignee>
            <tns:Reference1>${escapeXml(shipment.Consignee.Reference1 || "")}</tns:Reference1>
            <tns:PartyAddress>
              <tns:Line1>${escapeXml(ca.Line1 || "")}</tns:Line1>
              <tns:Line2>${escapeXml(ca.Line2 || "")}</tns:Line2>
              <tns:Line3>${escapeXml(ca.Line3 || "")}</tns:Line3>
              <tns:City>${escapeXml(consigneeCity)}</tns:City>
              <tns:StateOrProvinceCode>${escapeXml(ca.StateOrProvinceCode || "")}</tns:StateOrProvinceCode>
              <tns:PostCode>${escapeXml(consigneePostCode)}</tns:PostCode>
              <tns:CountryCode>${escapeXml(consigneeCountryCode)}</tns:CountryCode>
            </tns:PartyAddress>
            <tns:Contact>
              <tns:PersonName>${escapeXml(ccPersonName)}</tns:PersonName>
              <tns:CompanyName>${escapeXml(ccCompanyName)}</tns:CompanyName>
              <tns:PhoneNumber1>${escapeXml(ccPhone)}</tns:PhoneNumber1>
              <tns:PhoneNumber2>${escapeXml(cc.PhoneNumber2 || "")}</tns:PhoneNumber2>
              <tns:CellPhone>${escapeXml(ccPhone)}</tns:CellPhone>
              <tns:EmailAddress>${escapeXml(ccEmail)}</tns:EmailAddress>
              <tns:Type>${escapeXml(cc.Type || "")}</tns:Type>
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
          <tns:Comments>${escapeXml(d.DescriptionOfGoods || "")}</tns:Comments>
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
              <tns:Unit>${escapeXml(d.ActualWeight && d.ActualWeight.Unit ? d.ActualWeight.Unit : "KG")}</tns:Unit>
              <tns:Value>${escapeXml(d.ActualWeight && d.ActualWeight.Value != null ? d.ActualWeight.Value : "")}</tns:Value>
            </tns:ActualWeight>

            <tns:ChargeableWeight>
              <tns:Unit>${escapeXml(d.ChargeableWeight && d.ChargeableWeight.Unit ? d.ChargeableWeight.Unit : "KG")}</tns:Unit>
              <tns:Value>${escapeXml(d.ChargeableWeight && d.ChargeableWeight.Value != null ? d.ChargeableWeight.Value : "")}</tns:Value>
            </tns:ChargeableWeight>

            <tns:DescriptionOfGoods>${escapeXml(d.DescriptionOfGoods || "")}</tns:DescriptionOfGoods>
            <tns:GoodsOriginCountry>${escapeXml(d.GoodsOriginCountry || "")}</tns:GoodsOriginCountry>
            <tns:NumberOfPieces>${escapeXml(d.NumberOfPieces || 1)}</tns:NumberOfPieces>

            <tns:ProductGroup>${escapeXml(d.ProductGroup || "")}</tns:ProductGroup>
            <tns:ProductType>${escapeXml(d.ProductType || "")}</tns:ProductType>
            <tns:PaymentType>${escapeXml(d.PaymentType || "")}</tns:PaymentType>

            <tns:PaymentOptions></tns:PaymentOptions>

            <!-- Ensure CustomsValueAmount present (CurrencyCode before Value) -->
            <tns:CustomsValueAmount>
              <tns:CurrencyCode>${escapeXml((d.CustomsValueAmount && d.CustomsValueAmount.CurrencyCode) || "AED")}</tns:CurrencyCode>
              <tns:Value>${escapeXml(customsValue !== "" ? customsValue : "")}</tns:Value>
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
                  <tns:Value>${escapeXml(d.ActualWeight && d.ActualWeight.Value != null ? d.ActualWeight.Value : "")}</tns:Value>
                </tns:Weight>
                <tns:Comments>${escapeXml(d.DescriptionOfGoods || "")}</tns:Comments>

                <!-- Item-level customs value to satisfy dutiable cases -->
                <tns:ItemValue>
                  <tns:CurrencyCode>${escapeXml((d.CustomsValueAmount && d.CustomsValueAmount.CurrencyCode) || "AED")}</tns:CurrencyCode>
                  <tns:Value>${escapeXml(customsValue !== "" ? customsValue : "")}</tns:Value>
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

// ----------------- Checkout creation with STRICT VALIDATION -----------------
app.post("/create-checkout-session", bodyParser.json(), async (req, res) => {
  try {
    const quantity = Math.max(1, parseInt(req.body.quantity || 1, 10));
    const currency = (req.body.currency || "usd").toLowerCase();
    const prices = {
      usd: { single: 79900, shipping: 4000, double: 129900, extra: 70000 },
      eur: { single: 79900, shipping: 4000, double: 129900, extra: 70000 },
      try: { single: 2799000, shipping: 150000, double: 4599000, extra: 2400000 },
    };
    const c = prices[currency] || prices["usd"];

    let totalAmount;
    if (quantity === 1) totalAmount = c.single;
    else if (quantity === 2) totalAmount = c.double;
    else totalAmount = c.double + (quantity - 2) * c.extra;

    const unitAmount = Math.floor(totalAmount / quantity);

    const shipping_options = quantity === 1
      ? [
          {
            shipping_rate_data: {
              type: "fixed_amount",
              fixed_amount: { amount: c.shipping, currency },
              display_name: "Standard Shipping",
              delivery_estimate: { minimum: { unit: "business_day", value: 5 }, maximum: { unit: "business_day", value: 7 } },
            },
          },
        ]
      : [
          {
            shipping_rate_data: {
              type: "fixed_amount",
              fixed_amount: { amount: 0, currency },
              display_name: "Free Shipping",
              delivery_estimate: { minimum: { unit: "business_day", value: 5 }, maximum: { unit: "business_day", value: 7 } },
            },
          },
        ];

    const sessionParams = {
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: quantity === 1 ? "UV Car Inspection Device (1 pc)" : "UV Car Inspection Device",
              description: "A powerful portable device for car inspection.",
              images: ["https://yourdomain.com/images/device.jpg"],
            },
            unit_amount: unitAmount,
          },
          quantity,
        },
      ],
      // STRICT VALIDATION: Make shipping address collection mandatory
      shipping_address_collection: { 
        allowed_countries: allowedCountriesForStripe(allowedCountries)
      },
      shipping_options,
      // STRICT VALIDATION: Make phone number collection mandatory
      phone_number_collection: { enabled: true },
      // STRICT VALIDATION: Always create customer to ensure we get customer details
      customer_creation: 'always',
      // STRICT VALIDATION: Collect billing address to ensure we have complete customer info
      billing_address_collection: 'required',
      success_url: "https://axis-uv.com/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://axis-uv.com/cancel",
      metadata: { quantity: quantity.toString(), currency },
    };

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ id: session.id });
  } catch (error) {
    console.error("❌ Checkout session creation error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ----------------- Webhook handler with STRICT VALIDATION -----------------
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    console.log("✅ Payment completed for session:", session.id);

    const quantity = parseInt(session.metadata?.quantity || "1", 10);
    const currency = session.metadata?.currency || "usd";

    // Extract customer info and shipping address from the session
    const customerEmail = session.customer_details?.email;
    const customerNameFromDetails = session.customer_details?.name;
    const customerPhone = session.customer_details?.phone;

    // Extract shipping address using the improved function
    const shippingAddress = extractShippingAddress(session);
    const customerNameFromShipping = shippingAddress?.name; // Get name from shipping address if available

    // Prioritize name from shipping address, then customer details, then fallback to email, then generic
    const finalCustomerName = customerNameFromShipping || customerNameFromDetails || customerEmail || "Customer";

    console.log("→ Customer:", finalCustomerName, customerEmail);
    console.log("→ Phone:", customerPhone);
    console.log("→ Shipping to:", JSON.stringify(shippingAddress, null, 2));
    console.log("→ Quantity:", quantity);

    // STRICT VALIDATION: Check all required fields
    const validationErrors = validateRequiredFields(session, shippingAddress);
    
    if (validationErrors.length > 0) {
      console.error("❌ Required fields validation failed:");
      validationErrors.forEach(error => console.error("  - " + error));
      
      // Send email to customer requesting missing information
      if (process.env.SENDGRID_API_KEY && customerEmail) {
        try {
          const msg = {
            to: customerEmail,
            from: process.env.MAIL_FROM,
            subject: "Order Confirmation - Additional Information Required",
            text: `Thank you for your order!\n\nWe need some additional information to process your shipment:\n\n${validationErrors.map(err => "- " + err).join("\n")}\n\nPlease reply to this email with the missing information so we can process your shipment.\n\nOrder Details:\n- Quantity: ${quantity}\n- Order ID: ${session.id}\n\nBest regards,\nAxis UV Team`,
          };
          await sgMail.send(msg);
          console.log("✅ Email sent requesting missing information");
        } catch (emailErr) {
          console.error("❌ Email sending failed:", emailErr);
        }
      }
      
      return res.status(200).send("OK - Missing required information");
    }

    // Calculate weights and values
    const totalWeight = quantity * WEIGHT_PER_PIECE;
    const totalDeclaredValue = quantity * DECLARED_VALUE_PER_PIECE;
    const totalCustomsValue = quantity * CUSTOMS_VALUE_PER_PIECE;

    // Aramex shipment creation
    let trackingId = null;
    let labelUrl = null;
    let aramexError = null;

    try {
      const clientInfo = {
        UserName: process.env.ARAMEX_USER,
        Password: process.env.ARAMEX_PASSWORD,
        Version: process.env.ARAMEX_VERSION || "v2",
        AccountNumber: process.env.ARAMEX_ACCOUNT_NUMBER,
        AccountPin: process.env.ARAMEX_ACCOUNT_PIN,
        AccountEntity: process.env.ARAMEX_ACCOUNT_ENTITY,
        AccountCountryCode: process.env.ARAMEX_ACCOUNT_COUNTRY,
        Source: DEFAULT_SOURCE,
      };

      // Shipper address from environment variables
      const shipperAddress = {
        Line1: process.env.SHIPPER_LINE1,
        Line2: "",
        Line3: "",
        City: process.env.SHIPPER_CITY,
        StateOrProvinceCode: "",
        PostCode: process.env.SHIPPER_POSTCODE,
        CountryCode: process.env.SHIPPER_COUNTRY_CODE,
      };

      const shipperContact = {
        PersonName: process.env.SHIPPER_NAME,
        CompanyName: "AXIS AUTO. TECHNICAL TESTING",
        PhoneNumber1: process.env.SHIPPER_PHONE,
        PhoneNumber2: "",
        CellPhone: process.env.SHIPPER_PHONE,
        EmailAddress: process.env.MAIL_FROM,
        Type: "Shipper",
      };

      // Consignee address from Stripe - NO DEFAULT VALUES, USE ACTUAL DATA
      const consigneeAddress = {
        Line1: shippingAddress.line1,
        Line2: shippingAddress.line2 || "",
        Line3: "",
        City: shippingAddress.city,
        StateOrProvinceCode: shippingAddress.state || "",
        PostCode: shippingAddress.postal_code || "",
        CountryCode: shippingAddress.country.toUpperCase(),
      };

      // Ensure we always have a non-empty name/company for Aramex
      const safeConsigneeName = (finalCustomerName || customerEmail || "Customer").toString().trim();
      const consigneeCompany = (safeConsigneeName && safeConsigneeName.length > 0) ? safeConsigneeName : "Individual";

      const consigneeContact = {
        PersonName: safeConsigneeName,            // اسم المستلم (مطلوب)
        CompanyName: consigneeCompany,            // تعويض CompanyName لأن Aramex يطالبه
        PhoneNumber1: customerPhone || "",        // مطلوب عادة
        PhoneNumber2: "",
        CellPhone: customerPhone || "",
        EmailAddress: customerEmail || "",
        Type: "Consignee",
      };

      // Determine product type based on destination
      const isInternational = consigneeAddress.CountryCode !== "AE";
      const productTypeString = isInternational ? "EPX" : "CDS";

      const shipmentObj = {
        Reference1: session.id,
        Shipper: {
          Reference1: "AXIS AUTO. TECHNICAL TESTING",
          PartyAddress: shipperAddress,
          Contact: shipperContact,
        },
        Consignee: {
          Reference1: finalCustomerName,
          PartyAddress: consigneeAddress,
          Contact: consigneeContact,
        },
        Details: {
          ActualWeight: { Unit: "KG", Value: totalWeight },
          ChargeableWeight: { Unit: "KG", Value: totalWeight },
          DescriptionOfGoods: "UV Car Inspection Device",
          GoodsOriginCountry: "AE",
          NumberOfPieces: quantity,
          ProductGroup: isInternational ? "EXP" : "DOM",
          ProductType: productTypeString,
          PaymentType: "P",
          CustomsValueAmount: { CurrencyCode: "AED", Value: totalCustomsValue },
          ShippingDateTime: new Date().toISOString(),
        },
      };

      console.log("→ Creating Aramex shipment with validated details:", JSON.stringify(maskForLog({
        quantity,
        weight: totalWeight,
        declaredValue: totalDeclaredValue,
        customsValue: totalCustomsValue,
        destination: consigneeAddress.CountryCode,
        account: clientInfo.AccountNumber,
        productType: productTypeString,
        dimensions: "30x20x15 CM",
        consigneeAddress: consigneeAddress,
        consigneeName: finalCustomerName,
        consigneePhone: customerPhone,
        consigneeEmail: customerEmail,
      })));

      // Log the exact contact sent to Aramex (masked)
      console.log("→ Aramex Consignee Contact being sent:", maskForLog({
        PersonName: consigneeContact.PersonName,
        CompanyName: consigneeContact.CompanyName,
        PhoneNumber1: consigneeContact.PhoneNumber1,
        EmailAddress: consigneeContact.EmailAddress,
      }));

      const xml = buildShipmentCreationXml({
        clientInfo,
        transactionRef: session.id || "",
        labelReportId: DEFAULT_REPORT_ID,
        shipment: shipmentObj,
      });

      // sanitized XML preview for logs (hide password/pin)
      const safeXml = xml.replace(/(<tns:Password>).*?(<\/tns:Password>)/g, "$1***$2").replace(/(<tns:AccountPin>).*?(<\/tns:AccountPin>)/g, "$1***$2");
      console.log("→ XML length:", xml.length, "characters");
      console.log("→ XML preview (sanitized):", safeXml.substring(0, 1600));

      const headers = {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": "http://ws.aramex.net/ShippingAPI/v1/Service_1_0/CreateShipments",
      };

      const resp = await axios.post(ARAMEX_ENDPOINT, xml, { headers, timeout: 30000 });

      if (resp && resp.data) {
        console.log("⤷ Aramex raw response (snippet):", (typeof resp.data === "string" ? resp.data.substring(0, 2000) : JSON.stringify(resp.data).substring(0, 2000)));
      }

      let parsed = null;
      try {
        parsed = await parseStringPromise(resp.data, { explicitArray: false, ignoreAttrs: true, trim: true });
      } catch (e) {
        console.warn("Could not parse Aramex response XML:", e && e.message ? e.message : e);
      }

      // Collect errors/notifications from multiple possible locations
      let hasErrors = false;
      let notifications = [];

      try {
        const body = parsed && (parsed["s:Envelope"] && parsed["s:Envelope"]["s:Body"] ? parsed["s:Envelope"]["s:Body"] : parsed);
        const respRoot = body && (body.ShipmentCreationResponse || body);

        if (respRoot && (respRoot.HasErrors === "true" || respRoot.HasErrors === true)) hasErrors = true;

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
            if (p.HasErrors === "true" || p.HasErrors === true) hasErrors = true;
            if (p.Notifications) notifications = notifications.concat(collectNotificationsFromNode(p.Notifications));
          }
        }

      } catch (e) {
        console.warn("Could not parse error info:", e && e.message ? e.message : e);
      }

      if (hasErrors || notifications.length > 0) {
        console.error("❌ Aramex returned errors:", notifications);
        aramexError = notifications.map((n) => {
          const code = n.Code || n.code || "";
          const msg = n.Message || n.message || (typeof n === "string" ? n : JSON.stringify(n));
          return code ? `${code}: ${msg}` : msg;
        }).join("; ");
      } else {
        try {
          const body = parsed && (parsed["s:Envelope"] && parsed["s:Envelope"]["s:Body"] ? parsed["s:Envelope"]["s:Body"] : parsed);
          const respRoot = body && (body.ShipmentCreationResponse || body);
          const shipments = respRoot && respRoot.Shipments && respRoot.Shipments.ProcessedShipment ? respRoot.Shipments.ProcessedShipment : null;

          if (shipments) {
            const shipment = Array.isArray(shipments) ? shipments[0] : shipments;
            trackingId = shipment && shipment.ID ? shipment.ID : null;
            labelUrl = shipment && shipment.ShipmentLabel && shipment.ShipmentLabel.LabelURL ? shipment.ShipmentLabel.LabelURL : null;

            if (trackingId) {
              console.log("✅ Aramex shipment created successfully!");
              console.log("→ Tracking ID:", trackingId);
              console.log("→ Label URL:", labelUrl);
            }
          }
        } catch (e) {
          console.warn("Could not extract shipment info:", e && e.message ? e.message : e);
        }
      }

    } catch (err) {
      console.error("❌ Aramex API error:", err && err.message ? err.message : err);
      if (err.response && err.response.data) {
        console.error("❌ Aramex response data:", err.response.data);
      }
      // aramexError may have been set earlier
      aramexError = aramexError || (err && err.message ? err.message : "Unknown Aramex API error");
    }

    // Send email notification (if configured)
    if (process.env.SENDGRID_API_KEY && customerEmail) {
      try {
        let emailContent = `Thank you for your order!\n\nOrder Details:\n- Quantity: ${quantity}\n- Total Weight: ${totalWeight} KG\n- Declared Value: ${totalDeclaredValue} AED\n- Customs Value: ${totalCustomsValue} AED\n- Dimensions: 30x20x15 CM\n`;

        if (trackingId) {
          emailContent += `\nShipping Information:\n- Tracking ID: ${trackingId}\n`;
          if (labelUrl) {
            emailContent += `- Shipping Label: ${labelUrl}\n`;
          }
        } else if (aramexError) {
          emailContent += `\nShipping Status: Processing (${aramexError})\n`;
        } else {
          emailContent += `\nShipping Status: Processing\n`;
        }

        emailContent += `\nBest regards,\nAxis UV Team`;

        const msg = {
          to: customerEmail,
          from: process.env.MAIL_FROM,
          subject: "Order Confirmation - UV Car Inspection Device",
          text: emailContent,
        };
        await sgMail.send(msg);
        console.log("✅ Email sent to:", customerEmail);
      } catch (emailErr) {
        console.error("❌ Email sending failed:", emailErr && emailErr.message ? emailErr.message : emailErr);
      }
    }

    console.log("✅ Webhook processed successfully");
    if (trackingId) {
      console.log("→ Shipment created with tracking:", trackingId);
    } else {
      console.log("→ Shipment creation failed:", aramexError || "Unknown error");
    }
  }

  res.status(200).send("OK");
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("🔧 Environment check:", missingEnvs.length ? `Missing: ${missingEnvs.join(", ")}` : "All required env vars present");
});
