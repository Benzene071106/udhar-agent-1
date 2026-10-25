// The vision model that reads a photo of the paper khata: any OpenAI-compatible /chat/completions endpoint that takes
// images (vLLM, Nodus or another host serving Gemma 4 31B, for example). It only reads; core/khata-photo.ts checks the
// answer and the owner decides on the dashboard what goes into the khata.
//
//   VISION_URL         base URL ending in /v1 (unset = photo reading is off)
//   VISION_KEY         optional bearer key for VISION_URL
//   VISION_MODEL       model id on that endpoint (default google/gemma-4-31B-it)
//   VISION_TIMEOUT_MS  default 120000: a big model reading a full page is slow
//   VISION_MAX_TOKENS  default 4000
import { extractJson } from './llm';
import { KHATA_PHOTO_PROMPT, normalizePhoto } from '../core/khata-photo';
import type { PhotoRead } from '../core/khata-photo';

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
export interface VisionOpts { env?: Env; fetch?: FetchLike }
export type Vision = ReturnType<typeof createVision>;

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function createVision(opts: VisionOpts) {
  const env = opts.env || {};
  const fetchImpl = opts.fetch || (globalThis.fetch as unknown as FetchLike);
  const url = String(env.VISION_URL || '').replace(/\/+$/, '');
  const model = env.VISION_MODEL || 'google/gemma-4-31B-it';
  const timeoutMs = +env.VISION_TIMEOUT_MS! || 120000;
  const maxTokens = +env.VISION_MAX_TOKENS! || 4000;
  const stats = { calls: 0, ok: 0, failed: 0, lastError: null as string | null, lastMs: null as number | null };

  /** One page: the image's bytes and type. Resolves with the cleaned blocks, or throws (the caller says so to the owner). */
  async function readPage(image: Buffer, type: string): Promise<PhotoRead & { model: string; ms: number }> {
    if (!url) throw new Error('photo reading is off: VISION_URL is not set');
    if (!IMAGE_TYPES.includes(type)) throw new Error('send a JPEG, PNG or WebP photo');
    if (!image.length || image.length > MAX_IMAGE_BYTES) throw new Error('photo is empty or larger than 8 MB');
    const t0 = Date.now();
    stats.calls++;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (env.VISION_KEY) headers.authorization = 'Bearer ' + env.VISION_KEY;
      const body = JSON.stringify({ model, temperature: 0, max_tokens: maxTokens, messages: [
        { role: 'system', content: KHATA_PHOTO_PROMPT },
        { role: 'user', content: [
          { type: 'text', text: 'Read every customer block on this khata page and answer with the JSON object only.' },
          { type: 'image_url', image_url: { url: 'data:' + type + ';base64,' + image.toString('base64') } }] }] });
      const r = await fetchImpl(url + '/chat/completions', { method: 'POST', headers, signal: ctl.signal, body });
      if (!r.ok) throw new Error('vision model answered HTTP ' + r.status);
      const j = await r.json();
      const content = j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : null;
      const read = normalizePhoto(extractJson(content));
      stats.ok++; stats.lastMs = Date.now() - t0;
      return Object.assign(read, { model, ms: stats.lastMs });
    } catch (e: any) {
      stats.failed++; stats.lastError = String(e && e.name === 'AbortError' ? 'timed out after ' + timeoutMs + ' ms' : (e && e.message) || e).slice(0, 200);
      throw new Error(stats.lastError);
    } finally { clearTimeout(timer); }
  }

  return { enabled: !!url, model, readPage, health: () => Object.assign({ enabled: !!url, model }, stats) };
}

export { createVision };
