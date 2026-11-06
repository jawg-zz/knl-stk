'use strict';
// Daraja STK push backend — plain node:http, zero npm deps.
// Secrets come from process.env at runtime only; never logged.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function env(name, fallback) {
  let v = process.env[name];
  if (typeof v === 'string') v = v.trim();
  return (v === undefined || v === '') ? fallback : v;
}

function isConfigured() {
  return Boolean(
    process.env.MPESA_CONSUMER_KEY &&
    process.env.MPESA_CONSUMER_SECRET &&
    process.env.MPESA_PASSKEY &&
    process.env.MPESA_SHORTCODE
  );
}

function baseUrl() {
  const e = env('MPESA_ENV', 'sandbox');
  return e === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
}

function nairobiTimestamp() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return get('year') + get('month') + get('day') + get('hour') + get('minute') + get('second');
}

// ---- OAuth token cache (in-memory) ----
let cachedToken = null;
let cachedExpiry = 0;

function fetchToken() {
  return new Promise((resolve, reject) => {
    const key = process.env.MPESA_CONSUMER_KEY;
    const secret = process.env.MPESA_CONSUMER_SECRET;
    const auth = Buffer.from(key + ':' + secret).toString('base64');
    const url = baseUrl() + '/oauth/v1/generate?grant_type=client_credentials';
    const req = https.request(url, {
      method: 'GET',
      headers: { Authorization: 'Basic ' + auth }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.access_token) {
            reject(new Error('oauth_failed:' + res.statusCode));
            return;
          }
          const ttl = Number(json.expires_in) || 3599;
          cachedToken = json.access_token;
          cachedExpiry = Date.now() + Math.max(0, (ttl - 60)) * 1000;
          resolve(cachedToken);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function getToken() {
  if (cachedToken && Date.now() < cachedExpiry) return Promise.resolve(cachedToken);
  return fetchToken();
}

function stkPush(phone, amount, token) {
  return new Promise((resolve, reject) => {
    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
    const ts = nairobiTimestamp();
    const password = Buffer.from(shortcode + passkey + ts).toString('base64');
    const publicUrl = env('PUBLIC_URL', '');
    const payload = JSON.stringify({
      BusinessShortCode: Number(shortcode),
      Password: password,
      Timestamp: ts,
      TransactionType: env('MPESA_TYPE', 'CustomerPayBillOnline'),
      Amount: Math.round(amount),
      PartyA: phone,
      PartyB: shortcode,
      PhoneNumber: phone,
      CallBackURL: publicUrl + '/api/pay/callback',
      AccountReference: 'KNL-SUPPORT',
      TransactionDesc: 'KNL Support'
    });
    const url = baseUrl() + '/mpesa/stkpush/v1/processrequest';
    const req = https.request(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---- helpers ----
function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { resolve(null); }
    });
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function withCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

// ---- routes ----
async function handlePay(req, res) {
  const body = await readJson(req);
  if (!body) return send(res, 400, { error: 'Invalid JSON body' });
  const phone = String(body.phone || '').trim();
  const amount = Number(body.amount);
  if (!/^254[17]\d{8}$/.test(phone)) {
    return send(res, 400, { error: 'Invalid phone. Use 2547XXXXXXXX / 2541XXXXXXXX format.' });
  }
  if (!Number.isFinite(amount) || amount < 10) {
    return send(res, 400, { error: 'Invalid amount. Minimum is KES 10.' });
  }
  if (!isConfigured()) {
    return send(res, 501, {
      configured: false,
      demo: true,
      message: 'STK service is linking — please try again shortly',
      CheckoutRequestID: 'DEMO-' + Date.now()
    });
  }
  try {
    const token = await getToken();
    const result = await stkPush(phone, amount, token);
    res.writeHead(result.status || 200, { 'Content-Type': 'application/json' });
    res.end(result.body);
  } catch (e) {
    send(res, 502, { error: 'STK request failed' });
  }
}

async function handleCallback(req, res) {
  const body = await readJson(req);
  const cb = (body && body.Body && body.Body.stkCallback) || {};
  const items = ((cb.CallbackMetadata && cb.CallbackMetadata.Item) || []);
  const pick = (name) => {
    const it = items.find((i) => i && i.Name === name);
    return it ? it.Value : undefined;
  };
  const record = {
    at: new Date().toISOString(),
    resultCode: cb.ResultCode,
    resultDesc: cb.ResultDesc,
    checkoutRequestId: cb.CheckoutRequestID,
    merchantRequestId: cb.MerchantRequestID,
    amount: pick('Amount'),
    receipt: pick('MpesaReceiptNumber'),
    phone: pick('PhoneNumber')
  };
  console.log(
    'STK callback code=%s desc=%s receipt=%s amount=%s phone=%s',
    String(record.resultCode), String(record.resultDesc),
    String(record.receipt), String(record.amount), String(record.phone)
  );
  try {
    const dir = path.join(__dirname, 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'payments.log'), JSON.stringify(record) + '\n');
  } catch { /* log failure must not break callback */ }
  send(res, 200, { ResultCode: 0, ResultDesc: 'Accepted' });
}

function stkQuery(checkoutRequestId, token) {
  return new Promise((resolve, reject) => {
    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
    const ts = nairobiTimestamp();
    const password = Buffer.from(shortcode + passkey + ts).toString('base64');
    const payload = JSON.stringify({
      BusinessShortCode: Number(shortcode),
      Password: password,
      Timestamp: ts,
      CheckoutRequestID: checkoutRequestId
    });
    const url = baseUrl() + '/mpesa/stkpushquery/v1/query';
    const req = https.request(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function handleQuery(req, res) {
  const body = await readJson(req);
  const id = body && String(body.checkoutRequestId || '').trim();
  if (!id) return send(res, 400, { error: 'checkoutRequestId required' });
  if (!isConfigured()) return send(res, 501, { configured: false, demo: true });
  try {
    const token = await getToken();
    const result = await stkQuery(id, token);
    res.writeHead(result.status || 200, { 'Content-Type': 'application/json' });
    res.end(result.body);
  } catch (e) {
    send(res, 502, { error: 'Query failed' });
  }
}

function handleStatus(req, res) {
  send(res, 200, {
    configured: isConfigured(),
    env: env('MPESA_ENV', 'sandbox'),
    shortcodeLen: (process.env.MPESA_SHORTCODE || '').length
  });
}

const server = http.createServer((req, res) => {
  if (withCors(req, res)) return;
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'POST' && url === '/api/pay') return handlePay(req, res);
  if (req.method === 'POST' && url === '/api/pay/callback') return handleCallback(req, res);
  if (req.method === 'GET' && url === '/api/pay/status') return handleStatus(req, res);
  if (req.method === 'POST' && url === '/api/pay/query') return handleQuery(req, res);
  send(res, 404, { error: 'Not found' });
});

const port = Number(process.env.PORT) || 3003;
server.listen(port, () => {
  console.log('STK server listening on :' + port);
});
