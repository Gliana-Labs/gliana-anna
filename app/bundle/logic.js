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
/**
 * Anna's own media (v0.1.1, operator 2026-11-26: "show it then"): image, video, voice and music through the Anna host,
 * paid with the user's Anna credits, so a user gets a result with no GlianaAI key at all. Apps carry no price tag on
 * Anna; the developer earns Anna's usage revenue share on these credits.
 */
export const ANNA_OPTIONS = [
  { id: 'image', what: "Generate an image with Anna's built-in image models (no GlianaAI key needed)" },
  { id: 'video', what: "Generate a short video clip (about 5 s) with Anna's built-in video models (no GlianaAI key needed)" },
  { id: 'voice', what: "Speak a text aloud with Anna's built-in text-to-speech (no GlianaAI key needed)" },
  { id: 'music', what: "Generate a music track with Anna's built-in music models (no GlianaAI key needed)" },
];

/** Without a key only Anna's media and the free GlianaAI tools can run, so only those are offered. */
export function catalogText(models, tools, hasKey = true) {
  const a = ANNA_OPTIONS.map((x) => `anna ${x.id} | Anna credits | ${x.what}`);
  const m = hasKey ? models.map((x) => `model ${x.id} | ${MODEL_KINDS[x.category]} (${x.category}) | ${x.priceLabel ?? usd(x.unitPriceMicroUsd)}`) : [];
  const t = tools
    .filter((x) => hasKey || x.priceMicroUsd === 0)
    .map((x) => `tool ${x.name} | ${x.category} | ${x.priceMicroUsd === 0 ? 'free' : usd(x.priceMicroUsd)} | ${String(x.guidance ?? '').replace(/\s+/g, ' ').slice(0, 140)}`);
  return [...a, ...m, ...t].join('\n');
}

export const PICK_PROMPT = `You choose ONE option that best does what the user asks. Options are listed one per line as
"anna <id> | Anna credits | <what it does>", "model <id> | <kind> | <price>" or "tool <name> | <category> | <price> | <what it does>".
Rules:
- Pick only from the list. Prefer the cheapest option that does the job well, unless the user asks for a specific model, top quality or a long/high-resolution result.
- "anna" options run on the user's Anna credits; "model" and "tool" options on their GlianaAI balance ("free" tools cost nothing).
- If the user attached an image and wants it changed or animated, pick a GlianaAI image-to-image or image-to-video model (anna options cannot take an attached image).
- If nothing in the list fits, answer {"type":"none","id":"","why":"<one sentence>"}.
Answer ONLY JSON: {"type":"anna"|"model"|"tool"|"none","id":"<id or name>","why":"<one short sentence for the user>"}`;

/** The input each Anna option takes (the host APIs' own field names). */
export const ANNA_SCHEMAS = {
  image: { required: ['prompt'], props: { prompt: { type: 'string' }, size: { type: 'string', enum: ['1024x1024', '1024x1536', '1536x1024'] } } },
  video: { required: ['prompt'], props: { prompt: { type: 'string' }, durationSec: { type: 'integer', default: 5 }, aspectRatio: { type: 'string', enum: ['16:9', '9:16', '1:1'] } } },
  voice: { required: ['text'], props: { text: { type: 'string', description: 'the exact words to speak, in the language the user wants' } } },
  music: { required: ['prompt'], props: { prompt: { type: 'string' }, instrumental: { type: 'boolean' }, durationSec: { type: 'integer', default: 30 } } },
};

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
export function checkPick(pick, models, tools, hasKey = true) {
  if (!pick || pick.type === 'none') return { ok: false, why: pick?.why || 'Nothing in GlianaAI fits that request.' };
  if (pick.type === 'anna') {
    const a = ANNA_OPTIONS.find((x) => x.id === pick.id);
    return a ? { ok: true, kind: 'anna', item: a, why: String(pick.why ?? '') } : { ok: false, why: `Unknown option ${pick.id}` };
  }
  // Without a key only free tools can run; a paid pick is refused rather than run and failed.
  if (!hasKey && pick.type === 'model') return { ok: false, why: 'That needs a GlianaAI key. Add one, or ask for an image, video, voice or music made with Anna credits.' };
  if (!hasKey && pick.type === 'tool' && tools.find((x) => x.name === pick.id)?.priceMicroUsd !== 0) return { ok: false, why: 'That tool needs a GlianaAI key.' };
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

/** The HTTP request for a plan, on the user's own key (a free tool goes without one). */
export function requestFor(plan, key) {
  const headers = key ? { authorization: `Bearer ${key}` } : {};
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

/** Clamp an Anna option's input to sane, cheap values before it reaches the host (the host bills Anna credits). */
export function annaArgs(id, input) {
  const s = ANNA_SCHEMAS[id];
  const { input: a, missing } = cleanInput(input, s);
  if (missing.length) return { missing };
  if (id === 'video') a.durationSec = Math.min(Math.max(Number(a.durationSec) || 5, 3), 10);
  if (id === 'music') a.durationSec = Math.min(Math.max(Number(a.durationSec) || 30, 10), 120);
  if (id === 'voice') a.text = String(a.text).slice(0, 2000);
  return { args: a, missing: [] };
}
