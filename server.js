require('dotenv').config();

const path = require('path');
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://myfatoorah-server.onrender.com';

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const MYFATOORAH_API_KEY = process.env.MYFATOORAH_API_KEY;

const pendingOrders = new Map();
const createdOrders = new Set();

function safeText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function safeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function formatMoney(value) {
  return safeNumber(value, 0).toFixed(2);
}

app.get('/', (req, res) => {
  res.redirect('/checkout');
});

app.get('/checkout', (req, res) => {
  res.sendFile(path.join(__dirname, 'checkout.html'));
});

/* =========================
   Shopify Discount
========================= */

async function getShopifyDiscount(code) {
  if (!code) return null;

  const query = `
    query DiscountByCode($code: String!) {
      codeDiscountNodeByCode(code: $code) {
        codeDiscount {
          __typename
          ... on DiscountCodeBasic {
            title
            status
            customerGets {
              value {
                __typename
                ... on DiscountPercentage {
                  percentage
                }
                ... on DiscountAmount {
                  amount {
                    amount
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await axios.post(
    `https://${SHOPIFY_STORE}/admin/api/2025-01/graphql.json`,
    { query, variables: { code } },
    {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data?.data?.codeDiscountNodeByCode?.codeDiscount || null;
}

function applyDiscountToAmount(amount, discount) {
  if (!discount || discount.status !== 'ACTIVE') {
    return { finalAmount: amount, discountAmount: 0 };
  }

  const value = discount.customerGets?.value;
  let discountAmount = 0;

  if (value?.__typename === 'DiscountPercentage') {
    const percentage = Number(value.percentage);
    const rate = percentage > 1 ? percentage / 100 : percentage;
    discountAmount = amount * rate;
  }

  if (value?.__typename === 'DiscountAmount') {
    discountAmount = Number(value.amount?.amount || 0);
  }

  const finalAmount = Math.max(amount - discountAmount, 0);

  return {
    finalAmount: Number(finalAmount.toFixed(2)),
    discountAmount: Number(discountAmount.toFixed(2))
  };
}

/* =========================
   Create Shopify Order
========================= */

async function createShopifyOrder(data) {
  const safeRecipientName = safeText(data.customerName, 'Customer');
  const safeRecipientPhone = safeText(data.customerPhone, '');
  const safeRecipientAddress = safeText(data.customerAddress, 'عنوان غير محدد');
  const safeRecipientCity = safeText(data.customerCity, 'غير محدد');

  const safeBillingName = safeText(data.billingName, safeRecipientName);
  const safeBillingPhone = safeText(data.billingPhone, safeRecipientPhone);
  const safeBillingEmail = safeText(data.customerEmail, '');
  const safeBillingCountry = safeText(data.customerCountry, '');

  const shippingUsd = formatMoney(data.shippingUsd);
  const shippingAed = formatMoney(data.shippingAed);
  const finalAmount = formatMoney(data.amount);

  const discountCode = data.appliedDiscount?.code || data.discountCode || '';
  const discountAmount = formatMoney(data.appliedDiscount?.discountAmount || data.discountAmount || 0);
  const originalAmount = formatMoney(data.appliedDiscount?.originalAmount || data.originalAmount || data.amount);

  const lineItems = (data.cartItems || [])
    .map((item) => {
      const variantId = item.variant_id || item.id;
      if (!variantId) return null;

      return {
        variant_id: variantId,
        quantity: Number(item.quantity || 1)
      };
    })
    .filter(Boolean);

  if (!lineItems.length) {
    throw new Error('No valid Shopify variant IDs found');
  }

  const orderPayload = {
    order: {
      line_items: lineItems,
      financial_status: 'paid',
      send_receipt: true,
      tags: discountCode
        ? `MyFatoorah, External Checkout, Discount: ${discountCode}`
        : 'MyFatoorah, External Checkout',

      email: safeBillingEmail || undefined,

      note: `Paid via MyFatoorah

📦 معلومات المستلم:
الاسم: ${safeRecipientName}
الهاتف: ${safeRecipientPhone || '-'}
العنوان: ${safeRecipientAddress}
المنطقة: ${safeRecipientCity}

🧾 معلومات صاحب الطلب:
الاسم: ${safeBillingName}
الهاتف: ${safeBillingPhone || '-'}
الإيميل: ${safeBillingEmail || '-'}
البلد: ${safeBillingCountry || '-'}

💰 تفاصيل الطلب:
الإجمالي قبل الخصم: ${originalAmount} د.إ
كود الخصم: ${discountCode || '-'}
قيمة الخصم: ${discountAmount} د.إ
الشحن: ${shippingAed} د.إ (${shippingUsd} $)
الإجمالي النهائي: ${finalAmount} د.إ
طريقة الدفع: MyFatoorah`,

      note_attributes: [
        { name: 'اسم المستلم', value: safeRecipientName },
        { name: 'هاتف المستلم', value: safeRecipientPhone },
        { name: 'عنوان المستلم', value: safeRecipientAddress },
        { name: 'المنطقة', value: safeRecipientCity },
        { name: 'اسم صاحب الطلب', value: safeBillingName },
        { name: 'هاتف صاحب الطلب', value: safeBillingPhone },
        { name: 'الإيميل', value: safeBillingEmail },
        { name: 'البلد', value: safeBillingCountry },
        { name: 'الشحن بالدولار', value: shippingUsd },
        { name: 'الشحن بالدرهم', value: shippingAed },
        { name: 'الإجمالي قبل الخصم', value: originalAmount },
        { name: 'كود الخصم', value: discountCode || '-' },
        { name: 'قيمة الخصم', value: discountAmount },
        { name: 'الإجمالي النهائي', value: finalAmount },
        { name: 'الدفع', value: 'MyFatoorah' }
      ]
    }
  };

  const response = await axios.post(
    `https://${SHOPIFY_STORE}/admin/api/2025-01/orders.json`,
    orderPayload,
    {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data;
}

/* =========================
   Discount Endpoint
========================= */

app.post('/check-discount', async (req, res) => {
  try {
    console.log('CHECK DISCOUNT:', req.body);

    const { amount, discountCode } = req.body;

    if (!discountCode) {
      return res.json({ valid: false, message: 'ما في كود خصم' });
    }

    const discount = await getShopifyDiscount(discountCode);

    if (!discount || discount.status !== 'ACTIVE') {
      return res.json({ valid: false, message: 'كود غير صالح' });
    }

    const result = applyDiscountToAmount(amount, discount);

    console.log('DISCOUNT RESULT:', result);

    return res.json({
      valid: true,
      discountAmount: result.discountAmount,
      finalAmount: result.finalAmount
    });
  } catch (err) {
    console.error('DISCOUNT ERROR:', err.response?.data || err.message);
    res.status(500).json({ error: 'server error' });
  }
});

/* =========================
   Create Payment
========================= */

app.post('/create-payment', async (req, res) => {
  try {
    if (!MYFATOORAH_API_KEY) {
      return res.status(500).json({ error: 'Missing MyFatoorah API key' });
    }

    const data = req.body;
    const amount = safeNumber(data.amount);

    console.log('AMOUNT RECEIVED FOR PAYMENT:', amount);
    console.log('FULL DATA:', data);
    console.log('DISCOUNT CODE RECEIVED:', data.discountCode);

    if (data.discountCode) {
      data.appliedDiscount = {
        code: data.discountCode,
        discountAmount: safeNumber(data.discountAmount, 0),
        originalAmount: safeNumber(data.originalAmount, amount),
        finalAmount: amount
      };
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const localOrderId = Date.now().toString();
    pendingOrders.set(localOrderId, data);
    console.log('Local pending order saved:', localOrderId);

    const payload = {
      InvoiceValue: amount,
      CustomerName: safeText(data.customerName, 'Customer'),
      NotificationOption: 'LNK',
      CustomerEmail: safeText(data.customerEmail, 'test@test.com'),
      DisplayCurrencyIso: 'AED',
      CallBackUrl: `${PUBLIC_BASE_URL}/success?orderId=${localOrderId}`,
      ErrorUrl: `${PUBLIC_BASE_URL}/error`,
      Language: 'AR'
    };

    const response = await axios.post(
      'https://api-ae.myfatoorah.com/v2/SendPayment',
      payload,
      {
        headers: {
          Authorization: `Bearer ${MYFATOORAH_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const invoiceId = response.data?.Data?.InvoiceId;

    if (invoiceId) {
      pendingOrders.set(String(invoiceId), data);
      console.log('Pending order saved:', invoiceId);
    }

    res.json(response.data);
  } catch (error) {
    console.log('MYFATOORAH ERROR:', error.response?.data || error.message);

    res.status(500).json({
      error: 'Payment error',
      details: error.response?.data || error.message
    });
  }
});

/* =========================
   MyFatoorah Webhook
========================= */

app.post('/webhook', async (req, res) => {
  try {
    console.log('WEBHOOK RECEIVED:', req.body);

    const invoiceId = req.body?.Data?.InvoiceId;
    const status = req.body?.Data?.TransactionStatus || req.body?.Data?.InvoiceStatus || '';

    const pending = pendingOrders.get(String(invoiceId));

    if (!pending) {
      console.log('No pending order found for webhook invoice:', invoiceId);
      return res.sendStatus(200);
    }

    if (createdOrders.has(String(invoiceId)) || pending._shopifyCreated) {
      console.log('Order already created:', invoiceId);
      return res.sendStatus(200);
    }

    if (status.toLowerCase().includes('success') || status.toLowerCase().includes('paid')) {
      await createShopifyOrder(pending);
      pending._shopifyCreated = true;
      createdOrders.add(String(invoiceId));
      pendingOrders.delete(String(invoiceId));
      console.log('Shopify order created from webhook:', invoiceId);
    }

    res.sendStatus(200);
  } catch (error) {
    console.log('WEBHOOK ERROR:', error.response?.data || error.message);
    res.sendStatus(200);
  }
});

/* =========================
   Result Pages
========================= */

app.get('/success', async (req, res) => {
  try {
    console.log('=== SUCCESS PAGE CALLED ===');
    console.log('SUCCESS QUERY:', req.query);

    const orderId = req.query.orderId;
    const pending = pendingOrders.get(String(orderId));

    if (pending) {
      if (!createdOrders.has(String(orderId)) && !pending._shopifyCreated) {
        await createShopifyOrder(pending);
        pending._shopifyCreated = true;
        createdOrders.add(String(orderId));
        pendingOrders.delete(String(orderId));
        console.log('Shopify order created from success orderId:', orderId);
      } else {
        console.log('Order already created from success orderId:', orderId);
      }
    } else {
      console.log('No pending order found for orderId:', orderId);
    }

    res.send(`
      <html dir="rtl" lang="ar">
        <body style="font-family:Arial;text-align:center;padding:60px;background:#f6f8fb">
          <h1 style="color:#1e7a3d">تم الدفع بنجاح ✅</h1>
          <p>شكرًا لك، تم استلام عملية الدفع.</p>
          <a href="https://${SHOPIFY_STORE}" style="color:#123a7d">العودة إلى المتجر</a>
        </body>
      </html>
    `);
  } catch (error) {
    console.log('SUCCESS ERROR:', error.response?.data || error.message);
    res.send('تم الدفع، لكن حدث خطأ في إنشاء الطلب');
  }
});

app.get('/error', (req, res) => {
  res.send(`
    <html dir="rtl" lang="ar">
      <body style="font-family:Arial;text-align:center;padding:60px;background:#f6f8fb">
        <h1 style="color:#b42318">فشل الدفع ❌</h1>
        <p>لم تكتمل عملية الدفع. الرجاء المحاولة مرة أخرى.</p>
        <a href="/checkout" style="color:#123a7d">العودة إلى صفحة الدفع</a>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Checkout URL: ${PUBLIC_BASE_URL}/checkout`);
});
