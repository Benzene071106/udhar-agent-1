// Reading a photo of the paper khata: the vision model only reads; the code decides what each block means, and the
// owner adds the rows he agrees with through the normal owner path. Nothing is written by the photo route itself.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../dist-server/server/server.js');
const C = require('../dist-server/core/agent-core.js');
const KP = require('../dist-server/core/khata-photo.js');

const TODAY = '2026-10-08';
fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-photo-'));
const PNG = 'data:image/png;base64,' + Buffer.from('not really a png, the fake model does not look').toString('base64');

// what a vision model might answer for one page (Devanagari digits and a stray "/-" included)
const PAGE = {
  page_date: '23/9/26',
  blocks: [
    { name: 'Sharma ji', name_as_written: 'शर्मा जी', items: [{ text: 'aata', amount: 200 }, { text: 'tel', amount: '140' }], total: 340, struck: false, confidence: 0.9 },
    { name: 'Deshmukh', items: [{ text: 'saman', amount: 990 }], total: '९९०', struck: true, confidence: 0.8 },
    { name: 'Verma ji', items: [{ text: 'chawal', amount: 60 }, { text: 'dal', amount: 85 }], total: 150, struck: false, confidence: 0.85 },
    { name: 'Ramesh Yadav', items: [], total: '643/-', struck: false, confidence: 0.75 },
    { name: 'Kale madam', items: [], total: null, struck: false, confidence: 0.3 }
  ]
};

function shop(reply, env) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (reply && reply.http) return { ok: false, status: reply.http, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '```json\n' + JSON.stringify(reply) + '\n```' } }] }) };
  };
  const srv = createServer({ env: Object.assign({ SHOP: 'gupta', DATA_DIR: tmpDir(), VISION_URL: 'http://vision.test/v1', VISION_MODEL: 'google/gemma-4-31B-it' }, env || {}), fetch, today: () => TODAY });
  return Object.assign(srv, { calls });
}
async function post(srv, body) {
  const base = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + srv.address().port)));
  try {
    const r = await fetch(base + '/api/khata-photo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  } finally { srv.close(); }
}

test('each block gets a status: still owed, paid (crossed out) or check', () => {
  const s = C.freshShop('gupta', TODAY);
  const r = KP.reviewPhoto(s, KP.normalizePhoto(PAGE));
  const by = (n) => r.blocks.find((b) => b.name === n);
  assert.strictEqual(r.pageDate, '23/9/26');
  assert.strictEqual(by('Sharma ji').status, 'open');
  assert.strictEqual(by('Sharma ji').match.name, 'Sharma ji');
  assert.strictEqual(by('Sharma ji').ownerText, 'Sharma ji 340 udhaar');
  assert.strictEqual(by('Deshmukh').status, 'paid', 'a crossed-out block is paid, never imported as debt');
  assert.strictEqual(by('Deshmukh').total, 990, 'Devanagari digits are read');
  assert.strictEqual(by('Deshmukh').ownerText, null);
  assert.strictEqual(by('Verma ji').status, 'check');
  assert.ok(by('Verma ji').reasons.some((x) => /add up to ₹145/.test(x)), 'items that do not add up to the total are flagged');
  assert.strictEqual(by('Ramesh Yadav').status, 'open');
  assert.strictEqual(by('Ramesh Yadav').total, 643);
  assert.ok(by('Ramesh Yadav').reasons.includes('new customer'));
  assert.strictEqual(by('Kale madam').status, 'check');
  assert.strictEqual(by('Kale madam').ownerText, null, 'no total, nothing to add');
  assert.strictEqual(r.openTotal, 340 + 643);
});

test('amounts that are not a kirana balance are dropped, and a reply with no blocks is an error', () => {
  assert.strictEqual(KP.money(250000), null);
  assert.strictEqual(KP.money('₹1,250'), 1250);
  assert.strictEqual(KP.money(-40), null);
  assert.throws(() => KP.normalizePhoto({ text: 'I cannot read this' }));
});

test('the route sends the photo to the vision model and writes nothing', async () => {
  const srv = shop(PAGE);
  const before = srv.getState().txns.length;
  const r = await post(srv, { image: PNG });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.open, 2);
  assert.strictEqual(r.json.paid, 1);
  assert.strictEqual(r.json.model, 'google/gemma-4-31B-it');
  assert.strictEqual(srv.getState().txns.length, before, 'reading a photo never writes the khata');
  const sent = srv.calls[0];
  assert.strictEqual(sent.url, 'http://vision.test/v1/chat/completions');
  assert.strictEqual(sent.body.model, 'google/gemma-4-31B-it');
  assert.ok(sent.body.messages[1].content.some((c) => c.type === 'image_url' && c.image_url.url.startsWith('data:image/png;base64,')));
});

test('an added row goes through the owner path: a known customer is written, a new name is asked first', () => {
  const s = C.freshShop('gupta', TODAY);
  const r = KP.reviewPhoto(s, KP.normalizePhoto(PAGE));
  const n0 = s.txns.length;
  C.runAction(s, 'owner', { text: r.blocks.find((b) => b.name === 'Sharma ji').ownerText });
  assert.strictEqual(s.txns.length, n0 + 1);
  const ask = C.runAction(s, 'owner', { text: r.blocks.find((b) => b.name === 'Ramesh Yadav').ownerText });
  assert.strictEqual(s.txns.length, n0 + 1, 'a new name is not written until the owner says haan');
  assert.ok(ask.result.messages.some((m) => m.to === 'owner' && /naya grahak/.test(m.text)));
});

test('off without VISION_URL, a bad image is refused, a failing model is reported', async () => {
  assert.strictEqual((await post(shop(PAGE, { VISION_URL: '' }), { image: PNG })).status, 503);
  assert.strictEqual((await post(shop(PAGE), { image: 'data:text/html;base64,PGh0bWw+' })).status, 400);
  const bad = await post(shop({ http: 500 }), { image: PNG });
  assert.strictEqual(bad.status, 502);
  assert.match(bad.json.error, /HTTP 500/);
});
