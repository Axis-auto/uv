// server.js
const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');
const bodyParser = require('body-parser');
const sgMail = require('@sendgrid/mail');
const soap = require('soap');

const app = express();
app.use(cors({ origin: true }));
app.use(bodyParser.json());

// Stripe
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Aramex SOAP WSDL
const ARAMEX_WSDL = "https://ws.sbx.aramex.net/shippingapi.v2/shipping/service_1_0.svc?wsdl";

// Root
app.get('/', (req, res) => {
  res.send('Server is running...');
});

// ✅ Create checkout session
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, customer_email, customer_name, customer_phone } = req.body;

    const line_items = items.map((item) => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
        },
        unit_amount: item.price * 100,
      },
      quantity: item.quantity,
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      customer_email,
      shipping_address_collection: {
        // السماح بكل الدول (لا يوجد أي اختصار)
        allowed_countries: [
          'US', 'AE', 'SA', 'JO', 'KW', 'OM', 'BH', 'QA', 'EG', 'LB', 'TR',
          'DE', 'FR', 'GB', 'IT', 'ES', 'NL', 'BE', 'CN', 'IN', 'PK', 'BD',
          'MA', 'DZ', 'TN', 'SD', 'IQ', 'SY', 'YE', 'IR', 'RU', 'UA', 'PL',
          'SE', 'NO', 'FI', 'DK', 'CH', 'AT', 'GR', 'PT', 'HU', 'CZ', 'RO',
          'BG', 'SK', 'HR', 'SI', 'LT', 'LV', 'EE', 'BR', 'AR', 'MX', 'CA',
          'AU', 'NZ', 'SG', 'MY', 'TH', 'VN', 'PH', 'KR', 'JP', 'ZA', 'NG',
          'KE', 'ET', 'GH', 'CI'
        ]
      },
      phone_number_collection: {
        enabled: true,
      },
      success_url: `${process.env.CLIENT_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/cancel`,
      metadata: {
        customer_name,
        customer_phone,
      },
    });

    res.json({ id: session.id });
  } catch (error) {
    console.error('Stripe Session Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Stripe webhook to trigger Aramex
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // ✅ بيانات الشحن من Stripe
    const shipping = session.shipping_details;

    // ✅ تكوين الطلب لـ Aramex
    const shipment = {
      Shipments: [
        {
          Shipper: {
            Reference1: process.env.SHIPPER_REFERENCE,
            AccountNumber: process.env.ARAMEX_ACCOUNT_NUMBER,
            PartyAddress: {
              Line1: process.env.SHIPPER_LINE1,
              City: process.env.SHIPPER_CITY,
              CountryCode: process.env.SHIPPER_COUNTRY_CODE,
              PostCode: process.env.SHIPPER_POST_CODE,
            },
            Contact: {
              PersonName: process.env.SHIPPER_NAME,
              CompanyName: process.env.SHIPPER_NAME,
              PhoneNumber1: process.env.SHIPPER_PHONE,
              PhoneNumber2: "", // مطلوب من Aramex
              CellPhone: process.env.SHIPPER_PHONE,
              EmailAddress: process.env.SHIPPER_EMAIL,
              Type: "Sender" // مطلوب من Aramex
            }
          },
          Consignee: {
            Reference1: "ConsigneeRef",
            PartyAddress: {
              Line1: shipping.address.line1,
              City: shipping.address.city,
              CountryCode: shipping.address.country,
              PostCode: shipping.address.postal_code,
            },
            Contact: {
              PersonName: session.metadata.customer_name,
              CompanyName: session.metadata.customer_name,
              PhoneNumber1: session.metadata.customer_phone,
              PhoneNumber2: "", // مطلوب من Aramex
              CellPhone: session.metadata.customer_phone,
              EmailAddress: session.customer_email,
              Type: "Receiver" // مطلوب من Aramex
            }
          },
          Details: {
            Dimensions: { Length: 10, Width: 10, Height: 10, Unit: "cm" },
            ActualWeight: { Value: 0.5, Unit: "kg" },
            DescriptionOfGoods: "Order shipment",
            GoodsOriginCountry: process.env.SHIPPER_COUNTRY_CODE,
            NumberOfPieces: 1,
          }
        }
      ],
      ClientInfo: {
        AccountCountryCode: process.env.SHIPPER_COUNTRY_CODE,
        AccountEntity: process.env.ARAMEX_ACCOUNT_ENTITY,
        AccountNumber: process.env.ARAMEX_ACCOUNT_NUMBER,
        AccountPin: process.env.ARAMEX_ACCOUNT_PIN,
        UserName: process.env.ARAMEX_USERNAME,
        Password: process.env.ARAMEX_PASSWORD,
        Version: "v1",
      },
      Transaction: { Reference1: "OrderShipment" }
    };

    // ✅ استدعاء SOAP
    soap.createClient(ARAMEX_WSDL, (err, client) => {
      if (err) {
        console.error('SOAP Client Error:', err);
        return;
      }
      client.CreateShipments(shipment, (err, result) => {
        if (err) {
          console.error('Aramex Error:', err);
        } else {
          console.log('Aramex Response:', result);
        }
      });
    });
  }

  res.json({ received: true });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
