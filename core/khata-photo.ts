// Reading a photo of the shop's paper khata (the copy). The vision model only reads; this file decides what its answer
// means, and nothing here writes the khata. The owner reviews the rows on the dashboard and adds the ones he agrees
// with; each one then goes through the normal owner path ("Sharma ji 340 udhaar"), so the usual checks apply and the
// customer still gets Haan / Galat.
//
// A real copy is not a list of lines: each page is a grid of blocks, one per customer (name on top, items and amounts
// below, a circled total), and a block crossed out with a big X has been paid. So the model returns blocks.
import C = require('./agent-core');
import type { State } from './types';

export const KHATA_PHOTO_PROMPT =
  'You read photos of an Indian kirana shop\'s handwritten credit book (khata). Writing may be Marathi, Hindi, English or\n' +
  'mixed (Hinglish), in Devanagari or Latin letters, often messy, with crossings, arrows and running sums.\n' +
  'Each page is split into blocks, one per customer: a name at the top, then items with amounts, then a total that is\n' +
  'often circled or underlined. A block crossed out with a large X or lines through it means it was PAID.\n' +
  'Return ONLY a JSON object, no prose:\n' +
  '{"page_date": "DD/MM/YY or null", "blocks": [{"name": "name as written, in Latin letters", "name_as_written": "original script",\n' +
  '  "items": [{"text": "item", "amount": number or null}], "total": number or null, "struck": true or false,\n' +
  '  "confidence": 0 to 1}]}\n' +
  'Rules: one entry per block, in reading order. Never guess a number you cannot read: use null and lower the confidence.\n' +
  'total is the block\'s final amount owed (the circled or last sum), not an item. struck is true only if the block is crossed\n' +
  'out. Use Western digits (convert Devanagari digits). Do not invent blocks for headers, dates or page numbers.';

export interface PhotoItem { text: string; amount: number | null }
export interface PhotoBlock { name: string; written: string; items: PhotoItem[]; total: number | null; struck: boolean; confidence: number }
export interface PhotoRead { pageDate: string | null; blocks: PhotoBlock[] }
export interface ReviewedBlock extends PhotoBlock {
  /** open = still owed and clean; paid = crossed out (skipped); check = the owner must look before adding */
  status: 'open' | 'paid' | 'check';
  reasons: string[];
  match: { id: string; name: string; balance: number } | null;
  lookAlike: { id: string; name: string }[];
  /** what the dashboard sends as the owner's message when the owner adds this block */
  ownerText: string | null;
}
export interface PhotoReview { pageDate: string | null; blocks: ReviewedBlock[]; open: number; paid: number; check: number; openTotal: number }

const MAX_AMOUNT = 200000; // one customer's udhaar above two lakh is a misread, not a kirana balance
const MIN_CONFIDENCE = 0.6;

function money(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[₹,\s/-]+$/g, '').replace(/[₹,\s]/g, '').replace(/[०-९]/g, (d) => String('०१२३४५६७८९'.indexOf(d))));
  return Number.isFinite(n) && n > 0 && n <= MAX_AMOUNT ? Math.round(n) : null;
}
const text = (v: unknown, max: number) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/** The model's JSON, cleaned: wrong types dropped, at most 60 blocks and 30 items a block. Throws when there are no blocks. */
function normalizePhoto(j: any): PhotoRead {
  if (!j || typeof j !== 'object' || !Array.isArray(j.blocks)) throw new Error('no blocks in the answer');
  const blocks: PhotoBlock[] = j.blocks.slice(0, 60).filter((b: any) => b && typeof b === 'object').map((b: any) => ({
    name: text(b.name, 60),
    written: text(b.name_as_written || b.name, 60),
    items: (Array.isArray(b.items) ? b.items : []).slice(0, 30).filter((i: any) => i && typeof i === 'object').map((i: any) => ({ text: text(i.text, 60), amount: money(i.amount) })),
    total: money(b.total),
    struck: b.struck === true || b.struck === 'true',
    confidence: Math.max(0, Math.min(1, Number(b.confidence) || 0))
  }));
  const pd = text(j.page_date, 12);
  return { pageDate: /^\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?$/.test(pd) ? pd : null, blocks };
}

/** What each block means for this shop. Pure: reads the khata, never writes it. */
function reviewPhoto(state: State, read: PhotoRead): PhotoReview {
  const blocks: ReviewedBlock[] = read.blocks.map((b) => {
    const reasons: string[] = [];
    let status: ReviewedBlock['status'] = 'open';
    if (b.struck) { status = 'paid'; reasons.push('crossed out: paid'); }
    const amounts = b.items.map((i) => i.amount).filter((a): a is number => a != null);
    const sum = amounts.reduce((s, a) => s + a, 0);
    if (!b.name) reasons.push('name not readable');
    if (b.total == null) reasons.push('total not readable');
    if (b.total != null && amounts.length >= 2 && sum !== b.total) reasons.push('items add up to ₹' + sum + ', total says ₹' + b.total);
    if (b.confidence < MIN_CONFIDENCE) reasons.push('hard to read');
    const key = C.tokenize(b.name).norm.join(' ');
    const found = b.name ? C.findCustomers(state, key).filter((c) => !c.removed) : [];
    const match = found.length === 1 ? { id: found[0].id, name: found[0].name, balance: C.balance(state, found[0].id) } : null;
    const lookAlike = found.length > 1 ? found.map((c) => ({ id: c.id, name: c.name })) : [];
    if (lookAlike.length) reasons.push('looks like ' + lookAlike.length + ' customers');
    if (!match && !lookAlike.length && b.name) reasons.push('new customer');
    if (status !== 'paid' && reasons.some((r) => r !== 'new customer')) status = 'check';
    const ownerText = status === 'paid' || b.total == null || !b.name ? null : (match ? match.name : b.name) + ' ' + b.total + ' udhaar';
    return Object.assign({}, b, { status, reasons, match, lookAlike, ownerText });
  });
  const count = (s: ReviewedBlock['status']) => blocks.filter((b) => b.status === s).length;
  const openTotal = blocks.filter((b) => b.status === 'open').reduce((s, b) => s + (b.total || 0), 0);
  return { pageDate: read.pageDate, blocks, open: count('open'), paid: count('paid'), check: count('check'), openTotal };
}

export { normalizePhoto, reviewPhoto, money };
