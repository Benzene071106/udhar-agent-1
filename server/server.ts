// Udhaar Agent: one shop's agent as a small web server. Zero dependencies (Node 18+).
// One instance = one shop. On Agent37 each shop gets its own sandbox running this file on port 8000.
//
// Environment:
//   PORT                   default 8000
//   SHOP                   demo shop to seed: gupta | balaji | nayi (empty khata) (default gupta)
//   DATA_DIR               where the shop's khata is saved (default ./data)
//   DATABASE_URL, STORE    optional PostgreSQL: STORE=pg-schema (one schema per shop), STORE=pg-tables (shared normalised tables) or unset (one jsonb row); see docs/POSTGRES.md
//   DUAL_WRITE_JSON        1 = with a database, also write the JSON file on every save (backup); if the database is
//                          unreachable at start the server runs on the JSON file instead of starting empty
//   AGENT37_LLM_PROXY_URL  OpenAI-compatible LLM router; Agent37 sets this on every instance
//   AGENT37_MANAGED_TOKEN  bearer token for that router; Agent37 sets it and renews it on restart
//   LLM_MODEL              optional model id for the router; unset = the router's default model
//   LLM_TIMEOUT_MS         default 8000; after this the offline rules answer instead
//   LLM_BASE_URL, LLM_API_KEY, LLM_BASE_TIMEOUT_MS, ROUTER_MODEL, LLM_JSON_MODE
//                          optional first model (any OpenAI-compatible endpoint, e.g. an open-source model on vLLM);
//                          with LLM_BASE_URL set, LLM_MODEL is that endpoint's model and the router is the fallback: see server/llm.js
//   REAL_CLOCK             1 = the agent's own scheduler: each new calendar day it runs the morning reminders,
//                          and at EVENING_HOUR (default 21) it sends the evening summary and cash batch
//   SHOP_CITY              optional: the shop's town for the AI's context (e.g. Nagpur); kept in the saved khata
//   OTHER_SHOPS            optional "Name|https://url,Name|https://url" for the shop switcher
//   OWNER_WHATSAPP, PUBLIC_URL, STT_*   real WhatsApp and voice notes: see server/whatsapp.ts
//   WA_PROVIDER            web (the only one, and the default): a linked device on the shop's ordinary number, see
//                          server/wa-web.ts. An old value (twilio, meta) logs a warning and web is used.
//   LINK_KEY               the secret for GET /link?key=..., where the shop's WhatsApp number is linked by QR
//   ACT_LIMIT_PER_MIN      default 30: /api/act calls per minute per visitor IP (the public demo URL is open to anyone)
//   ADMIN_KEY              optional: on a live shop (REAL_CLOCK=1) "reset", "next day" and "close day" from the public page
//                          need the header x-admin-key with this value; calls from the instance itself always work
//   TAX_ID_KEY             optional secret: the shop's GSTIN / PAN is stored encrypted with it (AES-256-GCM); unset = stored
//                          as is in the owner file / table (only ever shown masked). See server/auth.ts
//   SESSION_DAYS, OWNER_MAX_FAILS, OWNER_LOCK_MIN   owner login: session length (7 days), wrong tries before a lock (5),
//                          lock length in minutes (15). The first owner account needs ADMIN_KEY.
//                          "reset", "next day" and "close day" are refused on a live shop for everyone (KAN-101, KAN-102)
//   AI_TEST_MAX_CASES, AI_TEST_MAX_FIXED, AI_TEST_MAX_PER_HOUR  /test-run on the AI: AI-written cases per run (20), hand-checked
//                          cases per run (40) and runs per hour (6); see server/ai-test.ts
//   REGISTER_LIMIT_PER_HOUR default 5: new-shop registrations per hour per visitor IP (POST /api/auth/register)
//   WA_MAX_SHOPS           default 10: registered shops that may have their own WhatsApp number linked at the same time
//                          (one linked-device session each, keys in <WA_WEB_AUTH_DIR>-shops/<shopId>); the instance's own
//                          shop keeps its session in WA_WEB_AUTH_DIR as before and is not counted
//   VISION_URL, VISION_KEY, VISION_MODEL, VISION_TIMEOUT_MS   optional: read a photo of the paper khata (POST /api/khata-photo)
//                          with any OpenAI-compatible vision endpoint, e.g. Gemma 4 31B; see server/vision.ts
//   PHOTO_LIMIT_PER_MIN    default 6: khata photos per minute per visitor IP
//   UDHAAR_ENV_FILE        optional KEY=value file read once at startup (default /home/node/udhaar.env).
//                          Agent37 cannot pass env vars to an instance, so keys go in this file instead.
//                          A variable already set in the real environment wins over the file.
//
// Without the LLM variables, or when the LLM call fails, the offline Hinglish rule parser answers.
import http = require('http');
import fs = require('fs');
import path = require('path');
import C = require('../core/agent-core');
import { createWhatsapp } from './whatsapp';
import { createWebTransport } from './wa-web';
import { createBrain } from './brain';
import { createVision, IMAGE_TYPES, MAX_IMAGE_BYTES } from './vision';
import { reviewPhoto } from '../core/khata-photo';
import { createAiTest } from './ai-test';
import { createFileStore, openStore } from './store';
import { createAuth, createFileAuthStore, openAuthStore, normPhone } from './auth';
import type { AuthStore, Auth } from './auth';
import type { State } from '../core/types';
import type { Store } from './store';
import type { Whatsapp } from './whatsapp';
import type { WebTransport, WebTransportOpts } from './wa-web';
import type { Brain, BrainOpts } from './brain';
import { createFileRegistry, openRegistry, newShopId, validShopId } from './shops';
import type { Registry } from './shops';

type Env = Record<string, string | undefined>;
export interface ServerOpts {
  env?: Env;
  fetch?: BrainOpts['fetch'] & Parameters<typeof createWhatsapp>[0]['fetch'];
  today?: () => string;
  hour?: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  store?: Store;
  authStore?: AuthStore;
  webTransport?: (o: WebTransportOpts) => WebTransport;
  waWebLib?: unknown;
  /** the self-registered shops (default: data/shops.registry.json) */
  registry?: Registry;
  /** opens a self-registered shop's khata and owner-login stores (default: JSON files in DATA_DIR) */
  openShop?: (shopId: string) => Promise<{ store: Store; authStore: AuthStore }>;
}
type Snapshot = Record<string, unknown>;
/** The http server plus the handles tests and the scheduler use. */
export type UdhaarServer = http.Server & {
  tick: () => Promise<string[]>;
  getState: () => State;
  engine: { llm: boolean; model: string; readonly lastError: string | null; readonly llmCalls: number; readonly llmFallbacks: number };
  brain: Brain;
  whatsapp: Whatsapp;
  web: WebTransport | null;
  store: Store;
  auth: Auth;
  registry: Registry;
  /** a self-registered shop's runtime (opened on first use) */
  shop: (id: string) => Promise<Tenant | null>;
  idle: () => Promise<unknown>;
};
/** An error carrying the HTTP status to answer with. */
type HttpError = Error & { code?: number };
/** A self-registered shop: its own khata, owner login, brain, action queue and (once linked) its own WhatsApp number. */
export interface Tenant {
  id: string; store: Store; authStore: AuthStore; auth: Auth; brain: Brain;
  state: State; save(): void; serial<R>(fn: () => R | Promise<R>): Promise<R>;
  web: WebTransport | null; wa: Whatsapp | null; authDir: string;
}

// compiled to dist-server/server/, two levels below the repo root
const ROOT = path.join(__dirname, '..', '..');
const MAX_BODY = 16 * 1024;
const PHOTO_BODY = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4096; // one base64 photo of up to 8 MB in a JSON body

function localToday() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function parseOtherShops(v: unknown): { name: string; url: string }[] {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [name, url] = s.split('|').map((x) => (x || '').trim());
    return /^https?:\/\//.test(url || '') ? { name, url } : null;
  }).filter(Boolean) as { name: string; url: string }[];
}

function createServer(opts?: ServerOpts | null): UdhaarServer {
  opts = opts || {};
  const env: Env = opts.env || process.env;
  const shopId: string = C.DEMO_SHOPS[env.SHOP!] ? env.SHOP! : 'gupta';
  C.FEATURES.vouch = env.FEATURE_VOUCH === '1'; // naye log (vouching) is off for now
  const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
  const others = parseOtherShops(env.OTHER_SHOPS);
  // globalThis.fetch has the shape the brain and WhatsApp code use; its DOM-style types differ only in detail
  const fetchImpl = opts.fetch || (globalThis.fetch as any);
  const today = opts.today || localToday;

  const store: Store = opts.store || createFileStore(dataDir, shopId);
  let state: State = store.load()!;
  if (!state || !state.shop) { state = C.freshShop(shopId, today()); save(); }
  // a khata saved before wholesalers existed gets the shop's demo wholesalers once; nothing else in it changes
  if (!state.wsSeeded) { const added = C.seedWholesalers(state, shopId); state.wsSeeded = true; if (added.length) console.log('Added wholesalers: ' + added.join(', ')); save(); }
  if (env.SHOP_CITY && state.shop.city !== env.SHOP_CITY) { state.shop.city = String(env.SHOP_CITY).slice(0, 60); save(); } // the AI is told where the shop is

  function save() { store.save(state); }
  // owner login and the shop's GSTIN / PAN live in their own store, never in the khata the page, AI and WhatsApp see
  const authStore: AuthStore = opts.authStore || createFileAuthStore(dataDir, shopId);
  const auth = createAuth({ env, store: authStore, now: opts.now });

  // WhatsApp runs through a linked device (wa-web.ts) whenever it is set up at all: an owner number, a LINK_KEY for the
  // /link page, or a WA_PROVIDER line. Twilio and Meta are gone; an old WA_PROVIDER value is not fatal.
  if (env.WA_PROVIDER && env.WA_PROVIDER !== 'web') console.log('WA_PROVIDER=' + String(env.WA_PROVIDER).slice(0, 20) + ' is no longer supported; using web (linked device)');
  const webOn = !!(env.WA_PROVIDER || env.LINK_KEY || env.OWNER_WHATSAPP);
  let wa: Whatsapp = null!; // set right below; onMessage only runs after that
  const web = webOn ? (opts.webTransport || createWebTransport)({
    authDir: env.WA_WEB_AUTH_DIR || path.join(dataDir, 'wa-web-auth'), keepAlive: true, maxPerHour: +env.WA_WEB_MAX_PER_HOUR! || 30,
    loadLib: opts.waWebLib ? () => Promise.resolve(opts.waWebLib) : () => import('@whiskeysockets/baileys'),
    sleep: opts.sleep, now: opts.now,
    onMessage: (m) => {
      if (!wa.webReady) return; // linked, but no OWNER_WHATSAPP yet: the linked number's chats are left alone
      serial(() => wa.handleWeb(m, act, () => state, save)).then(() => save(), (e) => { wa.stats.lastError = String(e.message || e).slice(0, 200); });
    }
  }) : null;
  wa = createWhatsapp({ env, fetch: fetchImpl, getState: () => state, now: opts.now, web });

  // The model chain (LLM_BASE_URL first if set, then the Agent37 router, then the rules): see server/llm.js and server/brain.js.
  const brain = createBrain({ env, fetch: fetchImpl, getState: () => state });
  const vision = createVision({ env, fetch: fetchImpl }); // reads photos of the paper khata (VISION_URL); see server/vision.ts
  const llm = brain.llm;
  const engine = {
    llm: llm.enabled, model: llm.describe(),
    get lastError() { return llm.stats.lastError; }, get llmCalls() { return llm.stats.calls; }, get llmFallbacks() { return llm.stats.fallbacks; }
  };
  // /test-run's AI-generated cases: the same model chain writes messages, the real pipeline reads them on a throwaway shop
  const aiTest = createAiTest({ env, fetch: fetchImpl, today, now: opts.now });

  // What /healthz says is still to do for owner login and tax-id encryption: setup steps only, never a key (KAN-128)
  const ownerTodo = (): string[] => {
    const t: string[] = [];
    if (!auth.hasOwner()) t.push(env.ADMIN_KEY ? 'Owner login not set up: open the shop page, fill "Create owner login" with the ADMIN_KEY, the owner\'s mobile number and a password.' : 'Owner login not set up: put ADMIN_KEY=<a long secret> in ' + (env.UDHAAR_ENV_FILE || '/home/node/udhaar.env') + ', restart, then open the shop page and fill "Create owner login".');
    if (!auth.encryptionOn()) t.push('GSTIN / PAN are stored unencrypted: put TAX_ID_KEY=<a long random secret, kept safe> in ' + (env.UDHAAR_ENV_FILE || '/home/node/udhaar.env') + ' and restart. Losing it means saved tax ids cannot be read.');
    return t;
  };
  // What the page gets. The pay-link secret never leaves the server; on a live shop a public visitor also sees
  // customers' and wholesalers' numbers masked and no UPI ids (KAN-43).
  function publicState(full: boolean): State {
    const { paySecret, ...rest } = state as State & { paySecret?: string };
    void paySecret;
    if (full) return rest as State;
    // a visitor without the owner's key sees the shop, never who owes what (KAN-43): no names, balances, entries or chats
    const out: any = Object.assign({}, rest, { customers: [], txns: [], messages: [], log: [], pending: null, cashClaims: [], seenUpiRefs: [], lastAction: null, locked: true });
    for (const k of ['wholesalers', 'suppliers', 'supplies', 'supplierPays', 'wsOrders', 'ownerAsks', 'parkedAsks', 'orders']) if (Array.isArray(out[k])) out[k] = [];
    for (const k of ['consents', 'ownerPhone', 'waLastIn', 'waAsked', 'statementFor', 'lastWrite', 'rateSay']) delete out[k];
    return out;
  }
  // full = the owner (local or admin key), or any visitor of a demo shop; /api/act only answers those
  function snapshot(extra?: Snapshot, full = true): Snapshot {
    return Object.assign({
      state: publicState(full), dashboard: full ? C.dashboard(state, 30) : C.dashboard(publicState(false), 30), shopId, locked: !full, live: env.REAL_CLOCK === '1',
      engine: { llm: engine.llm, model: engine.model, lastError: engine.lastError, whatsapp: wa.stats.enabled },
      others
    }, extra || {});
  }

  function pageHtml() {
    const html = fs.readFileSync(path.join(ROOT, 'dist/udhaar-agent-standalone.html'), 'utf8');
    const cfg = '<script>window.UDHAAR_SERVER=' + JSON.stringify({ shopId, others }).replace(/</g, '\\u003c') + ';</script>';
    return html.replace('<body>', '<body>\n' + cfg);
  }

  function send(res: http.ServerResponse, code: number, body: unknown, type?: string) {
    const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(buf);
  }

  function readBody(req: http.IncomingMessage, max?: number): Promise<string> {
    max = max || MAX_BODY;
    return new Promise((resolve, reject) => {
      let size = 0; const chunks: Buffer[] = [];
      // Past the limit, keep draining (so the client still gets the 413) but stop keeping bytes.
      req.on('data', (c: Buffer) => { size += c.length; if (size <= max) chunks.push(c); });
      req.on('end', () => { if (size > max!) return reject(Object.assign(new Error('body too large'), { code: 413 })); resolve(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', reject);
    });
  }

  // One action at a time, so two quick taps can't interleave on the same khata.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<R>(fn: () => R | Promise<R>): Promise<R> { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; }

  async function act(action: string, args?: Record<string, unknown>): Promise<Snapshot> {
    if (action === 'reset') { state = C.freshShop(shopId, today()); save(); return snapshot({ freshTxn: null }); }
    if (C.ACTIONS.indexOf(action) < 0) throw Object.assign(new Error('unknown action'), { code: 400 });
    const a: Record<string, any> = Object.assign({}, args); // the browser's fields, checked by runAction
    delete a.intent; delete a.now; // never trust an intent (or a clock) from the browser
    const heard = typeof a.heard === 'string' && a.heard ? a.heard.slice(0, 500) : null; // a voice note's own words, in its own script
    delete a.heard;
    if (action === 'owner' && !C.looksLikeUpiSms(String(a.text || ''))) a.intent = await brain.understandOwner(String(a.text || '').slice(0, 500), { heard });
    if (action === 'customer' && a.text) { const ci = await brain.understandCustomer(String(a.text).slice(0, 500), String(a.custId || ''), { heard, source: a.source === 'voice' ? 'voice' : 'text' }); if (ci) a.intent = ci; }
    const from = state.messages.length;
    let out;
    try { out = C.runAction(state, action, a); } catch (e) { throw Object.assign(e as Error, { code: 400 }); }
    await brain.translateOut(state, from); // each customer reads the agent in their own language
    save();
    return snapshot({ freshTxn: out.freshTxn, result: out.result });
  }

  // A small per-visitor rate limit for the routes that change the khata or spend AI calls. The page itself stays open
  // (it is a public demo); this only stops one visitor from hammering the shop. Local calls (no proxy) are not limited.
  const limits: Record<string, number[]> = { '/api/act': [+env.ACT_LIMIT_PER_MIN! || 30, 60e3], '/api/ai-test': [3, 60e3], '/api/auth/login': [10, 60e3], '/api/auth/setup': [5, 60e3],
    '/api/auth/register': [+env.REGISTER_LIMIT_PER_HOUR! || 5, 3600e3], '/api/wa/connect': [10, 60e3],
    '/api/khata-photo': [+env.PHOTO_LIMIT_PER_MIN! || 6, 60e3] };
  const hits = new Map<string, number[]>();
  const local = (req: http.IncomingMessage) => !req.headers['x-forwarded-for'] && /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || '');
  const sameKey = (a: unknown, b: unknown) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b)); return x.length === y.length && (require('crypto') as typeof import('crypto')).timingSafeEqual(x, y); };
  const live = env.REAL_CLOCK === '1';
  const LIVE_BLOCKED: Record<string, string> = Object.assign(Object.create(null), {
    reset: 'Yeh asli dukaan ka khata hai: reset band hai, taaki saara udhaar ek click mein na mite.',
    nextDay: 'Asli dukaan mein din apne aap badalta hai (asli tareekh se). Subah ke reminder khud jaate hain.',
    closeDay: 'Asli dukaan mein shaam ka hisaab apne aap ' + (+env.EVENING_HOUR! || 21) + ' baje jaata hai.'
  });
  const keyOk = (req: http.IncomingMessage) => !!(env.ADMIN_KEY && sameKey(req.headers['x-admin-key'], env.ADMIN_KEY));
  // the owner: the instance itself, the ADMIN_KEY (the old ?key= link keeps working), or a logged-in owner session
  const ownerVia = (req: http.IncomingMessage): string | null => (local(req) ? 'local' : keyOk(req) ? 'key' : auth.sessionOwner(req.headers.cookie) ? 'session' : null);
  const isOwner = (req: http.IncomingMessage) => !!ownerVia(req);
  // a small JSON object body, or an error status to answer with
  async function jsonBody(req: http.IncomingMessage): Promise<{ body?: Record<string, any>; code?: number; error?: string }> {
    if (!/application\/json/.test(req.headers['content-type'] || '')) return { code: 415, error: 'send JSON' };
    if (+req.headers['content-length']! > MAX_BODY) return { code: 413, error: 'body too large' };
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e: any) { return { code: e.code === 413 ? 413 : 400, error: e.code === 413 ? 'body too large' : 'bad JSON' }; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { code: 400, error: 'send a JSON object' };
    return { body };
  }
  function authRoute(req: http.IncomingMessage, res: http.ServerResponse, out: { ok: boolean; code?: number; error?: string; cookie?: string } & Record<string, unknown>) {
    if (!out.ok) return send(res, out.code || 400, { error: out.error });
    const { cookie, ok, ...rest } = out;
    if (cookie) res.setHeader('set-cookie', cookie);
    return send(res, 200, Object.assign({ ok }, rest));
  }
  function limited(req: http.IncomingMessage, route: string) {
    // the rightmost x-forwarded-for hop is the one the hosting proxy added; the ones left of it are whatever the client sent (KAN-46)
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    const fwd = hops[hops.length - 1] || '';
    const ip = fwd || req.socket.remoteAddress || '';
    if (!fwd && /^(::1|127\.|::ffff:127\.)/.test(ip)) return false;
    const [max, windowMs] = limits[route], key = route + ' ' + ip, now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return true; }
    recent.push(now); hits.set(key, recent);
    if (hits.size > 5000) { // drop expired visitors only, so many fake addresses cannot reset everyone's budget
      for (const [k, ts] of hits) if (!ts.some((t) => now - t < windowMs)) hits.delete(k);
    }
    return false;
  }

  const evening = +env.EVENING_HOUR! || 21;
  const hourNow = opts.hour || (() => new Date().getHours());
  // ---------- self-registered shops (one owner account = one shop; the instance's own shop above is untouched) ----------
  // Each has its own khata, owner login, brain and action queue, and can link its own WhatsApp number: one linked-device
  // session per shop, keys in <WA_WEB_AUTH_DIR>-shops/<shopId>, capped at WA_MAX_SHOPS (default 10) at a time.
  const registry: Registry = opts.registry || createFileRegistry(dataDir);
  const openShopStores = opts.openShop || (async (id: string) => ({ store: createFileStore(dataDir, id) as Store, authStore: createFileAuthStore(dataDir, id) }));
  const tenants = new Map<string, Promise<Tenant | null>>();
  const waRoot = (env.WA_WEB_AUTH_DIR || path.join(dataDir, 'wa-web-auth')) + '-shops';
  const waMax = env.WA_MAX_SHOPS != null && env.WA_MAX_SHOPS !== '' ? Math.max(0, +env.WA_MAX_SHOPS || 0) : 10;
  const waActive = () => { let n = 0; for (const t of loaded.values()) if (t.web) n++; return n; };
  const loaded = new Map<string, Tenant>();

  function emptyShop(id: string, name: string, owner: string): State {
    const s = C.freshShop('nayi', today());
    const was = s.shop.name;
    Object.assign(s.shop, { id, name, owner, upiId: '', city: '' }); // the register form asks no city: never the demo shop's town (KAN-152)
    s.wsSeeded = true; // no demo wholesalers
    for (const m of s.messages) m.text = m.text.split(was).join(name).replace(/^Namaste Malik ji/, 'Namaste ' + (owner.split(' ')[0] || 'Malik') + ' ji');
    return s;
  }
  async function openTenant(id: string, fresh?: { name: string; owner: string }): Promise<Tenant | null> {
    if (!validShopId(id) || (!registry.has(id) && !fresh)) return null;
    const { store: st, authStore: as } = await openShopStores(id);
    let tstate = st.load()!;
    if (!tstate || !tstate.shop) { if (!fresh) { const a = registry.list().find((x) => x.id === id); fresh = { name: a ? a.name : 'Meri dukaan', owner: '' }; } tstate = emptyShop(id, fresh.name, fresh.owner); st.save(tstate); }
    let q: Promise<unknown> = Promise.resolve();
    const t: Tenant = {
      id, store: st, authStore: as, auth: createAuth({ env, store: as, now: opts!.now, tokenPrefix: id }),
      brain: null!, state: tstate, web: null, wa: null, authDir: path.join(waRoot, id),
      save() { t.store.save(t.state); },
      serial<R>(fn: () => R | Promise<R>): Promise<R> { const p = q.then(fn, fn); q = p.catch(() => {}); return p as Promise<R>; }
    };
    t.brain = createBrain({ env, fetch: fetchImpl, getState: () => t.state });
    loaded.set(id, t);
    // a shop whose number was linked before the restart reconnects on its own
    if (fs.existsSync(path.join(t.authDir, 'creds.json'))) waConnect(t);
    return t;
  }
  function tenant(id: string, fresh?: { name: string; owner: string }): Promise<Tenant | null> {
    if (!tenants.has(id)) { const p = openTenant(id, fresh).catch((e) => { tenants.delete(id); throw e; }); tenants.set(id, p); }
    return tenants.get(id)!;
  }
  /** The shop a request's session cookie belongs to (only a self-registered one), and its owner. */
  async function tenantOf(req: http.IncomingMessage): Promise<{ t: Tenant; owner: NonNullable<ReturnType<Auth['sessionOwner']>> } | null> {
    let tok = '';
    for (const part of String(req.headers.cookie || '').split(';')) { const [k, ...v] = part.trim().split('='); if (k === auth.COOKIE) tok = v.join('='); }
    const dot = tok.indexOf('.');
    if (dot < 0) return null;
    const id = tok.slice(0, dot);
    if (!registry.has(id)) return null;
    const t = await tenant(id);
    const owner = t && t.auth.sessionOwner(req.headers.cookie);
    return t && owner ? { t, owner } : null;
  }

  // a self-registered shop's WhatsApp: its own socket, its own owner number, its own khata. Nothing is shared with the
  // instance's shop or with any other shop: pay links and the join page stay with the instance's shop (no PUBLIC_URL here).
  function waConnect(t: Tenant): { ok: boolean; error?: string } {
    if (t.web) { t.web.start(); return { ok: true }; }
    if (waActive() >= waMax) return { ok: false, error: 'WhatsApp is linked for the most shops this server allows (' + waMax + '). Ask the admin to raise WA_MAX_SHOPS.' };
    const phone = t.auth.ownerPhone();
    const wenv: Env = Object.assign({}, env, { OWNER_WHATSAPP: phone ? '91' + phone : '', PUBLIC_URL: '', PAY_SECRET: '', WA_WEB_DISPLAY_NUMBER: '', WA_PROVIDER: 'web' });
    t.web = (opts!.webTransport || createWebTransport)({
      authDir: t.authDir, keepAlive: true, maxPerHour: +env.WA_WEB_MAX_PER_HOUR! || 30,
      loadLib: opts!.waWebLib ? () => Promise.resolve(opts!.waWebLib) : () => import('@whiskeysockets/baileys'),
      sleep: opts!.sleep, now: opts!.now,
      onMessage: (m) => {
        const w = t.wa;
        if (!w || !w.webReady) return;
        t.serial(() => w.handleWeb(m, (a, args) => tenantAct(t, a, args), () => t.state, () => t.save())).then(() => t.save(), (e) => { w.stats.lastError = String(e.message || e).slice(0, 200); });
      }
    });
    t.wa = createWhatsapp({ env: wenv, fetch: fetchImpl, getState: () => t.state, now: opts!.now, web: t.web });
    t.web.start();
    return { ok: true };
  }
  async function waDisconnect(t: Tenant) {
    const w = t.web;
    t.web = null; t.wa = null;
    if (w) { if (w.logout) await w.logout(); else w.stop(); }
    try { fs.rmSync(t.authDir, { recursive: true, force: true }); } catch (e) { /* already gone */ }
  }
  function waInfo(t: Tenant) {
    if (!t.web) return { connected: false, state: 'off', number: null, qrSvg: null, note: 'WhatsApp not connected yet. Use "Connect WhatsApp" to link your shop\'s own number.', slotsLeft: Math.max(0, waMax - waActive()) };
    const st = t.web.status(), qrText = t.web.qr();
    let qrSvg: string | null = null;
    if (st.state === 'qr' && qrText) { const qr = (require('../../vendor/qrcode-generator.js') as any)(0, 'L'); qr.addData(qrText); qr.make(); qrSvg = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true }); }
    return { connected: !!st.linked, state: st.state, number: st.number, qrSvg, lastError: st.lastError, note: st.linked ? null : 'WhatsApp not connected yet. Scan the QR with your shop phone: WhatsApp → Linked devices → Link a device.', slotsLeft: Math.max(0, waMax - waActive()) };
  }

  async function tenantAct(t: Tenant, action: string, args?: Record<string, unknown>): Promise<Snapshot> {
    if (action === 'reset') { t.state = emptyShop(t.id, t.state.shop.name, t.state.shop.owner || ''); t.save(); return tenantSnap(t, { freshTxn: null }); }
    if (C.ACTIONS.indexOf(action) < 0) throw Object.assign(new Error('unknown action'), { code: 400 });
    const a: Record<string, any> = Object.assign({}, args);
    delete a.intent; delete a.now;
    const heard = typeof a.heard === 'string' && a.heard ? a.heard.slice(0, 500) : null;
    delete a.heard;
    if (action === 'owner' && !C.looksLikeUpiSms(String(a.text || ''))) a.intent = await t.brain.understandOwner(String(a.text || '').slice(0, 500), { heard });
    if (action === 'customer' && a.text) { const ci = await t.brain.understandCustomer(String(a.text).slice(0, 500), String(a.custId || ''), { heard, source: a.source === 'voice' ? 'voice' : 'text' }); if (ci) a.intent = ci; }
    const from = t.state.messages.length;
    let out;
    try { out = C.runAction(t.state, action, a); } catch (e) { throw Object.assign(e as Error, { code: 400 }); }
    await t.brain.translateOut(t.state, from);
    t.save();
    return tenantSnap(t, { freshTxn: out.freshTxn, result: out.result });
  }
  function tenantSnap(t: Tenant, extra?: Snapshot): Snapshot {
    const { paySecret, ...rest } = t.state as State & { paySecret?: string };
    void paySecret;
    return Object.assign({ state: rest, dashboard: C.dashboard(t.state, 30), shopId: t.id, locked: false, live, own: true,
      engine: { llm: engine.llm, model: engine.model, lastError: null, whatsapp: !!(t.wa && t.wa.stats.enabled) }, whatsapp: waInfo(t), others: [] }, extra || {});
  }
  // a new shop's day follows the real calendar the same way (no WhatsApp unless it linked its own number)
  function tickTenants() {
    return Promise.all(Array.from(loaded.values()).map((t) => t.serial(async () => {
      const now = today(), from = t.state.messages.length; let ran = false;
      for (let i = 0; i < 31 && t.state.today < now; i++) { C.runAction(t.state, 'nextDay'); ran = true; }
      if (hourNow() >= evening && t.state.eveningSentFor !== t.state.today && t.state.today === now) { C.runAction(t.state, 'closeDay'); ran = true; }
      if (ran) { await t.brain.translateOut(t.state, from); if (t.wa) t.wa.deliver(t.state, from); t.save(); }
    })));
  }

  /** The routes a self-registered shop's owner uses; null = not one of them. Every one works on that shop only. */
  async function tenantRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, t: Tenant, owner: NonNullable<ReturnType<Auth['sessionOwner']>>): Promise<unknown> {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/state') return send(res, 200, tenantSnap(t));
    if (req.method === 'GET' && p === '/api/auth/status')
      return send(res, 200, { hasOwner: true, owner: true, via: 'session', live, adminKeySet: false, name: owner.name, shopId: t.id, profile: t.auth.profile(), taxIdEncryption: t.auth.encryptionOn() });
    if (req.method === 'GET' && p === '/api/profile') return send(res, 200, { profile: t.auth.profile() });
    if (req.method === 'GET' && p === '/api/wa/status') return send(res, 200, waInfo(t));
    if (req.method !== 'POST' || !(p === '/api/act' || p === '/api/profile' || p.startsWith('/api/auth/') || p.startsWith('/api/wa/'))) return null;
    if (p === '/api/auth/login' || p === '/api/auth/register') return null; // logging in as someone else from the entry page
    const j = await jsonBody(req);
    if (!j.body) { if (j.code === 413) res.setHeader('connection', 'close'); return send(res, j.code!, { error: j.error }); }
    const b = j.body;
    if (p === '/api/auth/logout') { t.auth.logout(req.headers.cookie); res.setHeader('set-cookie', auth.clearCookie()); return send(res, 200, { ok: true }); }
    if (p === '/api/auth/password') return authRoute(req, res, t.auth.changePassword(owner, b));
    if (p === '/api/auth/setup') return send(res, 409, { error: 'This shop already has an owner.' });
    if (p === '/api/wa/connect') { const r = waConnect(t); return r.ok ? send(res, 200, Object.assign({ ok: true }, waInfo(t))) : send(res, 409, { error: r.error }); }
    if (p === '/api/wa/disconnect') { await waDisconnect(t); return send(res, 200, Object.assign({ ok: true }, waInfo(t))); }
    if (p === '/api/profile') {
      const upi = 'upiId' in b ? (String(b.upiId || '').trim() ? C.validUpi(b.upiId) : '') : null;
      if (upi === null && 'upiId' in b) return send(res, 400, { error: 'UPI ID should look like name@bank, for example yourname@okaxis (demo IDs are not allowed)' });
      const out = t.auth.saveProfile(b);
      if (out.ok && out.profile) await t.serial(() => { t.state.shop.name = out.profile!.shopName; t.state.shop.owner = out.profile!.ownerName; if (upi != null) t.state.shop.upiId = upi; t.save(); });
      return authRoute(req, res, Object.assign(out, { upiId: C.shopUpi(t.state) }));
    }
    if (p === '/api/act') {
      const action = String(typeof b.action === 'string' ? b.action : '');
      const args = b.args && typeof b.args === 'object' && !Array.isArray(b.args) ? b.args : {};
      if ('text' in args && typeof args.text !== 'string') return send(res, 400, { error: 'text must be a string' });
      if (live && LIVE_BLOCKED[action]) return send(res, 403, { error: 'live', message: LIVE_BLOCKED[action] });
      const out = await t.serial(async () => {
        const from = t.state.messages.length, before = t.state;
        const r = await tenantAct(t, action, args);
        if (t.wa && t.state === before) { t.wa.deliver(t.state, from, null, { skipOwner: true }); t.save(); }
        return r;
      });
      return send(res, 200, out);
    }
    return send(res, 404, { error: 'not found' });
  }

  /** Register a new shop: a brand-new empty khata with this owner as its only login. */
  async function register(req: http.IncomingMessage, res: http.ServerResponse) {
    const j = await jsonBody(req);
    if (!j.body) return send(res, j.code!, { error: j.error });
    const b = j.body;
    const phone = normPhone(b.phone);
    if (phone && (registry.byPhone(phone) || auth.ownerPhones().includes(phone))) return send(res, 409, { error: 'This mobile number already has a shop. Please log in.' });
    // validate everything before anything is created
    const { createAuth: mk } = require('./auth') as typeof import('./auth');
    const dry = mk({ env, store: { kind: 'mem', load: () => ({ owners: [], sessions: [], profile: null }), save() {}, flush: () => Promise.resolve(), close: () => Promise.resolve() } });
    const check = dry.register(b);
    if (!check.ok) return send(res, check.code, { error: check.error });
    const id = newShopId();
    const name = String(b.shopName).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80), owner = String(b.ownerName).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
    try { await registry.add({ id, phone: phone!, name, createdAt: new Date((opts!.now || Date.now)()).toISOString() }); }
    catch (e: any) { return e && e.code === 409 ? send(res, 409, { error: 'This mobile number already has a shop. Please log in.' }) : send(res, 503, { error: 'Could not create the shop right now (the database is not reachable). Please try again in a minute.' }); }
    const t = await tenant(id, { name, owner });
    if (!t) return send(res, 500, { error: 'server error' });
    const out = t.auth.register(b);
    await t.store.flush(); await t.authStore.flush();
    return authRoute(req, res, Object.assign(out, { shopId: id }));
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://x');
      if (req.method === 'HEAD' && (url.pathname === '/' || url.pathname === '/healthz')) { res.writeHead(200, { 'cache-control': 'no-store' }); return res.end(); }
      if (req.method === 'POST' && limits[url.pathname] && limited(req, url.pathname)) return send(res, 429, { error: 'too many requests, try again in a minute' });
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, pageHtml(), 'text/html; charset=utf-8');
      // the live test run: runs the cases in the visitor's browser on a throwaway demo shop; this shop's khata is never sent
      if (req.method === 'GET' && (url.pathname === '/test-run' || url.pathname === '/test-run.html')) return send(res, 200, fs.readFileSync(path.join(ROOT, 'dist/test-run.html'), 'utf8'), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/ai-test') return send(res, 200, { enabled: aiTest.enabled, chain: aiTest.describe(), maxCases: aiTest.maxCases, maxFixed: aiTest.maxFixed });
      // never touches this shop's khata and never sends a WhatsApp message: every case runs on its own fresh in-memory
      // demo shop (server/ai-test.ts). mode "fixed" = the hand-checked cases on the AI, else cases the AI writes.
      // stream: one JSON line per event ({type:"start"}, {type:"case"}, then {type:"done"}), so the page fills in live.
      if (req.method === 'POST' && url.pathname === '/api/ai-test') {
        const j = await jsonBody(req);
        const b = j.body;
        if (!b) return send(res, j.code!, { error: j.error });
        const go = (ro?: Parameters<typeof aiTest.run>[1]) => (b.mode === 'fixed' ? aiTest.runFixed(b.count, ro) : aiTest.run(b.count, ro));
        if (!b.stream) return send(res, 200, await go());
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' });
        const line = (o: unknown) => { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); };
        const done = await go({ onStart: (info) => line(Object.assign({ type: 'start' }, info)), onCase: (r, i, n) => line({ type: 'case', i, n, result: r }) });
        line(Object.assign({}, done, { type: 'done', results: undefined }));
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, shop: shopId, llm: engine.llm, scheduler: env.REAL_CLOCK === '1', llmCalls: engine.llmCalls, llmFallbacks: engine.llmFallbacks, ai: llm.health(), vision: vision.health(),
        owner: { store: authStore.kind, account: auth.hasOwner(), taxIdEncrypted: auth.encryptionOn(), todo: ownerTodo() },
        registry: registry.kind,
        storage: { kind: store.kind, dualWriteJson: !!store.dualWrite, fallback: store.fallback || null, lastError: store.lastError || null },
        whatsapp: { provider: wa.provider, enabled: wa.stats.enabled, sending: wa.stats.sending, voice: wa.stats.stt, voiceProvider: wa.stats.sttProvider || null, voiceNotes: wa.stats.voiceNotes, received: wa.stats.received, sent: wa.stats.sent, failed: wa.stats.failed, lastError: wa.stats.lastError,
          web: web ? web.status() : null } });
      if (req.method === 'GET' && url.pathname === '/link') {
        // the shop number's QR: whoever sees it can link the number, so the key is required and checked in constant time
        if (!env.LINK_KEY || !web || !sameKey(url.searchParams.get('key'), env.LINK_KEY)) return send(res, 403, { error: 'forbidden' });
        await web.start();
        res.setHeader('referrer-policy', 'no-referrer');
        return send(res, 200, linkPage(web, state), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname.startsWith('/pay/')) {
        let ref = '';
        try { ref = decodeURIComponent(url.pathname.slice(5)); } catch (e) { return send(res, 404, { error: 'not found' }); }
        const hadSecret = !!state.paySecret;
        const html = wa.payPage(state, ref, url.searchParams);
        if (!hadSecret && state.paySecret) save(); // keeps the pay-link secret once made
        res.setHeader('referrer-policy', 'no-referrer'); // the link's secret stays out of other sites' logs
        return html ? send(res, 200, html, 'text/html; charset=utf-8') : send(res, 404, { error: 'not found' });
      }
      if (req.method === 'GET' && url.pathname === '/join') {
        const html = wa.joinPage(state);
        return html ? send(res, 200, html, 'text/html; charset=utf-8') : send(res, 404, { error: 'not found' });
      }
      // a photo of the paper khata: read by the vision model, checked against the shop's customers and shown to the owner.
      // Nothing is written here: the owner adds the blocks he agrees with from the dashboard, through the normal owner
      // path, so the usual checks run and each customer still gets Haan / Galat (server/vision.ts, core/khata-photo.ts).
      if (url.pathname === '/api/khata-photo') {
        if (req.method === 'GET') return send(res, 200, { enabled: vision.enabled, model: vision.model });
        if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
        const ten = await tenantOf(req);
        const st = ten ? ten.t.state : !live || isOwner(req) ? state : null;
        if (!st) return send(res, 403, { error: 'locked', message: 'Copy ki photo sirf dukaan ke maalik bhej sakte hain: pehle login kijiye.' });
        if (!vision.enabled) return send(res, 503, { error: 'Photo reading is not set up on this shop yet (VISION_URL).' });
        if (!/application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'send JSON' });
        if (+req.headers['content-length']! > PHOTO_BODY) { res.setHeader('connection', 'close'); return send(res, 413, { error: 'photo larger than 8 MB' }); }
        let body;
        try { body = JSON.parse(await readBody(req, PHOTO_BODY) || '{}'); } catch (e: any) { return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'photo larger than 8 MB' : 'bad JSON' }); }
        const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String((body && body.image) || ''));
        if (!m || !IMAGE_TYPES.includes(m[1])) return send(res, 400, { error: 'send the photo as a JPEG, PNG or WebP data URL in "image"' });
        try {
          const read = await vision.readPage(Buffer.from(m[2], 'base64'), m[1]);
          return send(res, 200, Object.assign(reviewPhoto(st, read), { model: read.model, ms: read.ms }));
        } catch (e: any) { return send(res, 502, { error: 'Could not read the photo: ' + e.message }); }
      }
      // a self-registered shop's owner: everything below works on that shop only, never on this instance's shop
      if (url.pathname.startsWith('/api/')) {
        const ten = await tenantOf(req);
        if (ten) { const done = await tenantRoute(req, res, url, ten.t, ten.owner); if (done !== null) return done; }
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/register') return register(req, res);
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        // an owner of a self-registered shop logs into that shop; every other number is the instance's own shop as before
        const j = await jsonBody(req);
        if (!j.body) return send(res, j.code!, { error: j.error });
        const acct = registry.byPhone(normPhone(j.body.phone) || '');
        const t = acct ? await tenant(acct.id) : null;
        return authRoute(req, res, Object.assign((t ? t.auth : auth).login(j.body), t ? { shopId: t.id } : { shopId }));
      }
      if (url.pathname.startsWith('/api/wa/')) {
        // the instance's own number is linked on /link (LINK_KEY), never from here
        if (!isOwner(req)) return send(res, 403, { error: 'log in first' });
        return send(res, 200, { home: true, connected: !!(web && web.status().linked), state: web ? web.status().state : 'off', note: web ? null : 'WhatsApp not connected yet.' });
      }
      if (url.pathname.startsWith('/api/auth/') || url.pathname === '/api/profile') {
        if (req.method === 'GET' && url.pathname === '/api/auth/status') {
          const via = ownerVia(req), owner = via === 'session' ? auth.sessionOwner(req.headers.cookie) : null;
          return send(res, 200, { hasOwner: auth.hasOwner(), owner: !!via, via, live, adminKeySet: !!env.ADMIN_KEY,
            name: owner ? owner.name : null, profile: via ? auth.profile() : null, taxIdEncryption: auth.encryptionOn() });
        }
        if (req.method === 'GET' && url.pathname === '/api/profile') return isOwner(req) ? send(res, 200, { profile: auth.profile() }) : send(res, 403, { error: 'log in first' });
        if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
        const j = await jsonBody(req);
        if (!j.body) { if (j.code === 413) res.setHeader('connection', 'close'); return send(res, j.code!, { error: j.error }); }
        const b = j.body;
        // the shop's UPI ID (Shop profile): the one customers' QRs pay to. Empty turns the QR off; anything else must look like one.
        const upi = 'upiId' in b ? (String(b.upiId || '').trim() ? C.validUpi(b.upiId) : '') : null;
        if (upi === null && 'upiId' in b) return send(res, 400, { error: 'UPI ID should look like name@bank, for example yourname@okaxis (demo IDs are not allowed)' });
        const keepUpi = (out: { ok: boolean }) => upi != null && out.ok ? serial(() => { state.shop.upiId = upi; save(); }) : Promise.resolve();
        if (url.pathname === '/api/auth/setup') { const out = auth.setup(b, !!env.ADMIN_KEY && (sameKey(b.adminKey, env.ADMIN_KEY) || keyOk(req))); await keepUpi(out); return authRoute(req, res, out); }
        if (url.pathname === '/api/auth/login') return authRoute(req, res, auth.login(b));
        if (url.pathname === '/api/auth/logout') { auth.logout(req.headers.cookie); res.setHeader('set-cookie', auth.clearCookie()); return send(res, 200, { ok: true }); }
        if (url.pathname === '/api/auth/password') {
          const o = auth.sessionOwner(req.headers.cookie);
          return o ? authRoute(req, res, auth.changePassword(o, b)) : send(res, 403, { error: 'log in first' });
        }
        if (url.pathname === '/api/profile') {
          if (!isOwner(req)) return send(res, 403, { error: 'log in first' });
          const out = auth.saveProfile(b);
          if (out.ok && out.profile) await serial(() => { state.shop.name = out.profile!.shopName; state.shop.owner = out.profile!.ownerName; save(); });
          await keepUpi(out);
          return authRoute(req, res, Object.assign(out, { upiId: C.shopUpi(state) }));
        }
        return send(res, 404, { error: 'not found' });
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, snapshot(undefined, !live || isOwner(req)));
      if (req.method === 'POST' && url.pathname === '/api/act') {
        if (!/application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'send JSON' });
        if (+req.headers['content-length']! > MAX_BODY) { res.setHeader('connection', 'close'); return send(res, 413, { error: 'body too large' }); }
        let body;
        try { body = JSON.parse(await readBody(req) || '{}'); } catch (e: any) { return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'body too large' : 'bad JSON' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'send a JSON object' });
        const action = String(typeof body.action === 'string' ? body.action : '');
        const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
        if ('text' in args && typeof args.text !== 'string') return send(res, 400, { error: 'text must be a string' });
        // a live shop's khata belongs to the shop: the public page is view-only, and the owner and customers act on
        // WhatsApp, so nobody on the link can write udhaar, approve cash, give consent or move the day (KAN-44)
        if (live && !isOwner(req))
          return send(res, 403, { error: 'locked', message: 'Yeh asli dukaan ka khata hai: yahan sirf dekh sakte hain. Entry, reminder aur baaki kaam WhatsApp par hote hain 🙏' });
        // a live shop runs on the real calendar: nobody, not even the owner, can wipe the khata or move its day by hand.
        // The scheduler (tick) moves the day and sends the evening summary itself (KAN-101, KAN-102).
        if (live && LIVE_BLOCKED[action]) return send(res, 403, { error: 'live', message: LIVE_BLOCKED[action] });
        const out = await serial(async () => {
          const from = state.messages.length, before = state;
          const r = await act(action, args);
          // customers on WhatsApp get what the owner did on the web page; the owner already sees it here
          if (state === before) { wa.deliver(state, from, null, { skipOwner: true }); save(); }
          return r;
        });
        return send(res, 200, out);
      }
      return send(res, 404, { error: 'not found' });
    } catch (e: any) { // anything thrown while answering; HttpError carries its status
      const code = e.code >= 400 && e.code < 500 ? e.code : 500;
      return send(res, code, { error: code === 500 ? 'server error' : e.message });
    }
  }) as UdhaarServer;
  // The agent's own scheduler. The demo's "Agle din" button only moves the shop's clock forward,
  // so the real date never pulls the khata backwards.
  function tick() {
    const ran: string[] = [];
    return serial(async () => {
      const now = today();
      const from = state.messages.length;
      for (let i = 0; i < 31 && state.today < now; i++) { C.runAction(state, 'nextDay'); ran.push('nextDay'); }
      if (hourNow() >= evening && state.eveningSentFor !== state.today && state.today === now) { C.runAction(state, 'closeDay'); ran.push('closeDay'); }
      if (ran.length) { await brain.translateOut(state, from); wa.deliver(state, from); save(); }
      return ran;
    }).then(async (ran) => { await tickTenants(); return ran; });
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  if (env.REAL_CLOCK === '1') { timer = setInterval(() => { tick().catch(() => {}); }, 60 * 1000); timer.unref(); server.on('close', () => clearInterval(timer!)); }
  server.tick = tick;
  server.getState = () => state;
  server.engine = engine;
  server.brain = brain;
  server.whatsapp = wa;
  server.web = web;
  if (web && webOn) web.start();
  server.on('close', () => { if (web) web.stop(); store.close().catch(() => {}); authStore.close().catch(() => {}); registry.close().catch(() => {});
    for (const t of loaded.values()) { if (t.web) t.web.stop(); t.store.close().catch(() => {}); t.authStore.close().catch(() => {}); } });
  server.store = store;
  server.auth = auth;
  server.registry = registry;
  server.shop = (id: string) => (registry.has(id) ? tenant(id) : Promise.resolve(null));
  // shops whose own WhatsApp number was linked before a restart reconnect on their own
  try { for (const id of fs.readdirSync(waRoot)) if (registry.has(id) && fs.existsSync(path.join(waRoot, id, 'creds.json'))) tenant(id).catch(() => {}); } catch (e) { /* no shop has linked a number yet */ }
  server.idle = () => queue.then(() => wa.idle()).then(() => web && web.idle()).then(() => Promise.all(Array.from(loaded.values()).map((t) => t.serial(() => {}).then(() => t.wa && t.wa.idle()).then(() => t.web && t.web.idle()))));
  return server;
}

/** The page the owner opens to link the shop's WhatsApp number: a QR while waiting, the status after. Refreshes itself. */
function linkPage(web: WebTransport, state: State): string {
  const esc = (x: unknown) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
  const st = web.status(), qrText = web.qr();
  let body;
  if (st.state === 'connected') {
    body = '<p class="ok">✅ Jud gaya' + (st.number ? ' (' + esc(st.number) + ')' : '') + '</p>' +
      '<p>WhatsApp isi number se chal raha hai.</p>';
  } else if (st.state === 'qr' && qrText) {
    // vendored untyped UMD script; compiled to dist-server/server/, two levels below the repo root
    const qr = (require('../../vendor/qrcode-generator.js') as any)(0, 'L');
    qr.addData(qrText); qr.make();
    body = '<p class="wait">⏳ Scan ka intezaar</p><div class="qr">' + qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true }) + '</div>' +
      '<ol><li>Dukaan wale phone par WhatsApp kholiye</li><li>⋮ (ya Settings) → <b>Linked devices</b> → <b>Link a device</b></li><li>Is QR ko scan kijiye</li></ol>';
  } else if (st.state === 'logged_out') {
    body = '<p class="bad">Number hata diya gaya (logged out). Naya QR aa raha hai…</p>';
  } else {
    body = '<p class="wait">⏳ WhatsApp se jud rahe hain… (' + esc(st.state) + ')</p>';
  }
  return '<!doctype html><html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
    '<meta http-equiv="refresh" content="' + (st.state === 'connected' ? 30 : 5) + '"><title>WhatsApp jodiye</title>' +
    '<style>body{font-family:system-ui,sans-serif;background:#f6f3ec;color:#1d1b16;margin:0;padding:24px 16px;display:flex;justify-content:center}main{max-width:420px;width:100%;text-align:center}' +
    'h1{font-size:22px;margin:0 0 6px}p,li{color:#5b564b;line-height:1.5}ol{text-align:left}.ok{color:#1f7a4d;font-size:20px;font-weight:700}.bad{color:#a3342b;font-weight:600}.wait{font-weight:600}' +
    '.qr svg{width:100%;max-width:320px;height:auto;background:#fff;padding:12px;border-radius:12px}.note{font-size:13px;color:#8a8478}</style></head><body><main>' +
    '<h1>' + esc(state.shop.name) + ': WhatsApp jodiye</h1>' + body +
    '<p class="note">Yeh page har kuch second mein apne aap naya hota hai. Yeh link kisi aur ko mat bhejiye.</p></main></body></html>';
}

// Reads KEY=value lines (blank lines and # comments skipped, optional quotes stripped) into env,
// without overriding variables that are already set. Returns the names it set; a missing file is fine.
function loadEnvFile(file: string, env: Env): string[] {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const set: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
    if (env[m[1]] === undefined || env[m[1]] === '') { env[m[1]] = v; set.push(m[1]); }
  }
  return set;
}

export { createServer, loadEnvFile };

if (require.main === module) {
  const envFile = process.env.UDHAAR_ENV_FILE || '/home/node/udhaar.env';
  const fromFile = loadEnvFile(envFile, process.env);
  if (fromFile.length) console.log('Read ' + fromFile.length + ' setting(s) from ' + envFile + ': ' + fromFile.join(', '));
  // The database host (Neon) resolves to IPv4 and IPv6 addresses; IPv6 may be unroutable here (ENETUNREACH) and an IPv4
  // handshake can take longer than Node's 250 ms per-address default, so every address fails -> AggregateError at start.
  (require('dns') as typeof import('dns')).setDefaultResultOrder('ipv4first');
  (require('net') as typeof import('net')).setDefaultAutoSelectFamilyAttemptTimeout(+process.env.NET_FAMILY_ATTEMPT_MS! || 2500);
  const port = +process.env.PORT! || 8000;
  const shopId = C.DEMO_SHOPS[process.env.SHOP!] ? process.env.SHOP! : 'gupta';
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
  // a self-registered shop is stored exactly like the instance's shop (same STORE, its own shop id / schema / files)
  const openShop = async (id: string) => {
    const e = Object.assign({}, process.env, { SHOP_ID: id });
    const [store, authStore] = await Promise.all([openStore(e, dataDir, id), openAuthStore(e, dataDir, id)]);
    return { store, authStore };
  };
  Promise.all([openStore(process.env, dataDir, shopId), openAuthStore(process.env, dataDir, shopId), openRegistry(process.env, dataDir)]).then(([store, authStore, registry]) => {
    createServer({ store, authStore, registry, openShop }).listen(port, '0.0.0.0', () => {
      console.log('Udhaar Agent (' + (process.env.SHOP || 'gupta') + ') on :' + port + ', storage: ' + store.kind + ', AI chain: ' + [process.env.LLM_BASE_URL ? 'custom' : '', process.env.AGENT37_LLM_PROXY_URL ? 'router' : ''].filter(Boolean).concat('rules').join(' -> '));
    });
  }, (e) => { console.error('Storage failed to start: ' + e.message); process.exit(1); });
}
