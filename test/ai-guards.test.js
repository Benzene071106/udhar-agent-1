// Stress Test 2 (KAN-68 to KAN-77): the model's reply never acts alone where the message does not say so.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../dist-server/server/server.js');
const U = require('../dist-server/core/understand.js');

const TODAY = '2026-10-08';
fs.existsSync(path.join(__dirname, '../dist/udhaar-agent-standalone.html')) || require('../build.js');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'udhaar-ai-'));

/** A shop whose model answers every call with `reply` (a function of the call count, or an object). */
function shop(reply) {
  let n = 0;
  const fetch = async () => {
    const r = typeof reply === 'function' ? reply(n++) : reply;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: typeof r === 'string' ? r : JSON.stringify(r) } }] }) };
  };
  return createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir(), AGENT37_LLM_PROXY_URL: 'http://llm.test/v1' }, fetch, today: () => TODAY });
}
const owner = (j) => Object.assign({ lang: 'hinglish', english: '', relevant: true, intent: 'unknown', items: [], amount: null, person: '', phone: '', due_date: '', confidence: 0.9 }, j);
async function say(srv, text) {
  const st = srv.getState();
  const txns = st.txns.length;
  const a = Object.assign({}, { text });
  a.intent = await srv.brain.understandOwner(text);
  const C = require('../dist-server/core/agent-core.js');
  const out = C.runAction(st, 'owner', a);
  return { newTxns: st.txns.slice(txns), out, state: st };
}
const bal = (st, name) => { const C = require('../dist-server/core/agent-core.js'); const c = st.customers.find((x) => x.name === name); return Math.round(C.balance(st, c.id)); };

test('KAN-68: "theek hai" / "ok" never sends reminders to everyone or removes a customer', async () => {
  for (const [text, j] of [['theek hai', { intent: 'remind_all', confidence: 0.99 }], ['theek hai', { intent: 'remind_all', confidence: 0.1 }], ['ok', { intent: 'remove_customer', person: 'Pappu', confidence: null }], ['hello bhai kaise ho', { intent: 'remove_customer', person: 'Pappu' }]]) {
    const srv = shop(owner(j));
    const before = srv.getState().messages.filter((m) => m.from === 'agent' && m.to !== 'owner').length;
    const r = await say(srv, text);
    assert.equal(r.state.messages.filter((m) => m.from === 'agent' && m.to !== 'owner').length, before, text + ': no customer messages');
    assert.ok(!r.state.customers.find((c) => c.name === 'Pappu').removed, text + ': Pappu stays');
  }
});

test('KAN-69: the model cannot put an entry in a khata the message does not name', async () => {
  let r = await say(shop(owner({ intent: 'udhaar', person: 'Pappu', amount: 200 })), '200 likh do');
  assert.equal(r.newTxns.length, 0);
  r = await say(shop(owner({ intent: 'udhaar', person: 'Patil bhau', amount: 200 })), 'Pappu 200 udhaar');
  assert.equal(r.newTxns.length, 1);
  assert.equal(r.newTxns[0].custId, 'C003');
});

test('KAN-70: the model cannot flip udhaar and jama against the owner\'s words; unsure money is not written', async () => {
  let r = await say(shop(owner({ intent: 'jama', person: 'Pappu', amount: 200 })), 'Pappu ne 200 ka saaman liya');
  assert.equal(r.newTxns.length, 1); assert.equal(r.newTxns[0].type, 'credit');
  r = await say(shop(owner({ intent: 'udhaar', person: 'Meena didi', amount: 300 })), 'Meena didi ne 300 diye');
  assert.equal(r.newTxns.length, 1); assert.equal(r.newTxns[0].type, 'payment');
  r = await say(shop('Note {this} then ' + JSON.stringify(owner({ intent: 'jama', person: 'Pappu', amount: 200 }))), 'Pappu 200 udhaar');
  assert.ok(r.newTxns.every((t) => t.type === 'credit'));
  r = await say(shop(owner({ intent: 'jama', person: 'Pappu', amount: 200, confidence: 0.3 })), 'Pappu 200');
  assert.ok(r.newTxns.every((t) => t.type !== 'payment'));
});

test('KAN-71 / KAN-74: phone numbers and promise dates must be in the message', async () => {
  let r = await say(shop(owner({ intent: 'set_phone', person: 'Rohan', phone: '9123456789' })), 'Rohan ka number save karo');
  assert.notEqual(r.state.customers.find((c) => c.name === 'Rohan').phone, '9123456789');
  r = await say(shop(owner({ intent: 'add_customer', person: 'Suresh', phone: '9000000001' })), 'naya grahak Suresh');
  assert.ok(!r.state.customers.some((c) => c.phone === '9000000001'));
  const srv = shop(owner({ intent: 'promise', person: 'Verma ji', due_date: '2026-11-30' }));
  const oi = await srv.brain.understandOwner('Verma ji paisa denge');
  assert.equal(oi.dueDate, null);
});

test('KAN-77: a model reply with fewer fields than the rules does not lose the name and amount', async () => {
  const r = await say(shop('[{"intent":"udhaar"}]'), 'Pappu 200 udhaar');
  assert.equal(r.newTxns.length, 1);
  assert.equal(r.newTxns[0].amount, 200);
  assert.equal(r.newTxns[0].custId, 'C003');
});

test('KAN-72 / KAN-73: customer side: no opt-out, verify, abuse, amount or items the message does not say', async () => {
  const cust = (j) => Object.assign({ lang: 'hinglish', english: '', relevant: true, intent: 'question', items: [], amount: null, person: '', phone: '', due_date: '', method: '', confidence: 0.9 }, j);
  const ci = async (j, text) => shop(cust(j)).brain.understandCustomer(text, 'C003');
  assert.notEqual((await ci({ intent: 'opt_out' }, 'ok')).intent, 'opt_out');
  assert.notEqual((await ci({ intent: 'confirm_yes' }, 'kya hai ye?')).intent, 'confirm_yes');
  assert.notEqual((await ci({ intent: 'abuse' }, 'bhai thoda time do')).intent, 'abusive');
  assert.equal((await ci({ intent: 'confirm_yes' }, 'haan sahi hai')).intent, 'confirm_yes');
  assert.equal((await ci({ intent: 'payment_claim', amount: 5000 }, 'maine paise de diye')).amount, null);
  assert.equal((await ci({ intent: 'payment_claim', amount: 170, method: 'upi' }, '170 UPI kar diya')).amount, 170);
  const o = await ci({ intent: 'order', items: [{ name: 'Basmati chawal', qty: 25, unit: 'kg' }] }, 'namaste');
  assert.notEqual(o.intent, 'order');
});

test('KAN-76: a translation that swaps two amounts is rejected', () => {
  assert.throws(() => U.checkTranslation('Pappu ji, aapka ₹170 baaki hai aur ₹30 advance jama hai.', { text: 'Pappu ji, aapka ₹30 baaki hai aur ₹170 advance jama hai.' }));
  assert.ok(U.checkTranslation('Pappu ji, aapka ₹170 baaki hai.', { text: 'पप्पू जी, आपका ₹170 बाकी है।' }));
});

test('KAN-75: a dead model endpoint costs one timeout, then the rules answer at once', async () => {
  let calls = 0;
  const fetch = (url, init) => { calls++; return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))); };
  const srv = createServer({ env: { SHOP: 'gupta', DATA_DIR: tmpDir(), AGENT37_LLM_PROXY_URL: 'http://llm.test/v1', LLM_TIMEOUT_MS: '150' }, fetch, today: () => TODAY });
  const t0 = Date.now();
  for (let i = 0; i < 4; i++) await srv.brain.understandOwner('Pappu ne ' + (100 + i) + ' ka saaman liya');
  assert.equal(calls, 1);
  assert.ok(Date.now() - t0 < 1000, 'took ' + (Date.now() - t0) + ' ms');
});
