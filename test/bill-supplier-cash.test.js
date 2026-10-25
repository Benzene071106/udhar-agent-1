// A customer's order gets an itemised bill at once, priced from the rate memory; a new item is asked of the owner and
// the customer gets the full bill when the owner prices it. The owner can make anyone a supplier ("Ramesh ko supplier
// banao 98..., wo doodh aur bread deta hai"). A cash claim above the baaki is asked back; a bare "baki?" is a balance question.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../dist-server/core/agent-core.js');

const TODAY = '2026-10-24';
const MIN = 60 * 1000;
let clock = Date.UTC(2026, 9, 24, 10, 0, 0);

function shop() {
  const s = C.freshShop('gupta', TODAY);
  s.prices.chaval = { name: 'chawal', rate: 60, unit: 'kg', date: '2026-10-20' };
  s.prices.dudh = { name: 'doodh', rate: 30, unit: '', date: '2026-10-20' };
  delete s.prices.magi; delete s.prices.maggi;
  return s;
}
function khataCustomer(s, name, phone) {
  const c = C.customerFromWhatsapp(s, phone || '9000004101', name || 'Sarthak seth').cust;
  C.runAction(s, 'owner', { text: 'ok' });
  assert.strictEqual(c.guest, undefined);
  return c;
}
function owe(s, c, amount) { s.txns.push({ id: 'TX' + Math.round(Math.random() * 1e9), custId: c.id, type: 'credit', amount, items: '', date: TODAY, dueDate: TODAY, note: '', source: 'test' }); }
function split(s, n, c) {
  const got = s.messages.slice(n).filter((m) => m.from === 'agent');
  const cust = c ? got.filter((m) => m.to === c.id) : [];
  const own = got.filter((m) => m.to === 'owner');
  return { cust, owner: own, custText: cust.map((m) => m.text).join('\n'), ownerText: own.map((m) => m.text).join('\n') };
}
function say(s, c, text, intent) {
  const n = s.messages.length;
  C.runAction(s, 'customer', { custId: c.id, text, now: (clock += MIN), intent });
  return split(s, n, c);
}
function owner(s, text, c) { const n = s.messages.length; C.runAction(s, 'owner', { text }); return split(s, n, c); }

// ------------------------------------------------------------------ 1. the order bill
test('order: an itemised bill from the rate memory goes to the customer at once (Hinglish and Devanagari)', () => {
  for (const text of ['2 kilo chawal aur 1 doodh', '2 किलो चावल और 1 दूध चाहिए', '2 kilo chaaval aur ek doodh bhej do']) {
    const s = shop(), c = khataCustomer(s);
    const r = say(s, c, text);
    assert.strictEqual(r.cust.length, 1, text);
    assert.strictEqual(r.cust[0].kind, 'order-ask', text);
    assert.match(r.custText, /🧾 Bill:\n {2}• Cha+[wv]a+l 2 kilo × ₹60\/kilo = ₹120\n {2}• Doodh = ₹30\n {2}Kul: ₹150/, text + ': ' + r.custText);
    assert.match(r.custText, /Udhaar mein likhein\? \*Haan\*/, 'the udhaar / cash choice stays');
    assert.ok(!/daam dukaandaar/.test(r.custText), 'every rate known');
    assert.strictEqual(r.owner.length, 0, 'all priced: the owner hears of it once the customer picks udhaar or cash');
    // haan: the owner gets the order, one ok writes it
    const h = say(s, c, 'haan, udhaar mein likh do');
    assert.match(h.ownerText, /Naya order: Sarthak seth, udhaar par[^]*Jod: ₹150/);
    owner(s, 'ok', c);
    assert.strictEqual(s.txns[s.txns.length - 1].amount, 150);
  }
});

test('order: an item with no saved rate is marked, the owner is asked "<item> ka daam?", the reply is saved and the full bill sent', () => {
  for (const [text, reply] of [['2 kilo chawal aur 2 maggi', 'maggi 14'], ['2 किलो चावल और 2 maggi', '१४ रुपये'], ['2 kilo chawal aur 2 maggi chahiye', '14']]) {
    const s = shop(), c = khataCustomer(s);
    let r = say(s, c, text);
    assert.match(r.custText, /Cha+[wv]a+l 2 kilo × ₹60\/kilo = ₹120\n {2}• Maggi ×2 — daam dukaandaar batayenge\n {2}Kul: ₹120 \+ baaki ka daam dukaandaar batayenge/, text + ': ' + r.custText);
    assert.match(r.ownerText, /Sarthak seth ka order[^]*Maggi ka daam\? \(jaise 'maggi 14'\)/, 'the owner is asked at once');
    r = owner(s, reply, c);
    const key = Object.keys(s.prices).find((k) => /^mag/.test(k));
    assert.ok(key && s.prices[key].rate === 14, reply + ': the rate is saved to memory');
    assert.match(r.custText, /Bill update \(Maggi ka daam aa gaya\):\n {2}• Cha+[wv]a+l 2 kilo × ₹60\/kilo = ₹120\n {2}• Maggi 2 × ₹14 = ₹28\n {2}Kul: ₹148/, reply + ': ' + r.custText);
    assert.match(r.custText, /Udhaar mein likhein\?/, 'the customer still picks udhaar or cash');
    assert.match(r.ownerText, /Sarthak seth ko poora bill bhej diya \(₹148\)/);
    // the customer picks cash; the owner confirms; nothing on the khata
    r = say(s, c, 'nahi cash denge');
    assert.match(r.ownerText, /Naya order: Sarthak seth, cash par[^]*Pakka karein/);
    const before = s.txns.length;
    r = owner(s, 'ok', c);
    assert.strictEqual(s.txns.length, before);
    assert.match(r.custText, /Order pakka! ₹148 cash par/);
    // next time the memory prices it on its own
    const again = say(s, c, '3 maggi bhej do');
    assert.match(again.custText, /Maggi 3 × ₹14 = ₹42/);
  }
});

test('order: the owner says "nahi hai" (or nahi) for the new item: it is dropped and the customer gets the bill without it', () => {
  for (const ans of ['maggi nahi hai', 'nahi']) {
    const s = shop(), c = khataCustomer(s);
    say(s, c, '2 kilo chawal aur 2 maggi');
    const r = owner(s, ans, c);
    assert.match(r.custText, /Maggi abhi dukaan mein nahi hai/, ans);
    assert.match(r.custText, /Bill update \(Maggi hata diya\):\n {2}• Cha+[wv]a+l 2 kilo × ₹60\/kilo = ₹120\n {2}Kul: ₹120/, ans + ': ' + r.custText);
    assert.strictEqual(s.orders[s.orders.length - 1].lines.length, 1);
  }
});

test('order: the customer answers udhaar before the owner prices it: the order question carries the rate, one rate writes it', () => {
  const s = shop(), c = khataCustomer(s);
  say(s, c, '2 kilo chawal aur 2 maggi');
  let r = say(s, c, 'haan udhaar');
  assert.match(r.ownerText, /Naya order: Sarthak seth, udhaar par[^]*Maggi[^]*kitne ka\?/);
  assert.ok(!(s.ownerAsks || []).some((a) => a.type === 'order-rate'), 'one question per order');
  r = owner(s, 'maggi 14', c);
  assert.match(r.custText, /Bill update[^]*Kul: ₹148/);
  assert.match(r.ownerText, /Order pakka: Sarthak seth, ₹148 khate mein likh diya/);
  assert.strictEqual(s.txns[s.txns.length - 1].amount, 148);
});

test('order: the balance question still wins over the udhaar ask, and the QR 1 / 2 step still works (#44, #46)', () => {
  const s = shop(), c = khataCustomer(s);
  owe(s, c, 60);
  say(s, c, '2 kilo chawal aur 2 maggi');
  let r = say(s, c, 'mera kitna udhaar hai');
  assert.strictEqual(r.cust[0].kind, 'statement');
  assert.strictEqual(s.orders[s.orders.length - 1].status, 'ask', 'the order still waits for haan / nahi');
  s.shop.upiId = 'gupta@okaxis';
  r = say(s, c, 'QR bhejo');
  assert.ok(r.cust.some((m) => m.kind === 'paid-ask'));
  r = say(s, c, '1');
  assert.ok(r.cust.some((m) => m.kind === 'upi-noted'));
});

// ------------------------------------------------------------------ 2. supplier by any name
test('supplier: "Ramesh ko supplier banao 98..., wo doodh aur bread deta hai" makes a wholesaler with number and items', () => {
  const s = shop();
  const r = owner(s, 'Ramesh ko supplier banao 9812345670, wo doodh aur bread deta hai');
  const w = s.wholesalers.find((x) => x.name === 'Ramesh');
  assert.ok(w, r.ownerText);
  assert.strictEqual(w.phone, '9812345670');
  assert.deepStrictEqual(w.items.map((x) => C.tokenize(x).norm.join(' ')).sort(), ['bread', 'dudh']);
  assert.match(r.ownerText, /Ramesh ab aapke supplier hain[^]*\+91 9812345670[^]*Doodh, Bread \(ab inhi se\)/);
  assert.ok(!s.wholesalers.some((x) => x !== w && x.items.some((it) => /^(doodh|bread)$/i.test(it))), 'one item, one wholesaler');
  // a stock order for doodh now goes to Ramesh
  const o = owner(s, 'doodh 10 packet mangwa do');
  assert.match(o.ownerText, /Ramesh ko bhejun\?\n- Doodh 10 packet/);
});

test('supplier: other phrasings, Devanagari, and no number (asked for)', () => {
  let s = shop();
  let r = owner(s, 'Mohan supplier hai, paneer supply karta hai');
  let w = s.wholesalers.find((x) => x.name === 'Mohan');
  assert.ok(w && w.items.includes('paneer'), r.ownerText);
  assert.strictEqual(w.phone, null);
  assert.match(r.ownerText, /Number: nahi hai\. Bhejiye, jaise "Mohan ka number 98xxxxxxxx"/);
  r = owner(s, 'Mohan ka number 9812345671');
  assert.strictEqual(w.phone, '9812345671');

  s = shop();
  r = owner(s, 'Suresh ko supplier bana do');
  w = s.wholesalers.find((x) => x.name === 'Suresh');
  assert.ok(w, r.ownerText);
  assert.match(r.ownerText, /Number: nahi hai/);
  assert.match(r.ownerText, /Saaman: abhi nahi likha/);

  s = shop();
  r = owner(s, 'रमेश को सप्लायर बनाओ 9812345672, वो दूध और पनीर देता है');
  w = s.wholesalers.find((x) => x.phone === '9812345672');
  assert.ok(w, r.ownerText);
  assert.strictEqual(w.name, 'Ramesh');
  assert.deepStrictEqual(w.items.map((x) => C.tokenize(x).norm.join(' ')).sort(), ['dudh', 'panir']);

  // the old trade-word path still works
  s = shop();
  r = owner(s, 'Agrawal traders ka number 9812345673');
  assert.ok(s.wholesalers.some((x) => x.phone === '9812345673'));
});

test('supplier: a customer of that name with no entries is converted; with entries the owner confirms first', () => {
  let s = shop();
  const c = khataCustomer(s, 'Ramesh', '9812345674');
  let r = owner(s, 'Ramesh ko supplier banao, wo doodh deta hai');
  assert.ok(!s.customers.some((x) => x.id === c.id), 'no entries: no longer a customer');
  let w = s.wholesalers.find((x) => x.name === 'Ramesh');
  assert.strictEqual(w.phone, '9812345674', 'his number comes along');
  assert.match(r.ownerText, /grahak ki list se hata kar supplier bana diya/);

  s = shop();
  const d = khataCustomer(s, 'Ramesh', '9812345675');
  owe(s, d, 200);
  r = owner(s, 'Ramesh ko supplier banao, wo doodh deta hai');
  assert.match(r.ownerText, /Ramesh aapke grahak hain: khate mein 1 entry, baaki ₹200\. Inhe supplier banaun\?[^]*haan/);
  assert.ok(!s.wholesalers.some((x) => x.name === 'Ramesh'), 'nothing made before the owner says haan');
  r = owner(s, 'nahi');
  assert.ok(!s.wholesalers.some((x) => x.name === 'Ramesh'));
  assert.match(r.ownerText, /grahak hi rahenge/);
  owner(s, 'Ramesh ko supplier banao, wo doodh deta hai');
  r = owner(s, 'haan');
  w = s.wholesalers.find((x) => x.name === 'Ramesh');
  assert.ok(w, r.ownerText);
  assert.strictEqual(w.phone, '9812345675');
  assert.ok(s.customers.some((x) => x.id === d.id), 'the customer khata stays');
  assert.strictEqual(C.balance(s, d.id), 200);
});

test('supplier: words that are not a supplier request are not one', () => {
  const s = shop();
  for (const t of ['Ramesh ne 200 ka saman liya', 'Ramesh ka hisaab', 'supplier list', 'Ramesh supplier nahi hai']) {
    assert.strictEqual(C.makeSupplierIntent(s, t), null, t);
  }
});

// ------------------------------------------------------------------ 3. cash cap, bare "baki?"
test('cash: a claim above the baaki is asked back, never noted as said; the ₹1 lakh cap stays', () => {
  const s = shop(), c = khataCustomer(s);
  owe(s, c, 60);
  let r = say(s, c, '5000000 cash de diya');
  assert.ok(!(s.cashClaims || []).some((k) => k.custId === c.id), 'no ₹50 lakh claim');
  assert.strictEqual(r.cust[0].kind, 'cash-ask');
  assert.match(r.custText, /bahut badi raqam/);
  r = say(s, c, 'haan');
  assert.ok(!(s.cashClaims || []).some((k) => k.custId === c.id), 'haan does not confirm a past-the-cap amount');
  r = say(s, c, '60');
  const k = s.cashClaims.find((x) => x.custId === c.id && x.status === 'pending');
  assert.strictEqual(k.amount, 60);
  assert.match(r.custText, /₹60 cash note kar liya/);
});

test('cash: above the baaki the customer confirms the amount; the owner checks it before anything is written', () => {
  for (const [said, confirm] of [['100 cash de diya', 'haan'], ['मैंने ₹100 दे दिए', '100'], ['maine 100 cash diye', 'maine 100 de diye']]) {
    const s = shop(), c = khataCustomer(s);
    owe(s, c, 60);
    let r = say(s, c, said);
    assert.match(r.custText, /Aapne ₹100 cash likha, par aapka baaki sirf ₹60 hai/, said + ': ' + r.custText);
    assert.ok(!(s.cashClaims || []).some((x) => x.custId === c.id));
    const txns = s.txns.length;
    r = say(s, c, confirm);
    const k = s.cashClaims.find((x) => x.custId === c.id);
    assert.strictEqual(k.amount, 100, said);
    assert.strictEqual(k.over, 60);
    assert.strictEqual(k.status, 'pending');
    assert.strictEqual(s.txns.length, txns, 'nothing written before the owner');
    assert.match(r.ownerText, /keh rahe hain ₹100 cash diye, par khate mein baaki sirf ₹60 tha/);
    C.runAction(s, 'confirm', { claimId: k.id, ok: true });
    assert.strictEqual(C.balance(s, c.id), -40, 'the owner\'s ✅ writes it, the rest is advance');
  }
});

test('cash: "poora" or the baaki itself after the ask notes the baaki; within the baaki nothing is asked', () => {
  let s = shop(), c = khataCustomer(s);
  owe(s, c, 60);
  say(s, c, '600 cash de diya');
  say(s, c, 'poora');
  assert.strictEqual(s.cashClaims.find((x) => x.custId === c.id).amount, 60);
  s = shop(); c = khataCustomer(s);
  owe(s, c, 60);
  const r = say(s, c, '40 cash de diya');
  assert.match(r.custText, /₹40 cash note kar liya/);
});

test('balance: a bare "baki?" / "baaki?" / "बाकी?" is a balance question', () => {
  for (const t of ['baki?', 'baaki?', 'बाकी?', 'Baki', 'baaki hai?', 'बाकी कितना', 'mera baki?']) {
    const s = shop(), c = khataCustomer(s);
    owe(s, c, 60);
    const r = say(s, c, t);
    assert.strictEqual(r.cust[0] && r.cust[0].kind, 'statement', t + ': ' + r.custText);
    assert.match(r.custText, /₹60 baaki/, t);
    // the AI reading something else does not change it
    const s2 = shop(), c2 = khataCustomer(s2);
    owe(s2, c2, 60);
    const r2 = say(s2, c2, t, { intent: 'question', method: '', amount: null, parser: 'llm' });
    assert.strictEqual(r2.cust[0] && r2.cust[0].kind, 'statement', t + ' (AI: question)');
  }
  const s = shop(), c = khataCustomer(s);
  assert.notStrictEqual(say(s, c, 'baki 200 de diye').cust[0].kind, 'statement', 'a payment with "baki" is not a question');
});

test('supplier: the AI router decides (#45): its "supplier" / "add_customer" reading makes one, an "udhaar" reading does not', () => {
  const ai = (llmIntent) => ({ intent: llmIntent === 'udhaar' ? 'credit' : 'set_phone', llmIntent, parser: 'llm', confidence: 0.9 });
  for (const [route, made] of [['supplier', true], ['add_customer', true], ['udhaar', false]]) {
    const s = shop();
    C.runAction(s, 'owner', { text: 'Ramesh ko supplier banao 9812345676', intent: ai(route) });
    assert.strictEqual(s.wholesalers.some((x) => x.name === 'Ramesh'), made, route);
  }
});
