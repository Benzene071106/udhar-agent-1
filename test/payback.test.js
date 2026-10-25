// Pay back by UPI: the customer picks the full baaki or a part, gets a QR and a tap-to-pay link for exactly that amount,
// and the khata changes only when the payment is confirmed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createServer } = require('../dist-server/server/server.js');
const { fakeWeb } = require('./fake-wa.js');
const C = require('../dist-server/core/agent-core.js');

const TODAY = '2026-10-08';
const PUBLIC = 'https://gupta.example.org';
const OWNER = '+919800000001', CUST = '+919812345678';
fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port))); }
function waServer(extraEnv) {
  const sent = [];
  const fetch = async () => new Response('{}', { status: 404 });
  const env = Object.assign({ SHOP: 'nayi', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-pay-')), WA_PROVIDER: 'web', OWNER_WHATSAPP: OWNER, PUBLIC_URL: PUBLIC }, extraEnv || {});
  const web = fakeWeb((to, c) => sent.push({ to: '+' + to, body: c.text, image: c.image || null, caption: c.caption || null }));
  const server = createServer({ env, today: () => TODAY, fetch, webTransport: web.factory });
  const say = (num, text, name) => web.inbound(server, { From: 'whatsapp:' + num, ProfileName: name || 'Rohit', Body: text });
  const to = (num) => sent.filter((s) => s.to === num && s.body != null).map((s) => s.body);
  const images = (num) => sent.filter((s) => s.to === num && s.image);
  return { server, say, to, images, clear: () => { sent.length = 0; } };
}
// a customer who owes 500, and their secret pay link
async function owing500() {
  const w = waServer();
  const base = await listen(w.server);
  w.server.getState().shop.upiId = 'nayidukaan@okaxis'; // what the owner puts in Shop profile
  await w.say(CUST, 'hi');
  await w.say(OWNER, 'Rohit 500 udhaar');
  const st = w.server.getState(), c = st.customers.find((x) => x.phone === '9812345678');
  await fetch(base + '/pay/' + c.id + '.0000000000000000'); // makes the pay secret, like the first reminder does
  const tok = crypto.createHmac('sha256', w.server.getState().paySecret).update(c.id).digest('hex').slice(0, 16);
  const pay = (q) => fetch(base + '/pay/' + c.id + '.' + tok + (q || '')).then(async (r) => ({ status: r.status, headers: r.headers, html: await r.text() }));
  return Object.assign(w, { base, c, pay });
}
const upiIn = (html) => { const m = /href="(upi:\/\/pay\?[^"]+)"/.exec(html); return m ? new URL(m[1].replace(/&amp;/g, '&')) : null; };

test('payAmount: empty is the full baaki, part amounts are checked, overpaying needs a yes', () => {
  const st = C.createState(); C.seedDemo(st);
  const c = st.customers.find((x) => C.balance(st, x.id) > 100);
  const bal = Math.round(C.balance(st, c.id));
  assert.deepEqual(C.payAmount(st, c.id, ''), { ok: true, amount: bal, balance: bal, full: true, extra: 0 });
  assert.deepEqual(C.payAmount(st, c.id, '100'), { ok: true, amount: 100, balance: bal, full: false, extra: 0 });
  for (const s of ['₹100', '100.00', ' 1,00 ', 'Rs.100', '100/-']) assert.equal(C.payAmount(st, c.id, s).amount, 100, s);
  assert.equal(C.payAmount(st, c.id, String(bal)).full, true);
  assert.equal(C.payAmount(st, c.id, '0').error, 'zero');
  assert.equal(C.payAmount(st, c.id, '-50').error, 'not-number');
  assert.equal(C.payAmount(st, c.id, 'abc').error, 'not-number');
  assert.equal(C.payAmount(st, c.id, '1e3').error, 'not-number');
  assert.equal(C.payAmount(st, c.id, '99.50').error, 'paise');
  assert.equal(C.payAmount(st, c.id, '5000000').error, 'too-big');
  const over = C.payAmount(st, c.id, String(bal + 50));
  assert.equal(over.ok, false); assert.equal(over.error, 'over'); assert.equal(over.extra, 50);
  assert.deepEqual(C.payAmount(st, c.id, String(bal + 50), { over: true }), { ok: true, amount: bal + 50, balance: bal, full: false, extra: 50 });
  const clear = st.customers.find((x) => C.balance(st, x.id) <= 0);
  if (clear) assert.equal(C.payAmount(st, clear.id, '').error, 'none-due');
});

test('pay page: full by default, a part amount makes a QR and a tap-to-pay link for exactly that amount', async () => {
  const w = await owing500();
  try {
    let r = await w.pay();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.match(r.html, /₹500/);
    assert.match(r.html, /<svg/);
    assert.match(r.html, /Poora baaki/);
    assert.match(r.html, /prefers-color-scheme:dark/);
    let u = upiIn(r.html);
    assert.equal(u.searchParams.get('am'), '500');
    assert.equal(u.searchParams.get('pa'), w.server.getState().shop.upiId);
    assert.equal(u.searchParams.get('tn'), 'UDH-' + w.c.id); // the tag the UPI SMS matcher reads back
    assert.ok(u.searchParams.get('pn'));

    r = await w.pay('?mode=part&amt=200');
    u = upiIn(r.html);
    assert.equal(u.searchParams.get('am'), '200');
    assert.match(r.html, /Iske baad baaki: ₹300/);
    assert.match(r.html, /value="200"/);

    r = await w.pay('?mode=full&amt=200'); // "Poora" wins over a number left in the box
    assert.equal(upiIn(r.html).searchParams.get('am'), '500');
    assert.match(r.html, /Khata clear ho jayega/);
  } finally { w.server.close(); }
});

test('pay page: bad amounts never make a QR, and the khata is untouched', async () => {
  const w = await owing500();
  try {
    for (const [q, why] of [['?mode=part&amt=0', /0 se zyada/], ['?mode=part&amt=abc', /Sirf raqam/], ['?mode=part&amt=', /Sirf raqam/], ['?mode=part&amt=99.5', /Poore rupaye/], ['?mode=part&amt=-5', /Sirf raqam/], ['?mode=part&amt=9999999', /tak hi/], ['?amt=%3Cscript%3E', /Sirf raqam/]]) {
      const r = await w.pay(q);
      assert.equal(r.status, 200, q);
      assert.match(r.html, why, q);
      assert.equal(upiIn(r.html), null, q);
      assert.ok(!r.html.includes('<script>'), q);
    }
    assert.equal(C.balance(w.server.getState(), w.c.id), 500);
  } finally { w.server.close(); }
});

test('pay page: more than the baaki is asked first, then the QR says what goes to advance', async () => {
  const w = await owing500();
  try {
    let r = await w.pay('?mode=part&amt=700');
    assert.equal(upiIn(r.html), null);
    assert.match(r.html, /₹200 zyada hai/);
    assert.match(r.html, /advance/);
    assert.match(r.html, /amt=700&amp;over=1/);
    r = await w.pay('?amt=700&over=1');
    assert.equal(upiIn(r.html).searchParams.get('am'), '700');
    assert.match(r.html, /₹200 advance mein/);
    assert.equal(C.balance(w.server.getState(), w.c.id), 500); // still nothing written
  } finally { w.server.close(); }
});

test('pay page: nothing due shows no QR; no shop UPI ID shows cash only', async () => {
  const w = await owing500();
  try {
    await w.say(OWNER, 'Rohit 500 jama');
    let r = await w.pay();
    assert.match(r.html, /Koi baaki nahi/);
    assert.equal(upiIn(r.html), null);
    await w.say(OWNER, 'Rohit 300 udhaar');
    w.server.getState().shop.upiId = '';
    r = await w.pay('?amt=100');
    assert.match(r.html, /UPI abhi set nahi/);
    assert.match(r.html, /cash de diya/);
    assert.equal(upiIn(r.html), null);
  } finally { w.server.close(); }
});

// the UPI link a QR PNG carries: read back from the pixels against the same QR library
const zlib = require('zlib');
function pngModules(buf) {
  assert.deepEqual([...buf.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const size = buf.readUInt32BE(16);
  let p = 8, idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8); if (type === 'IDAT') idat.push(buf.slice(p + 8, p + 8 + len)); p += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return (x, y) => raw[y * (size + 1) + 1 + x] === 0;
}
function sameQr(png, text) {
  const qr = require('../vendor/qrcode-generator.js')(0, 'M'); qr.addData(text); qr.make();
  const dark = pngModules(png), n = qr.getModuleCount();
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark((c + 4) * 8 + 4, (r + 4) * 8 + 4) !== qr.isDark(r, c)) return false;
  return true;
}

test('WhatsApp: "200 ka QR bhejo" gets the QR image for ₹200, a tap-to-pay link, and nothing is written', async () => {
  const w = await owing500();
  try {
    w.clear();
    await w.say(CUST, '200 ka QR bhejo');
    const m = w.to(CUST).join('\n');
    assert.match(m, /Aapka baaki: ₹500/);
    assert.match(m, /₹200 ka QR\. Baaki ₹300 baad mein\./);
    assert.match(m, /₹200 ka UPI QR neeche/);
    assert.match(m, /Poora ₹500 dena ho toh likhiye: \*QR bhejo\*/);
    assert.match(m, /Cash dena ho toh/);
    assert.match(m, new RegExp(PUBLIC.replace(/\./g, '\\.') + '/pay/' + w.c.id + '\\.[0-9a-f]{16}\\?amt=200'));
    const img = w.images(CUST);
    assert.equal(img.length, 1);
    assert.match(img[0].caption, /₹200 · .* · nayidukaan@okaxis/);
    const st = w.server.getState();
    assert.ok(sameQr(img[0].image, C.upiLink(st, w.c, 200)), 'the PNG is the QR of upi://pay ... am=200');
    assert.equal(w.to(OWNER).length, 0); // not a payment claim: the owner is not told anything was paid
    assert.equal(C.balance(st, w.c.id), 500);

    w.clear();
    await w.say(CUST, 'QR bhejo');
    assert.match(w.to(CUST).join('\n'), /Poore ₹500 ka UPI QR/);
    assert.match(w.to(CUST).join('\n'), /thoda dena ho toh likhiye jaise \*250 ka QR bhejo\*/);
    assert.match(w.to(CUST).join('\n'), /Cash dena ho toh/);
    assert.ok(sameQr(w.images(CUST)[0].image, C.upiLink(st, w.c, 500)));

    // more than the baaki: the QR is for the baaki; paying extra as advance is a choice made on the page
    w.clear();
    await w.say(CUST, '700 ka QR bhejo');
    assert.match(w.to(CUST).join('\n'), /baaki sirf ₹500 hai.*₹200 advance/s);
    assert.ok(sameQr(w.images(CUST)[0].image, C.upiLink(st, w.c, 500)));
    assert.match(w.to(CUST).join('\n'), /\?amt=500/);
  } finally { w.server.close(); }
});

test('WhatsApp: the hisaab and reminders tell how to get the QR; "QR se pay kar diya" stays a payment claim', async () => {
  const w = await owing500();
  try {
    w.clear();
    await w.say(CUST, 'kitna baaki hai');
    assert.match(w.to(CUST).join('\n'), /Poora baaki: \*QR bhejo\*.*\*200 ka QR bhejo\*/s);
    assert.equal(w.images(CUST).length, 0); // the hisaab alone sends no image
    w.clear();
    await w.say(CUST, 'QR se 200 pay kar diya');
    assert.match(w.to(CUST).join('\n'), /Payment aate hi khata update ho jayega/);
    assert.match(w.to(OWNER).join('\n'), /pay kar diya/);
    assert.equal(w.images(CUST).length, 0);
    assert.equal(C.balance(w.server.getState(), w.c.id), 500);
  } finally { w.server.close(); }
});

test('wantsToPay: asking for a QR or link to pay now, never a past payment or other talk', () => {
  for (const t of ['QR bhejo', '200 ka QR bhejo', 'qr code bhejo', 'scanner bhejo', 'pay link bhejo', 'Link bhejo bhai', 'UPI se dena hai', 'kaise pay karu', '200 pay karna hai', 'मुझे QR भेजो'])
    assert.equal(C.wantsToPay(t), true, t);
  for (const t of ['QR se pay kar diya', 'link pe 200 bhej diye', 'pay kr diya', 'kitna baaki hai', 'cash de diya', 'aata 2 kilo', 'hi', 'kal dunga'])
    assert.equal(C.wantsToPay(t), false, t);
});

test('a customer with nothing due who asks for a QR is told so, with no link', () => {
  const st = C.createState(); C.seedDemo(st);
  const c = st.customers.find((x) => C.balance(st, x.id) <= 0 && !x.removed);
  if (!c) return;
  const out = C.handleCustomerMessage(st, c.id, 'QR bhejo');
  assert.ok(out.some((m) => /koi baaki nahi/i.test(m.text)), JSON.stringify(out.map((m) => m.text)));
  assert.ok(!out.some((m) => m.kind === 'pay-offer'));
});

test('validUpi: a shop UPI ID is name@bank, cleaned; anything else is refused', () => {
  for (const [i, o] of [['guptastore@okaxis', 'guptastore@okaxis'], [' Gupta.Kirana@OKSBI ', 'gupta.kirana@oksbi'], ['9812345678@ybl', '9812345678@ybl'], ['ramesh_k-1@paytm', 'ramesh_k-1@paytm']]) assert.equal(C.validUpi(i), o, i);
  for (const b of ['', 'guptakirana', '@okaxis', 'gupta kirana@okaxis', 'gupta@', 'gupta@ok axis', 'a@b', 'x@1bank', 'upi://pay?pa=x@y', 'gupta@okaxis&am=1']) assert.equal(C.validUpi(b), null, b);
});

test('Shop profile: the owner adds the shop UPI once, and from then on "QR bhejo" gets a QR to that UPI', async () => {
  const w = waServer({ ADMIN_KEY: 'admin-secret' });
  const base = await listen(w.server);
  const post = (p, body, cookie) => fetch(base + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}), body: JSON.stringify(body) });
  try {
    const st = () => w.server.getState();
    assert.equal(st().shop.upiId, ''); // a new shop has no made-up UPI ID
    await w.say(CUST, 'hi');
    await w.say(OWNER, 'Rohit 500 udhaar');
    w.clear();
    await w.say(CUST, 'QR bhejo');
    assert.match(w.to(CUST).join('\n'), /UPI abhi set nahi/);
    assert.equal(w.images(CUST).length, 0);
    assert.match(w.to(OWNER).join('\n'), /Shop profile mein UPI ID daal dijiye/);

    const profile = { shopName: 'Rohit Stores', ownerName: 'Rohit', address: '1 Main Road', gstRegistered: true, gstin: '27AAPFU0939F1ZV', phone: '9800000001', password: 'meri-dukaan', adminKey: 'admin-secret' };
    let r = await post('/api/auth/setup', Object.assign({}, profile, { upiId: 'rohit stores' }));
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /name@bank/);
    assert.equal(st().shop.upiId, '');
    r = await post('/api/auth/setup', Object.assign({}, profile, { upiId: ' RohitStores@OKAXIS ' }));
    assert.equal(r.status, 200);
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    assert.equal(st().shop.upiId, 'rohitstores@okaxis');

    w.clear();
    await w.say(CUST, '200 ka QR bhejo');
    const img = w.images(CUST);
    assert.equal(img.length, 1);
    assert.match(img[0].caption, /rohitstores@okaxis/);
    const c = st().customers.find((x) => x.phone === '9812345678');
    assert.ok(sameQr(img[0].image, C.upiLink(st(), c, 200)));
    assert.match(C.upiLink(st(), c, 200), /pa=rohitstores%40okaxis&.*am=200/);

    // changed later in Shop profile
    const { phone, password, adminKey, ...edit } = profile;
    r = await post('/api/profile', Object.assign({}, edit, { upiId: 'rohit2@ybl' }), cookie);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).upiId, 'rohit2@ybl');
    assert.equal(st().shop.upiId, 'rohit2@ybl');
    // empty turns QR payments off
    await post('/api/profile', Object.assign({}, edit, { upiId: '' }), cookie);
    assert.equal(st().shop.upiId, '');
    // a profile save that leaves the field out keeps the UPI as it was
    await post('/api/profile', Object.assign({}, edit, { upiId: 'rohit3@ybl' }), cookie);
    await post('/api/profile', edit, cookie);
    assert.equal(st().shop.upiId, 'rohit3@ybl');
    assert.equal(C.balance(st(), c.id), 500);
  } finally { w.server.close(); }
});

test('Placeholder UPI: a demo ID left in saved data never reaches a customer; after a profile save the QR pays the saved UPI', async () => {
  // demo data never ships a real-looking UPI ID
  for (const id of Object.keys(C.DEMO_SHOPS || {})) {
    const s = C.createState(); if (C.seedDemo) C.seedDemo(s, id);
    assert.ok(!C.isPlaceholderUpi(s.shop.upiId), id);
  }
  assert.equal(C.createState().shop.upiId, '');
  for (const p of ['guptakirana@upi', ' GuptaKirana@UPI ', 'balajidairy@upi', 'nayidukaan@upi', 'zafarsastabazaar@upi', 'saikrupakirana@upi']) {
    assert.equal(C.validUpi(p), null, p);
    assert.ok(C.isPlaceholderUpi(p), p);
  }
  const w = await owing500();
  try {
    const st = () => w.server.getState();
    st().shop.upiId = 'guptakirana@upi'; // what the live gupta shop still had from the old seed
    assert.equal(C.shopUpi(st()), '');
    assert.equal(C.upiLink(st(), w.c, 100), '');
    // pay page: no QR, no UPI button, cash only
    const r = await w.pay();
    assert.equal(r.status, 200);
    assert.equal(upiIn(r.html), null);
    assert.doesNotMatch(r.html, /guptakirana/);
    assert.match(r.html, /UPI abhi set nahi/);
    // WhatsApp: no QR image, cash text, the owner is told
    w.clear();
    await w.say(CUST, 'QR bhejo');
    assert.equal(w.images(CUST).length, 0);
    assert.doesNotMatch(w.to(CUST).join('\n'), /guptakirana/);
    assert.match(w.to(CUST).join('\n'), /UPI abhi set nahi/);
    assert.match(w.to(OWNER).join('\n'), /Shop profile mein UPI ID daal dijiye/);
    // the owner saves their own UPI: the QR on WhatsApp and the pay page both pay exactly that
    st().shop.upiId = 'rohit.real@okaxis';
    w.clear();
    await w.say(CUST, '200 ka QR bhejo');
    assert.equal(w.images(CUST).length, 1);
    assert.match(w.images(CUST)[0].caption, /rohit\.real@okaxis/);
    assert.equal(new URL(C.upiLink(st(), w.c, 200)).searchParams.get('pa'), 'rohit.real@okaxis');
    assert.equal(upiIn((await w.pay('?amt=200')).html).searchParams.get('pa'), 'rohit.real@okaxis');
  } finally { w.server.close(); }
});

test('Profile save: a placeholder UPI is refused; a real one is what the QR pays, in memory and after a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-upi-'));
  const w = waServer({ ADMIN_KEY: 'admin-secret', DATA_DIR: dir });
  const base = await listen(w.server);
  const post = (p, body, cookie) => fetch(base + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}), body: JSON.stringify(body) });
  try {
    const profile = { shopName: 'Rohit Stores', ownerName: 'Rohit', address: '1 Main Road', gstRegistered: true, gstin: '27AAPFU0939F1ZV', phone: '9800000001', password: 'meri-dukaan', adminKey: 'admin-secret' };
    let r = await post('/api/auth/setup', Object.assign({}, profile, { upiId: 'guptakirana@upi' }));
    assert.equal(r.status, 400);
    assert.equal(w.server.getState().shop.upiId, '');
    r = await post('/api/auth/setup', profile);
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    const { phone, password, adminKey, ...edit } = profile;
    r = await post('/api/profile', Object.assign({}, edit, { upiId: 'guptakirana@upi' }), cookie);
    assert.equal(r.status, 400);
    r = await post('/api/profile', Object.assign({}, edit, { upiId: 'Owner.Own@OKSBI' }), cookie);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).upiId, 'owner.own@oksbi');
    await w.say(CUST, 'hi');
    await w.say(OWNER, 'Rohit 500 udhaar');
    const c = w.server.getState().customers.find((x) => x.phone === '9812345678');
    assert.equal(new URL(C.upiLink(w.server.getState(), c, 500)).searchParams.get('pa'), 'owner.own@oksbi');
  } finally { w.server.close(); }
  // the saved file holds the same UPI, so a restart serves it too
  const w2 = waServer({ DATA_DIR: dir });
  try { assert.equal(C.shopUpi(w2.server.getState()), 'owner.own@oksbi'); } finally { w2.server.close(); }
});
