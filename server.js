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
// ---- Resilient Aramex HTTP helpers (keep-alive, retries, backoff) ----
const https = require("https");
const http = require("http");

// axios instances tuned for Aramex endpoints
const aramexAxios = axios.create({
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 10 }),
  timeout: 60000, // 60s default for shipment creation
});
const locationAxios = axios.create({
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 6 }),
  timeout: 20000, // 20s for location API
});

async function postToAramexWithRetries(xml, headers, maxAttempts = 3) {
  let attempt = 0;
  let lastErr = null;
  const baseDelay = 500; // ms
  while (++attempt <= maxAttempts) {
    try {
      const resp = await aramexAxios.post(ARAMEX_ENDPOINT, xml, { headers, timeout: 60000 });
      return resp;
    } catch (err) {
      lastErr = err;
      const status = err && err.response && err.response.status;
      const isRetryable =
        err.code === "ECONNABORTED" ||
        err.code === "ECONNRESET" ||
        err.code === "ENOTFOUND" ||
        err.code === "ETIMEDOUT" ||
        (status && status >= 500 && status < 600);
      console.warn(`Aramex POST attempt ${attempt} failed: ${err && err.message ? err.message : err}. retryable=${!!isRetryable}`);
      if (!isRetryable || attempt === maxAttempts) break;
      const delay = Math.round(baseDelay * Math.pow(3, attempt - 1) * (0.8 + Math.random() * 0.4));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr || new Error("Aramex POST failed (unknown)");
}

async function postLocationWithRetries(xml, headers, maxAttempts = 2) {
  let attempt = 0;
  let lastErr = null;
  const baseDelay = 300;
  while (++attempt <= maxAttempts) {
    try {
      const resp = await locationAxios.post(ARAMEX_LOCATION_ENDPOINT, xml, { headers, timeout: 20000 });
      return resp;
    } catch (err) {
      lastErr = err;
      const status = err && err.response && err.response.status;
      const isRetryable = err.code === "ECONNABORTED" || err.code === "ENOTFOUND" || (status && status >= 500 && status < 600);
      console.warn(`Aramex Location attempt ${attempt} failed: ${err && err.message ? err.message : err}. retryable=${!!isRetryable}`);
      if (!isRetryable || attempt === maxAttempts) break;
      const delay = Math.round(baseDelay * attempt * (0.9 + Math.random() * 0.2));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr || new Error("Aramex Location POST failed (unknown)");
}


// Location API endpoint (new) - can be overridden by env
const ARAMEX_LOCATION_ENDPOINT =
  process.env.ARAMEX_LOCATION_ENDPOINT ||
  "https://ws.aramex.net/ShippingAPI.V2/Location/Service_1_0.svc";

// constants
const WEIGHT_PER_PIECE = 2.0; // kg per piece (تم التعديل من 1.63 إلى 2.0)
const DECLARED_VALUE_PER_PIECE = 200; // AED per piece
const CUSTOMS_VALUE_PER_PIECE = 250; // AED per piece for customs
const DEFAULT_SOURCE = parseInt(process.env.ARAMEX_SOURCE || "24", 10);
const DEFAULT_REPORT_ID = parseInt(process.env.ARAMEX_REPORT_ID || "9729", 10);

// Full allowed countries for Stripe shipping collection (exact as original)
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

            <tns:PaymentOptions>ACCT</tns:PaymentOptions> <!-- تم التعديل من Prepaid Stock إلى ACCOUNT -->

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

// ----------------- City resolution helpers (new) -----------------

function normalizeForCompare(s) {
  if (!s) return "";
  try {
    return s
      .toString()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  } catch (e) {
    return s
      .toString()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }
}

function levenshtein(a, b) {
  const an = a.length, bn = b.length;
  if (an === 0) return bn;
  if (bn === 0) return an;
  const matrix = Array.from({ length: an + 1 }, (_, i) => Array(bn + 1).fill(0));
  for (let i = 0; i <= an; i++) matrix[i][0] = i;
  for (let j = 0; j <= bn; j++) matrix[0][j] = j;
  for (let i = 1; i <= an; i++) {
    for (let j = 1; j <= bn; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[an][bn];
}

function bestFuzzyMatch(input, candidates, maxDistance = 3) {
  if (!input || !candidates || candidates.length === 0) return null;
  const inNorm = normalizeForCompare(input);
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const cNorm = normalizeForCompare(c);
    const dist = levenshtein(inNorm, cNorm);
    if (dist < bestScore) {
      best = c;
      bestScore = dist;
    }
  }
  if (bestScore <= Math.max(1, Math.floor(inNorm.length * 0.3)) || bestScore <= maxDistance) {
    return best;
  }
  return null;
}

async function fetchAramexCities({ clientInfo, countryCode, prefix = "", postalCode = "" }) {
  if (!countryCode) return null;

  const xml = `<?xml version="1.0" encoding="utf-8"?>
  <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://ws.aramex.net/ShippingAPI/v1/">
    <soap:Header/>
    <soap:Body>
      <tns:FetchCities>
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
        <tns:CountryCode>${escapeXml(countryCode)}</tns:CountryCode>
        <tns:City>${escapeXml(prefix || "")}</tns:City>
        <tns:ZipCode>${escapeXml(postalCode || "")}</tns:ZipCode>
      </tns:FetchCities>
    </soap:Body>
  </soap:Envelope>`;

  const headersWithSoapAction = {
    "Content-Type": "text/xml; charset=utf-8",
    "SOAPAction": "http://ws.aramex.net/ShippingAPI/v1/Service_1_0/FetchCities",
  };

  const headersNoSoapAction = {
    "Content-Type": "text/xml; charset=utf-8",
  };

  try {
    let resp = await postLocationWithRetries(xml, headersWithSoapAction, 2);
    if (!resp || !resp.data) throw new Error("Empty response");
    let parsed = null;
    try {
      parsed = await parseStringPromise(resp.data, { explicitArray: false, ignoreAttrs: true, trim: true });
    } catch (e) {
      parsed = null;
    }
    const cities = [];
    try {
      const body = parsed && (parsed["s:Envelope"] && parsed["s:Envelope"]["s:Body"] ? parsed["s:Envelope"]["s:Body"] : parsed);
      const respRoot = body && (body.FetchCitiesResponse || body);
      if (respRoot && respRoot.Cities) {
        const node = respRoot.Cities;
        if (Array.isArray(node.City)) {
          for (const cc of node.City) {
            if (typeof cc === "string") cities.push(cc);
            else if (cc.Name) cities.push(cc.Name);
          }
        } else if (node.City) {
          const cc = node.City;
          if (typeof cc === "string") cities.push(cc);
          else if (cc.Name) cities.push(cc.Name);
        }
      }
    } catch (e) {}
    if (cities.length === 0) {
      const raw = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
      const regex = /<Name>([^<]{2,60})<\/Name>/gi;
      let m;
      while ((m = regex.exec(raw)) !== null) {
        cities.push(m[1]);
      }
    }
    return cities.length ? Array.from(new Set(cities)) : null;
  } catch (err) {
    try {
      let resp = await postLocationWithRetries(xml, headersNoSoapAction, 2);
      if (!resp || !resp.data) throw new Error("Empty response");
      let parsed = null;
      try {
        parsed = await parseStringPromise(resp.data, { explicitArray: false, ignoreAttrs: true, trim: true });
      } catch (e) {
        parsed = null;
      }
      const cities = [];
      try {
        const body = parsed && (parsed["s:Envelope"] && parsed["s:Envelope"]["s:Body"] ? parsed["s:Envelope"]["s:Body"] : parsed);
        const respRoot = body && (body.FetchCitiesResponse || body);
        if (respRoot && respRoot.Cities) {
          const node = respRoot.Cities;
          if (Array.isArray(node.City)) {
            for (const cc of node.City) {
              if (typeof cc === "string") cities.push(cc);
              else if (cc.Name) cities.push(cc.Name);
            }
          } else if (node.City) {
            const cc = node.City;
            if (typeof cc === "string") cities.push(cc);
            else if (cc.Name) cities.push(cc.Name);
          }
        }
      } catch (e) {}
      if (cities.length === 0) {
        const raw = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
        const regex = /<Name>([^<]{2,60})<\/Name>/gi;
        let m;
        while ((m = regex.exec(raw)) !== null) {
          cities.push(m[1]);
        }
      }
      return cities.length ? Array.from(new Set(cities)) : null;
    } catch (err2) {
      console.warn("Aramex Location API fetch failed:", (err2 && err2.message) || err.message || err2);
      return null;
    }
  }
}

async function resolveCity(countryCode, rawCity, postalCode = "") {
  try {
    if (!rawCity) return "";

    const quick = normalizeCity(rawCity, countryCode);
    const clientInfo = {
      UserName: process.env.ARAMEX_USER,
      Password: process.env.ARAMEX_PASSWORD,
      Version: process.env.ARAMEX_VERSION || "v1",
      AccountNumber: process.env.ARAMEX_ACCOUNT_NUMBER,
      AccountPin: process.env.ARAMEX_ACCOUNT_PIN,
      AccountEntity: process.env.ARAMEX_ACCOUNT_ENTITY,
      AccountCountryCode: process.env.ARAMEX_ACCOUNT_COUNTRY,
      Source: DEFAULT_SOURCE,
    };

    const prefix = (quick || rawCity).substring(0, 40);
    const cities = await fetchAramexCities({ clientInfo, countryCode, prefix, postalCode });

    if (cities && cities.length > 0) {
      const exact = cities.find((c) => normalizeForCompare(c) === normalizeForCompare(rawCity));
      if (exact) return exact;

      const best = bestFuzzyMatch(rawCity, cities);
      if (best) return best;

      const starts = cities.find((c) => normalizeForCompare(c).startsWith(normalizeForCompare(rawCity).slice(0, 3)));
      if (starts) return starts;
    }

    const fallback = quick
      .toLowerCase()
      .split(" ")
      .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ");

    return fallback || rawCity;
  } catch (e) {
    console.warn("resolveCity error:", e && e.message ? e.message : e);
    return rawCity;
  }
}

// ----------------- NEW HELPER: enrich session by fetching Stripe customer/payment info and merging ---
async function enrichSessionWithStripeData(session) {
  // Returns an object { session, customerObj, paymentIntentObj, billingDetails, mergedShipping, mergedContact }
  try {
    const out = {
      session,
      customerObj: null,
      paymentIntentObj: null,
      billingDetails: null,
      mergedShipping: null,
      mergedContact: null,
    };

    // 1) retrieve customer if present
    if (session.customer) {
      try {
        out.customerObj = await stripe.customers.retrieve(session.customer);
      } catch (e) {
        console.warn("Could not retrieve stripe customer:", e && e.message ? e.message : e);
      }
    }

    // 2) retrieve payment intent to get billing_details (charges -> billing_details)
    if (session.payment_intent) {
      try {
        out.paymentIntentObj = await stripe.paymentIntents.retrieve(session.payment_intent, { expand: ["charges.data.payment_method"] });
        // billing details prefer charges[0].billing_details
        if (out.paymentIntentObj && out.paymentIntentObj.charges && out.paymentIntentObj.charges.data && out.paymentIntentObj.charges.data.length > 0) {
          const charge = out.paymentIntentObj.charges.data[0];
          out.billingDetails = charge.billing_details || null;
        }
      } catch (e) {
        console.warn("Could not retrieve payment intent:", e && e.message ? e.message : e);
      }
    }

    // 3) build merged contact and shipping/address by priority:
    // priority for name: shipping.name -> session.customer_details?.name -> customerObj?.name -> billingDetails?.name -> billingDetails?.email -> email
    const sd = session.shipping_details || session.shipping || {};
    const sessCust = session.customer_details || {};
    const cust = out.customerObj || {};
    const bill = out.billingDetails || {};

    const mergedName = (sd.name || sessCust.name || cust.name || bill.name || sessCust.email || cust.email || "").toString().trim();
    const mergedEmail = (sessCust.email || cust.email || bill.email || "").toString().trim();
    const mergedPhone = (sessCust.phone || cust.phone || bill.phone || "").toString().trim();

    // address merging (prefer shipping_details.address, then customerObj.shipping.address, then billingDetails.address)
    const addrCandidates = [
      sd.address || null,
      (cust.shipping && cust.shipping.address) || null,
      (cust.address) || null,
      bill && bill.address ? bill.address : null,
      sessCust.address || null,
    ].filter(Boolean);

    // pick first non-null; convert Stripe address keys to unified shape (line1,line2,city,state,postal_code,country)
    const normalizeStripeAddress = (a) => {
      if (!a) return null;
      return {
        line1: a.line1 || a.address_line1 || a.street || "",
        line2: a.line2 || a.address_line2 || "",
        city: a.city || a.locality || a.town || a.region || "",
        state: a.state || a.province || "",
        postal_code: a.postal_code || a.postcode || a.zip || "",
        country: (a.country || a.country_code || "").toString().toUpperCase(),
        name: sd.name || sessCust.name || cust.name || bill.name || "",
      };
    };

    const mergedShipping = addrCandidates.length ? normalizeStripeAddress(addrCandidates[0]) : null;

    // If mergedShipping missing but billing has address, use billing
    if (!mergedShipping && bill && bill.address) {
      mergedShipping = normalizeStripeAddress(bill.address);
    }

    // mergedContact: name, email, phone
    const mergedContact = {
      name: mergedName || "",
      email: mergedEmail || "",
      phone: mergedPhone || "",
    };

    out.mergedShipping = mergedShipping;
    out.mergedContact = mergedContact;

    return out;
  } catch (e) {
    console.warn("enrichSessionWithStripeData error:", e && e.message ? e.message : e);
    return { session, customerObj: null, paymentIntentObj: null, billingDetails: null, mergedShipping: null, mergedContact: null };
  }
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

    // unitAmount removed as single-source-of-truth because of rounding issues;
    // we'll construct line_items so that sum(line.amount * qty) === totalAmount exactly.

    // Image URLs provided by user
    const imageSingle = "https://github.com/Axis-auto/uv/blob/main/one-piece_1%20(1).jpg?raw=true";
    const imageMulti = "https://github.com/Axis-auto/uv/blob/main/tow-pieces%20(1).jpg?raw=true";

    const selectedImage = quantity === 1 ? imageSingle : imageMulti;

    // Calculate per-piece integer amounts (in smallest currency unit, e.g., cents)
    const perPiece = Math.floor(totalAmount / quantity);
    const remainder = totalAmount - perPiece * quantity;

    // Build line_items so Stripe shows correct total (avoid per-unit rounding discrepancies)
    const line_items = [];

    const baseProductData = {
      currency,
      product_data: {
        name: quantity === 1 ? "UV Car Inspection Device (1 pc)" : `UV Car Inspection Device`,
        description: "A powerful portable device for car inspection.",
        images: [selectedImage],
      }
    };

    if (remainder === 0) {
      // Perfect division: one line item with quantity
      line_items.push({
        price_data: {
          currency,
          product_data: baseProductData.product_data,
          unit_amount: perPiece,
        },
        quantity,
      });
    } else {
      // Non-even division: create two line items to distribute rounding remainder
      // First line: quantity - 1 pieces at perPiece
      // Second line: 1 piece with perPiece + remainder (covers total exactly)
      if (quantity === 1) {
        // Fallback safety (should not happen because remainder would be zero if qty === 1)
        line_items.push({
          price_data: {
            currency,
            product_data: baseProductData.product_data,
            unit_amount: totalAmount,
          },
          quantity: 1,
        });
      } else {
        const firstQty = quantity - 1;
        const firstUnit = perPiece;
        const lastUnit = perPiece + remainder;

        // Push first line (quantity - 1)
        line_items.push({
          price_data: {
            currency,
            product_data: baseProductData.product_data,
            unit_amount: firstUnit,
          },
          quantity: firstQty,
        });

        // Push second line (1 piece with adjusted unit amount)
        line_items.push({
          price_data: {
            currency,
            product_data: {
              name: `UV Car Inspection Device (${quantity} pcs) - price adjustment`,
              description: "Adjustment line to ensure correct total price",
              images: [selectedImage],
            },
            unit_amount: lastUnit,
          },
          quantity: 1,
        });
      }
    }

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
      line_items: line_items,
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

// ----------------- Webhook handler with ENRICH + STRICT VALIDATION -----------------
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
    // start processing
    const session = event.data.object;
    console.log("✅ Payment completed for session:", session.id);

    try {
      // Enrich session with extra Stripe data
      const enriched = await enrichSessionWithStripeData(session);
      const mergedShippingFromStripe = enriched.mergedShipping; // may be null
      const mergedContact = enriched.mergedContact || {};

      // Build shippingAddress object used by downstream (normalize keys)
      let shippingAddress =
        // prefer shipping_details.address from session
        (session.shipping_details && session.shipping_details.address) ||
        (session.shipping && session.shipping.address) ||
        mergedShippingFromStripe ||
        (session.customer_details && session.customer_details.address) ||
        null;

      // Normalize shape if needed (Stripe sometimes uses different keys)
      if (shippingAddress && !shippingAddress.line1 && (shippingAddress.address_line1 || shippingAddress.street)) {
        shippingAddress = {
          line1: shippingAddress.address_line1 || shippingAddress.street || "",
          line2: shippingAddress.address_line2 || "",
          city: shippingAddress.city || shippingAddress.locality || shippingAddress.town || shippingAddress.region || "",
          state: shippingAddress.state || shippingAddress.province || "",
          postal_code: shippingAddress.postal_code || shippingAddress.postcode || shippingAddress.zip || "",
          country: (shippingAddress.country || shippingAddress.country_code || "").toUpperCase(),
          name: shippingAddress.name || "",
        };
      } else if (shippingAddress && shippingAddress.line1 && !shippingAddress.postal_code) {
        // ensure consistent keys
        shippingAddress.postal_code = shippingAddress.postal_code || shippingAddress.postcode || shippingAddress.zip || "";
        shippingAddress.country = (shippingAddress.country || shippingAddress.country_code || "").toUpperCase();
        shippingAddress.city = shippingAddress.city || shippingAddress.town || shippingAddress.locality || "";
      }

      // Ensure contact fields exist (fallbacks)
      const customerEmail = mergedContact.email || session.customer_details?.email || (enriched.customerObj && enriched.customerObj.email) || "";
      const customerNameFromDetails = mergedContact.name || session.customer_details?.name || (enriched.customerObj && enriched.customerObj.name) || "";
      const customerPhone = mergedContact.phone || session.customer_details?.phone || (enriched.customerObj && enriched.customerObj.phone) || "";

      // Prefer name in shipping address if present
      const customerNameFromShipping = shippingAddress?.name || "";

      const finalCustomerName = (customerNameFromShipping || customerNameFromDetails || customerEmail || "Customer").toString();

      console.log("→ Merged customer info:", { finalCustomerName, customerEmail, customerPhone, shippingAddress });

      // If no shippingAddress found at all, attempt to form one from billing details (last resort)
      if (!shippingAddress) {
        const bill = enriched.billingDetails || null;
        if (bill && bill.address) {
          shippingAddress = {
            line1: bill.address.line1 || "",
            line2: bill.address.line2 || "",
            city: bill.address.city || "",
            state: bill.address.state || "",
            postal_code: bill.address.postal_code || bill.address.postcode || bill.address.zip || "",
            country: (bill.address.country || "").toUpperCase(),
            name: bill.name || finalCustomerName,
          };
        }
      }

      // STRICT VALIDATION + AUTO-FIX: try to normalize postcode and city before validateRequiredFields
      const countryCode = (shippingAddress?.country || "").toUpperCase();
      let postal = validateAndNormalizePostCode(shippingAddress?.postal_code || shippingAddress?.postalCode || shippingAddress?.postCode || "", countryCode);

      // Auto-fix rule 1: if postal is invalid but country is known to not use postal codes (e.g., AE), set to empty
      const countriesWithoutPostcode = ["AE","AG","AI","AQ","AW","BS","BB","BZ","BM","BQ","BV","IO","KY","CK","CW","FK","FO","GF","GG","GL","GN","GQ","GS","GU","GW","HK","HM","KN","LC","MF","MS","NU","NF","NL","PN","PS","PR","SX","SB","TC","TK","TT","TV","UM","VI","WF","WS"];
      if ((postal === "" || postal == null) && countriesWithoutPostcode.includes(countryCode)) {
        postal = "";
      }

      // Auto-fix rule 2: try to resolve/normalize city via resolveCity (uses Aramex FetchCities + fuzzy match)
      // Declare normalizedCity once here
      let normalizedCity = shippingAddress?.city || shippingAddress?.town || shippingAddress?.locality || "";
      try {
        if (normalizedCity && countryCode) {
          const resolved = await resolveCity(countryCode, normalizedCity, postal);
          if (resolved && resolved.length > 0) {
            normalizedCity = resolved;
          }
        } else if (!normalizedCity && postal && countryCode) {
          // If city empty but postal present: try fetchAramexCities by postal only
          const clientInfo = {
            UserName: process.env.ARAMEX_USER,
            Password: process.env.ARAMEX_PASSWORD,
            Version: process.env.ARAMEX_VERSION || "v1",
            AccountNumber: process.env.ARAMEX_ACCOUNT_NUMBER,
            AccountPin: process.env.ARAMEX_ACCOUNT_PIN,
            AccountEntity: process.env.ARAMEX_ACCOUNT_ENTITY,
            AccountCountryCode: process.env.ARAMEX_ACCOUNT_COUNTRY,
            Source: DEFAULT_SOURCE,
          };
          const citiesByPostal = await fetchAramexCities({ clientInfo, countryCode, prefix: "", postalCode: postal });
          if (citiesByPostal && citiesByPostal.length > 0) {
            normalizedCity = citiesByPostal[0];
          }
        }
      } catch (e) {
        console.warn("City auto-resolve failed:", e && e.message ? e.message : e);
      }

      // If postcode looked invalid for the country (validate returned empty) AND we couldn't get helpful city info via Aramex,
      // remove the postcode (many Aramex endpoints accept empty postal for many countries) to avoid hard-failure.
      if (!postal) {
        postal = "";
      }

      // Ensure shippingAddress object has the normalized fields to proceed
      shippingAddress = shippingAddress || {};
      shippingAddress.postal_code = postal;
      shippingAddress.city = normalizedCity || shippingAddress.city || "";

      // Run validation; if missing required fields, attempt automated corrections before failing
      const validationErrors = validateRequiredFields(session, shippingAddress);

      // Attempt automated corrections if there are missing required fields
      if (validationErrors.length > 0) {
        console.warn("Initial validation errors:", validationErrors);

        // Attempt 1: If name missing, fill from finalCustomerName
        if (validationErrors.some(e => /Customer name/i.test(e))) {
          if (!shippingAddress.name || shippingAddress.name.trim() === "") {
            shippingAddress.name = finalCustomerName;
          }
        }

        // Attempt 2: If phone missing, fill from merged contact
        if (validationErrors.some(e => /Customer phone/i.test(e))) {
          // if we have merged contact phone, ensure it's used in the final contact for Aramex (later)
          // else leave it to final email fallback
        }

        // Attempt 3: If postal invalid, we've set it to empty above; re-run validations
        // Attempt 4: If city invalid (empty), try to set to fallback normalized city
        if (!shippingAddress.city || shippingAddress.city.trim() === "") {
          // fallback: attempt to build from address lines (e.g., "Istanbul" inside line2 etc.)
          const possible = (shippingAddress.line1 || "") + " " + (shippingAddress.line2 || "");
          if (possible && possible.length > 3) {
            const tokens = possible.split(/\s+/);
            shippingAddress.city = tokens[tokens.length - 1];
          }
        }

        // Re-run validation after attempted fixes
        const reValidationErrors = validateRequiredFields(session, shippingAddress);
        if (reValidationErrors.length > 0) {
          console.error("❌ After auto-fixes, still missing fields:", reValidationErrors);

          // As a last resort: send customer an email requesting missing info (existing behavior)
          if (process.env.SENDGRID_API_KEY && customerEmail) {
            try {
              const msg = {
                to: customerEmail,
                from: process.env.MAIL_FROM,
                subject: "Order Confirmation - Additional Information Required",
                text: `Thank you for your order!\n\nWe need some additional information to process your shipment:\n\n${reValidationErrors.map(err => "- " + err).join("\n")}\n\nPlease reply to this email with the missing information so we can process your shipment.\n\nOrder Details:\n- Order ID: ${session.id}\n\nBest regards,\nAxis UV Team`,
              };
              await sgMail.send(msg);
              console.log("✅ Email sent requesting missing information (final fallback)");
            } catch (emailErr) {
              console.error("❌ Email sending failed (final fallback):", emailErr);
            }
          }

          // respond OK to Stripe webhook but abort Aramex creation (we already emailed)
          console.log("→ Aborting Aramex creation due to missing/invalid customer data after auto-fixes.");
          return res.status(200).send("OK - Missing required information after auto-fix");
        }
      }

      // If we reach here, shippingAddress has been enriched/normalized and validated; proceed to Aramex creation
      console.log("→ Proceeding to Aramex with shippingAddress:", JSON.stringify(shippingAddress, null, 2));

      // Continue with existing Aramex shipment creation logic (unchanged) but using shippingAddress, finalCustomerName, customerEmail, customerPhone

      // Calculate weights and values
      const quantity = parseInt(session.metadata?.quantity || "1", 10);
      const totalWeight = quantity * WEIGHT_PER_PIECE;
      const totalDeclaredValue = quantity * DECLARED_VALUE_PER_PIECE;
      const totalCustomsValue = quantity * CUSTOMS_VALUE_PER_PIECE;

      // Resolve / normalize city BEFORE creating the Aramex shipment (we already attempted resolve, but do it again defensively)
      // <-- IMPORTANT FIX: do NOT redeclare normalizedCity (we declared it above). Use assignment only.
      normalizedCity = shippingAddress?.city || "";
      const country = (shippingAddress?.country || "").toUpperCase();
      const postalAgain = validateAndNormalizePostCode(shippingAddress?.postal_code || shippingAddress?.postalCode || shippingAddress?.postCode || "", country);

      try {
        normalizedCity = await resolveCity(country, normalizedCity, postalAgain);
        console.log("→ Resolved city (final):", normalizedCity);
      } catch (e) {
        console.warn("→ City resolution failed (final), using provided city:", e && e.message ? e.message : e);
        normalizedCity = shippingAddress?.city || normalizedCity;
      }

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
          City: normalizedCity,
          StateOrProvinceCode: shippingAddress.state || "",
          PostCode: shippingAddress.postal_code || shippingAddress.postalCode || shippingAddress.postCode || "",
          CountryCode: country,
        };

        // Ensure we always have a non-empty name/company for Aramex
        const safeConsigneeName = (finalCustomerName || customerEmail || "Customer").toString().trim();
        const consigneeCompany = (safeConsigneeName && safeConsigneeName.length > 0) ? safeConsigneeName : "Individual";

        const consigneeContact = {
          PersonName: safeConsigneeName,            // اسم المستلم (مطلوب)
          CompanyName: consigneeCompany,            // تعويض CompanyName لأن Aramex يطالبه
          PhoneNumber1: customerPhone || "",
          PhoneNumber2: "",
          CellPhone: customerPhone || "",
          EmailAddress: customerEmail || "",
          Type: "Consignee",
        };

        // Determine product type based on destination
        const isInternational = consigneeAddress.CountryCode !== "AE";
        // تم التعديل من EPX إلى PPX للشحن الدولي
        const productTypeString = isInternational ? "PPX" : "CDS";

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
            ChargeableWeight: { Unit: "KG", Value: totalWeight }, // Actual and Chargeable weight are now the same
            DescriptionOfGoods: "UV Car Inspection Device",
            GoodsOriginCountry: "AE",
            NumberOfPieces: quantity,
            ProductGroup: isInternational ? "EXP" : "DOM",
            ProductType: productTypeString, // تم التعديل هنا
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

        const resp = await postToAramexWithRetries(xml, headers, 3);

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
        aramexError = aramexError || (err && err.message ? err.message : "Unknown Aramex API error");
      }

      // Send email notification (if configured)
      if (process.env.SENDGRID_API_KEY && customerEmail) {
        try {
          // FIX: استخدم الرابط المباشر للصورة بدلاً من رابط GitHub
          const logoUrl = "https://raw.githubusercontent.com/Axis-auto/uv/main/LOGO%20(2).png";

          // Recalculate totalAmount and define currency for email (fix for undefined error)
          const currency = (session.metadata?.currency || "usd").toLowerCase();
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

          let textContent = `
Thank you for your purchase from AXIS AUTO!

ORDER CONFIRMATION
------------------
Order ID: ${session.id}
Order Date: ${new Date().toLocaleDateString()}
Quantity: ${quantity} x UV Car Inspection Device
Total Amount: ${(totalAmount/100).toFixed(2)} ${currency.toUpperCase()}

SHIPPING DETAILS
----------------
Shipping Address:
${finalCustomerName}
${shippingAddress.line1}${shippingAddress.line2 ? ', ' + shippingAddress.line2 : ''}
${shippingAddress.city}, ${shippingAddress.state || ''} ${shippingAddress.postal_code}
${shippingAddress.country}

Customer Contact:
Email: ${customerEmail}
Phone: ${customerPhone || 'Not provided'}

SHIPPING INFORMATION
--------------------
`;

          let htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; }
    .header { text-align: center; padding: 20px 0; border-bottom: 2px solid #f8f8f8; }
    .logo { max-width: 180px; }
    .order-details { background: #f9f9f9; padding: 20px; margin: 20px 0; border-radius: 5px; }
    .shipping-info { margin: 20px 0; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #777; font-size: 12px; }
    .status-badge { background: #4CAF50; color: white; padding: 5px 10px; border-radius: 3px; display: inline-block; }
  </style>
</head>
<body>
  <div class="header">
    <img src="${logoUrl}" alt="AXIS AUTO" class="logo">
    <h1>Order Confirmation</h1>
  </div>

  <p>Dear ${finalCustomerName},</p>
  
  <p>Thank you for your purchase from <strong>AXIS AUTO</strong>! Your order has been confirmed and is being processed.</p>

  <div class="order-details">
    <h2>Order Details</h2>
    <p><strong>Order ID:</strong> ${session.id}</p>
    <p><strong>Order Date:</strong> ${new Date().toLocaleDateString()}</p>
    <p><strong>Product:</strong> UV Car Inspection Device</p>
    <p><strong>Quantity:</strong> ${quantity}</p>
    <p><strong>Total Amount:</strong> ${(totalAmount/100).toFixed(2)} ${currency.toUpperCase()}</p>
  </div>

  <div class="shipping-info">
    <h2>Shipping Information</h2>
    <p><strong>Shipping Address:</strong><br>
    ${finalCustomerName}<br>
    ${shippingAddress.line1}${shippingAddress.line2 ? '<br>' + shippingAddress.line2 : ''}<br>
    ${shippingAddress.city}, ${shippingAddress.state || ''} ${shippingAddress.postal_code}<br>
    ${shippingAddress.country}
    </p>
    
    <p><strong>Contact:</strong><br>
    Email: ${customerEmail}<br>
    Phone: ${customerPhone || 'Not provided'}
    </p>
  </div>
`;

          if (trackingId) {
            textContent += `Tracking Number: ${trackingId}\n`;
            textContent += `You can track your shipment using this tracking number on the Aramex website.\n`;
            
            htmlContent += `
  <div class="tracking-info">
    <h2>Tracking Information</h2>
    <p><span class="status-badge">Shipped</span></p>
    <p><strong>Tracking Number:</strong> ${trackingId}</p>
    <p>You can track your shipment using this tracking number on the <a href="https://www.aramex.com">Aramex website</a>.</p>
  </div>`;
          } else if (aramexError) {
            textContent += `Shipping Status: Processing (Note: ${aramexError})\n`;
            textContent += `We will notify you with tracking information once your shipment is processed.\n`;
            
            htmlContent += `
  <div class="tracking-info">
    <h2>Shipping Status</h2>
    <p><span class="status-badge">Processing</span></p>
    <p>We will notify you with tracking information once your shipment is processed.</p>
    <p><em>Note: ${aramexError}</em></p>
  </div>`;
          } else {
            textContent += `Shipping Status: Processing\n`;
            textContent += `We will notify you with tracking information once your shipment is processed.\n`;
            
            htmlContent += `
  <div class="tracking-info">
    <h2>Shipping Status</h2>
    <p><span class="status-badge">Processing</span></p>
    <p>We will notify you with tracking information once your shipment is processed.</p>
  </div>`;
          }

          // Add shipping label link if available
          if (labelUrl) {
            textContent += `Shipping Label: ${labelUrl}\n`;
            
            htmlContent += `
  <div class="shipping-label">
    <h2>Shipping Label</h2>
    <p>Click <a href="${labelUrl}" target="_blank">here</a> to view and download your shipping label.</p>
  </div>`;
          }

          textContent += `
Thank you for choosing AXIS AUTO!

If you have any questions about your order, please contact us at ${process.env.MAIL_FROM}.

Best regards,
The AXIS AUTO Team
------------------
AXIS AUTO. TECHNICAL TESTING
`;

          htmlContent += `
  <div class="footer">
    <p>Thank you for choosing <strong>AXIS AUTO</strong>!</p>
    <p>If you have any questions about your order, please contact us at <a href="mailto:${process.env.MAIL_FROM}">${process.env.MAIL_FROM}</a>.</p>
    <p>Best regards,<br>The AXIS AUTO Team</p>
    <p><em>AXIS AUTO. TECHNICAL TESTING</em></p>
  </div>
</body>
</html>`;

          const msg = {
            to: customerEmail,
            from: process.env.MAIL_FROM,
            subject: `Order Confirmation #${session.id} - AXIS AUTO`,
            text: textContent,
            html: htmlContent,
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

      // finished successfully for this event
      return res.status(200).send("OK");
    } catch (err) {
      console.error("❌ Processing error in webhook:", err && err.message ? err.message : err);
      return res.status(500).send("Webhook processing error");
    }
  }

  // For all other events, return OK
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
