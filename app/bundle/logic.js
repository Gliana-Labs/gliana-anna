// Pure logic for the GlianaAI Anna app: no DOM, no host. Tested by test/logic.test.mjs (node --test).

export const API = 'https://api.glianalabs.com';

/** The kinds of model the app offers (operator, 2026-11-26: image, video, voice, music, plus tools). */
export const MODEL_KINDS = {
  'text-to-image': 'image',
  'image-to-image': 'image',
  'text-to-video': 'video',
  'image-to-video': 'video',
  'video-to-video': 'video',
  tts: 'voice',
  music: 'music',
};

/**
 * Left out of the Anna app on purpose:
 * - uncensored / abliterated models (operator's choice: Anna's content policy is unknown);
 * - tools that take personal data (KTP, NIK, NPWP, faces, KYC, people lookups): under UU PDP they need their own
 *   privacy notice, which this app does not carry;
 * - anything a balance key cannot pay for (payableFromBalance false).
 */
const UNCENSORED = /uncensored|abliterat/i;
const PERSONAL_TOOL = /nik|npwp|ktp|kyc|face|selfie|identity|person|people|phone-lookup|email-lookup|whois-person/i;
const PERSONAL_CATEGORY = new Set(['identity', 'osint']);

export function offeredModels(models) {
  return (models ?? []).filter((m) => MODEL_KINDS[m.category] && !UNCENSORED.test(m.id));
}

export function offeredTools(tools) {
  return (tools ?? []).filter((t) => t.payableFromBalance && !PERSONAL_CATEGORY.has(t.category) && !PERSONAL_TOOL.test(t.name));
}

const usd = (micro) => (micro == null ? '?' : `$${(micro / 1e6).toFixed(micro < 10_000 ? 4 : 3)}`);

/** One line per option, short enough that ~200 options fit one planning call. */
export function catalogText(models, tools) {
  const m = models.map((x) => `model ${x.id} | ${MODEL_KINDS[x.category]} (${x.category}) | ${x.priceLabel ?? usd(x.unitPriceMicroUsd)}`);
  const t = tools.map((x) => `tool ${x.name} | ${x.category} | ${usd(x.priceMicroUsd)} | ${String(x.guidance ?? '').replace(/\s+/g, ' ').slice(0, 140)}`);
  return [...m, ...t].join('\n');
}

export const PICK_PROMPT = `You choose ONE GlianaAI model or tool that best does what the user asks. Options are listed one per line as
"model <id> | <kind> | <price>" or "tool <name> | <category> | <price> | <what it does>".
Rules:
- Pick only from the list. Prefer the cheapest option that does the job well, unless the user asks for top quality.
- If the user attached an image and wants it changed or animated, pick an image-to-image or image-to-video model.
- If nothing in the list fits, answer {"type":"none","id":"","why":"<one sentence>"}.
Answer ONLY JSON: {"type":"model"|"tool"|"none","id":"<id or name>","why":"<one short sentence for the user>"}`;

export const INPUT_PROMPT = `You write the JSON input for ONE GlianaAI call. You get the user's request, the model's input schema (or the
tool's description and example input). Rules:
- Use only fields from the schema or the example. Fill every required field.
- Write a clear, detailed prompt in English for image/video/music models, keeping the user's language for any text to be spoken or shown.
- Keep costs modest: shortest sensible duration, standard resolution and quality, one output, unless the user asks otherwise.
- If the user attached an image and the schema has an image field, put the exact string "{{ATTACHED_IMAGE}}" in it.
Answer ONLY the JSON input object.`;

/** Pull the JSON object out of a model reply (it may add fences or a sentence). */
export function extractJson(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no_json');
  return JSON.parse(s.slice(a, b + 1));
}

/** The pick must name an option we actually offer; anything else is refused, never guessed. */
export function checkPick(pick, models, tools) {
  if (!pick || pick.type === 'none') return { ok: false, why: pick?.why || 'Nothing in GlianaAI fits that request.' };
  if (pick.type === 'model') {
    const m = models.find((x) => x.id === pick.id);
    return m ? { ok: true, kind: 'model', item: m, why: String(pick.why ?? '') } : { ok: false, why: `Unknown model ${pick.id}` };
  }
  if (pick.type === 'tool') {
    const t = tools.find((x) => x.name === pick.id);
    return t ? { ok: true, kind: 'tool', item: t, why: String(pick.why ?? '') } : { ok: false, why: `Unknown tool ${pick.id}` };
  }
  return { ok: false, why: 'Could not understand the plan.' };
}

/** Keep only schema fields; report missing required ones. */
export function cleanInput(input, schema) {
  const props = schema?.props ?? {};
  const out = {};
  for (const [k, v] of Object.entries(input ?? {})) if (k in props && v !== null && v !== '') out[k] = v;
  const missing = (schema?.required ?? []).filter((k) => !(k in out));
  return { input: out, missing };
}

/** Put the attached image (a data: URL) wherever the model asked for it. */
export function attachImage(input, dataUrl) {
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === '{{ATTACHED_IMAGE}}') out[k] = dataUrl ?? undefined;
    else if (Array.isArray(v)) out[k] = v.map((x) => (x === '{{ATTACHED_IMAGE}}' ? dataUrl : x)).filter((x) => x != null);
    else out[k] = v;
  }
  return out;
}

/** The fields /v1/price reads to choose a price tier (routes/price.ts), as query parameters. */
const PRICE_KEYS = ['duration', 'music_length_ms', 'text', 'resolution', 'target', 'quality', 'n', 'num_images', 'max_images', 'sequential_image_generation'];
const PRESENCE_KEYS = ['reference_videos', 'reference_audios', 'video', 'video_uri', 'audio', 'audio_url'];
export function priceQuery(modelId, input) {
  const q = new URLSearchParams({ model: modelId });
  for (const k of PRICE_KEYS) if (input[k] != null && typeof input[k] !== 'object') q.set(k, String(input[k]));
  for (const k of PRESENCE_KEYS) if (input[k]) q.set(k, '1');
  for (const k of ['images', 'image_urls', 'reference_images']) if (Array.isArray(input[k]) && input[k].length) q.set('images', String(input[k].length));
  return q.toString();
}

/** The HTTP request for a plan, on the user's own key. */
export function requestFor(plan, key) {
  const headers = { authorization: `Bearer ${key}` };
  if (plan.kind === 'model') {
    return { url: `${API}/v1/infer`, init: { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ model: plan.item.id, ...plan.input }) } };
  }
  const t = plan.item;
  if (String(t.method).toUpperCase() === 'GET') {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(plan.input)) if (v != null) q.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    return { url: `${API}${t.path}${q.size ? `?${q}` : ''}`, init: { method: 'GET', headers } };
  }
  return { url: `${API}${t.path}`, init: { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(plan.input) } };
}

const KIND_BY_EXT = [
  [/\.(png|jpe?g|webp|gif|avif)(\?|$)/i, 'image'],
  [/\.(mp4|webm|mov)(\?|$)/i, 'video'],
  [/\.(mp3|wav|ogg|m4a|flac|aac)(\?|$)/i, 'audio'],
];
/** Every media URL in a response, with its kind (by extension; falls back to the model's kind). */
export function mediaIn(json, fallbackKind) {
  const found = [];
  const walk = (v) => {
    if (typeof v === 'string' && /^https:\/\/\S+$/.test(v) && (/\/v1\/media\//.test(v) || KIND_BY_EXT.some(([re]) => re.test(v)))) {
      const kind = KIND_BY_EXT.find(([re]) => re.test(v))?.[1] ?? (fallbackKind === 'voice' || fallbackKind === 'music' ? 'audio' : fallbackKind ?? 'image');
      if (!found.some((f) => f.url === v)) found.push({ url: v, kind });
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(json);
  return found;
}

export const fmtUsd = usd;
export const looksLikeKey = (k) => /^gk_[A-Za-z0-9_-]{16,}$/.test(String(k ?? '').trim());
