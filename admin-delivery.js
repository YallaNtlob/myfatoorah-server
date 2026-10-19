'use strict';

// لوحة خاصة بطلبات MyFatoorah - لا تتصل بعملية الدفع أو تعدّل أسعار الطلب.
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const PREFIX = '/admin-delivery';
const API_VERSION = '2025-01'; // نفس الإصدار الموجود في server.js الحالي
const STAGES = Object.freeze({
  preparing: 'YN_STAGE_PREPARING',
  out: 'YN_STAGE_OUT_FOR_DELIVERY',
  delivered: 'YN_STAGE_DELIVERED'
});
const SENDING = Object.freeze({out: 'YN_SENDING_OUT', delivered: 'YN_SENDING_DELIVERED'});
const SENT = Object.freeze({out: 'YN_SENT_OUT', delivered: 'YN_SENT_DELIVERED'});
const ALL_MANAGED = [...Object.values(STAGES), ...Object.values(SENDING), ...Object.values(SENT)];
const locks = new Set();
const loginAttempts = new Map();

const escapeHtml = (val) => String(val ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

function secureEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function tagsOf(order) {
  return String(order.tags || '').split(',').map(x => x.trim()).filter(Boolean);
}
function stageOf(order) {
  const tags = tagsOf(order);
  if (tags.includes(STAGES.delivered)) return 'delivered';
  if (tags.includes(STAGES.out)) return 'out';
  if (tags.includes(STAGES.preparing)) return 'preparing';
  return 'new';
}
function withTags(order, changes = {}) {
  const tags = tagsOf(order).filter(t => !ALL_MANAGED.includes(t));
  if (changes.stage) tags.push(STAGES[changes.stage]);
  for (const kind of ['out', 'delivered']) {
    if (changes.sent?.includes(kind) || tagsOf(order).includes(SENT[kind])) tags.push(SENT[kind]);
    if (changes.sending === kind || (changes.sending === undefined && tagsOf(order).includes(SENDING[kind]))) tags.push(SENDING[kind]);
  }
  if (changes.clearSending) {
    return tags.filter(t => !Object.values(SENDING).includes(t)).join(', ');
  }
  return [...new Set(tags)].join(', ');
}
function shopify() {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_TOKEN;
  if (!store || !token) throw new Error('Shopify settings missing');
  if (!/^[a-z0-9][a-z0-9.-]+$/i.test(store)) throw new Error('Invalid Shopify host');
  return axios.create({
    baseURL: `https://${store}/admin/api/${API_VERSION}`,
    headers: {'X-Shopify-Access-Token': token, 'Content-Type': 'application/json'},
    timeout: 15000
  });
}
function getCustomerEmail(order) {
  const directEmail = order.email || order.customer?.email;

  if (directEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(directEmail)) {
    return directEmail.trim();
  }

  const note = String(order.note || '');

  const match = note.match(
    /(?:الإيميل|البريد الإلكتروني)\s*[:：]\s*([^\s<>]+@[^\s<>]+\.[^\s<>]+)/i
  );

  return match ? match[1].trim() : '';
}
function safeOrder(order) {
  const email = getCustomerEmail(order);
  return {
    id: String(order.id),
    number: order.name,
    name: order.shipping_address?.name || order.billing_address?.name || order.customer?.first_name || 'زبون',
    email,
    createdAt: order.created_at,
    stage: stageOf(order),
    sentOut: tagsOf(order).includes(SENT.out),
    sentDelivered: tagsOf(order).includes(SENT.delivered),
    needsReview: Object.values(SENDING).some(t => tagsOf(order).includes(t))
  };
}
async function getOrder(id) {
  const {data} = await shopify().get(`/orders/${id}.json`);
  const order = data.order;
  if (!order || !tagsOf(order).includes('MyFatoorah')) throw new Error('الطلب غير موجود ضمن طلبات MyFatoorah');
  return order;
}
async function saveTags(id, tags) {
  const {data} = await shopify().put(`/orders/${id}.json`, {order: {id: Number(id), tags}});
  return data.order;
}
function transport() {
  const {SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS} = process.env;
  if (![SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS].every(Boolean)) throw new Error('SMTP configuration missing');
  return nodemailer.createTransport({
    host: SMTP_HOST, port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: {user: SMTP_USER, pass: SMTP_PASS},
    connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 20000
  });
}
function deliveryEmail(order, kind) {
  const orderName = escapeHtml(order.name || `#${order.order_number || ''}`);
  const customer = escapeHtml(order.shipping_address?.first_name || order.billing_address?.first_name || order.customer?.first_name || '');
  const heading = kind === 'out' ? '🚚 طلبك الآن في الطريق!' : '🎉 تم توصيل طلبك بنجاح!';
  const message = kind === 'out'
    ? `يسعدنا إبلاغك بأن طلبك <b>${orderName}</b> أصبح مع مندوب التوصيل، وهو الآن في الطريق. 🚚<br><br>يرجى إبقاء الهاتف قريبًا، فقد يتواصل المندوب عند الوصول.`
    : `يسعدنا تأكيد توصيل طلبك <b>${orderName}</b> بنجاح. ✅<br><br>نتمنى أن تكون تجربتك مع <b>Yalla Ntlob</b> قد نالت رضاك، وأن تستمتع بطلبك. ❤️`;
  const items = (order.line_items || []).map(item =>
    `<tr><td style="padding:10px;border-bottom:1px solid #eee">${escapeHtml(item.title)}</td><td style="padding:10px;border-bottom:1px solid #eee">${Number(item.quantity) || 1}</td></tr>`
  ).join('');
  const subject = kind === 'out'
    ? `🚚 طلبك ${order.name || ''} من Yalla Ntlob صار بالطريق!`
    : `🎉 تم توصيل طلبك ${order.name || ''} من Yalla Ntlob بنجاح!`;
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"></head>
  <body style="margin:0;background:#f5f7fb;font-family:Arial,sans-serif;color:#263241">
  <div style="max-width:640px;margin:25px auto;padding:28px;background:#fff;border-radius:12px">
  <h2 style="text-align:center;color:#1568b6">Yalla Ntlob</h2><h2>${heading}</h2>
  <p>مرحبًا${customer ? ' ' + customer : ''} 👋</p>
  <p style="font-size:16px;line-height:2">${message}</p>
  <h3>تفاصيل المنتجات</h3><table style="width:100%;border-collapse:collapse"><tr><th style="text-align:right;padding:10px">المنتج</th><th style="text-align:right;padding:10px">الكمية</th></tr>${items}</table>
  <p style="line-height:1.9">شكرًا لاختيارك Yalla Ntlob ❤️<br>فريق Yalla Ntlob</p>
  <p style="font-size:13px;color:#697586;border-top:1px solid #eee;padding-top:15px">للمساعدة: <a href="mailto:support@yallantlob.com">support@yallantlob.com</a></p>
  </div></body></html>`;
  return {subject, html};
}
const DASHBOARD = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Yalla Ntlob | إدارة التوصيل</title><style>
body{font-family:system-ui,Arial;background:#f5f7fb;color:#172333;margin:0}header{background:#155b9e;color:white;padding:19px 5%}main{max-width:1000px;margin:24px auto;padding:0 16px}h1{font-size:22px;margin:0}.hint{color:#5d687a}.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px}input{font:inherit;padding:12px;border:1px solid #b9c5d3;border-radius:8px;min-width:230px}button{font:inherit;cursor:pointer;border:0;border-radius:9px;background:#1463a8;color:white;padding:11px 14px;margin:4px}button:disabled{background:#b9c5d3;cursor:not-allowed}.card{background:white;padding:20px;border-radius:14px;box-shadow:0 3px 16px #dde4ee;margin:15px 0}.muted{color:#657184;font-size:14px}.state{font-weight:700}.error{color:#a12323}.ok{color:#187145}
</style></head><body><header><h1>🚚 Yalla Ntlob — إدارة التوصيل</h1></header><main><p class="hint">للطلبات المدفوعة من MyFatoorah فقط. كل ضغطة على زر الإرسال تبعث بريدًا حقيقيًا للزبون.</p>
<div class="toolbar"><input id="search" placeholder="ابحثي برقم الطلب أو الاسم"><button id="reload">تحديث الطلبات</button></div><div id="message" role="status"></div><div id="orders"></div></main>
<script>
const labels={new:'طلب جديد',preparing:'جاري التجهيز',out:'خرج للتوصيل',delivered:'تم التوصيل'};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let orders=[];
async function load(){document.getElementById('message').textContent='جاري تحميل الطلبات...';try{
const r=await fetch('/admin-delivery/orders',{cache:'no-store'});const data=await r.json();if(!r.ok)throw Error(data.error||'فشل التحميل');orders=data.orders||[];render();document.getElementById('message').textContent='';
}catch(e){document.getElementById('message').textContent=e.message;}}
function render(){let q=document.getElementById('search').value.trim().toLowerCase();let shown=orders.filter(x=>(x.number+' '+x.name+' '+x.email).toLowerCase().includes(q));
document.getElementById('orders').innerHTML=shown.map(o=>{
const next=o.stage==='new'?'preparing':o.stage==='preparing'?'out':o.stage==='out'?'delivered':null;
return '<section class="card"><h2>'+esc(o.number)+'</h2><p>'+esc(o.name)+' — '+esc(o.email)+'</p><p class="state">الحالة: '+labels[o.stage]+'</p>'+
(o.sentOut?'<p class="ok">✓ تم إرسال إشعار الخروج للتوصيل</p>':'')+(o.sentDelivered?'<p class="ok">✓ تم إرسال إشعار التسليم</p>':'')+
(o.needsReview?'<p class="error">⚠️ إرسال غير محسوم. تواصلي مع الدعم قبل إعادة المحاولة.</p>':'')+
'<div><button data-id="'+esc(o.id)+'" data-stage="preparing" '+(next!=='preparing'||o.needsReview?'disabled':'')+'>🛍️ جاري التجهيز</button>'+
'<button data-id="'+esc(o.id)+'" data-stage="out" '+(next!=='out'||o.needsReview?'disabled':'')+'>🚚 خرج للتوصيل وإرسال الإيميل</button>'+
'<button data-id="'+esc(o.id)+'" data-stage="delivered" '+(next!=='delivered'||o.needsReview?'disabled':'')+'>✅ تم التوصيل وإرسال الإيميل</button></div></section>';
}).join('')||'<p>ما في طلبات مطابقة ضمن آخر 50 طلب.</p>';}
document.getElementById('orders').addEventListener('click',async e=>{const btn=e.target.closest('button[data-id]');if(!btn||btn.disabled)return;
const stage=btn.dataset.stage,id=btn.dataset.id,order=orders.find(x=>x.id===id);
const text=stage==='preparing'?'تسجيل بدء تجهيز الطلب؟':stage==='out'?'إرسال رسالة خرج للتوصيل إلى '+order.email+'؟':'تأكيد تسليم الطلب وإرسال رسالة تم التوصيل إلى '+order.email+'؟';
if(!confirm(text))return;btn.disabled=true;document.getElementById('message').textContent='جاري تحديث الطلب...';
try{const r=await fetch('/admin-delivery/orders/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stage})});const data=await r.json();if(!r.ok)throw Error(data.error||'فشل التحديث');await load();document.getElementById('message').textContent='✅ تم تحديث الطلب'+(stage!=='preparing'?' وإرسال الإيميل':'');}
catch(e){document.getElementById('message').textContent='⚠️ '+e.message;btn.disabled=false;}});
document.getElementById('search').addEventListener('input',render);document.getElementById('reload').addEventListener('click',load);load();
</script></body></html>`;

function registerAdminDelivery(app) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) {
      return res.status(503).send('حددي كلمة مرور ADMIN_PASSWORD من 12 خانة أو أكثر داخل Render.');
    }
    const ip = req.ip || req.socket.remoteAddress;
    const entry = loginAttempts.get(ip) || {count:0,until:0};
    if (entry.until > Date.now()) return res.status(429).send('محاولات كثيرة. حاولي بعد 15 دقيقة.');
    const value = req.get('authorization') || '';
    let credentials = '';
    if (value.startsWith('Basic ')) {
      try { credentials = Buffer.from(value.slice(6), 'base64').toString('utf8'); } catch (_) {}
    }
    const pos = credentials.indexOf(':');
    const user = pos < 0 ? '' : credentials.slice(0,pos);
    const password = pos < 0 ? '' : credentials.slice(pos+1);
    if (!secureEqual(user, 'admin') || !secureEqual(password, process.env.ADMIN_PASSWORD)) {
      entry.count += 1;
      if (entry.count >= 10) {entry.until = Date.now() + 15 * 60 * 1000;entry.count=0;}
      loginAttempts.set(ip,entry);
      res.set('WWW-Authenticate', 'Basic realm="Yalla Ntlob Delivery", charset="UTF-8"');
      return res.status(401).send('يلزم تسجيل الدخول');
    }
    loginAttempts.delete(ip);
    if (req.method !== 'GET') {
      const origin = req.get('origin');
      const expected = `https://${req.get('host')}`;
      if (origin !== expected || !String(req.get('content-type')||'').startsWith('application/json')) {
        return res.status(403).json({error:'طلب غير مسموح'});
      }
    }
    next();
  });

  router.get('/', (_req, res) => res.type('html').send(DASHBOARD));
  router.get('/orders', async (_req, res) => {
    try {
      const {data} = await shopify().get('/orders.json', {params:{status:'any', limit:50}});
      const orders = (data.orders || []).filter(o => tagsOf(o).includes('MyFatoorah')).map(safeOrder);
      res.json({orders});
    } catch (err) {
      console.error('DELIVERY ORDERS LIST:', err.response?.status || err.message);
      res.status(502).json({error:'تعذر قراءة الطلبات من Shopify. تأكدي من صلاحية read_orders.'});
    }
  });
  router.post('/orders/:id/status', express.json(), async (req, res) => {
    const id = String(req.params.id);
    const stage = req.body?.stage;
    if (!/^\d{5,20}$/.test(id) || !Object.keys(STAGES).includes(stage)) return res.status(400).json({error:'بيانات غير صحيحة'});
    if (locks.has(id)) return res.status(409).json({error:'هناك عملية تحديث جارية لهذا الطلب'});
    locks.add(id);
    try {
      let order = await getOrder(id);
      const old = stageOf(order);
      const next = {new:'preparing', preparing:'out', out:'delivered', delivered:null}[old];
      if (stage !== next) return res.status(409).json({error:'يجب تحديث المراحل بالترتيب، ولا يمكن إرسال الإشعار مرتين'});
      if (Object.values(SENDING).some(t => tagsOf(order).includes(t))) {
        return res.status(409).json({error:'هناك إشعار غير محسوم. لا تعيدي الإرسال قبل المراجعة.'});
      }
      if (stage === 'preparing') {
        await saveTags(id, withTags(order, {stage}));
        return res.json({ok:true});
      }
      if (!getCustomerEmail(order)) return res.status(400).json({error:'الطلب لا يحتوي على بريد الزبون'});
      if (tagsOf(order).includes(SENT[stage])) return res.status(409).json({error:'تم إرسال هذه الرسالة مسبقًا'});
      // نسجل وضع "قيد الإرسال" أولًا؛ في حال انقطاع السيرفر لا يتم إعادة الإرسال دون مراجعة.
      order = await saveTags(id, withTags(order, {stage:old==='new'? 'preparing':old, sending:stage}));
      const email = deliveryEmail(order, stage);
      const to = getCustomerEmail(order);
      try {
        await transport().sendMail({
          from: {name:'Yalla Ntlob', address: process.env.SMTP_FROM || process.env.SMTP_USER},
          to, subject: email.subject, html:email.html
        });
      } catch(err) {
        console.error('DELIVERY EMAIL FAILURE:', err.code || err.message);
        // نترك علامة "قيد الإرسال" لتجنب أي تكرار عند فشل غير محسوم.
        return res.status(502).json({error:'تعذر تأكيد إرسال الإيميل. توقّف الإرسال الاحترازي؛ راجعي بريد Zoho والسجلات قبل أي إعادة.'});
      }
      await saveTags(id, withTags(order, {stage, sent:[stage], clearSending:true}));
      return res.json({ok:true});
    } catch(err) {
      console.error('DELIVERY STATUS ERROR:', err.response?.status || err.message);
      return res.status(502).json({error:'تعذر تحديث الطلب. تأكدي من صلاحيات Shopify وسجلات Render.'});
    } finally { locks.delete(id); }
  });
  app.use(PREFIX, router);
}

module.exports = {registerAdminDelivery};
