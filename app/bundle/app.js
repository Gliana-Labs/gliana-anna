// GlianaAI on Anna. Describe what you want; Anna's LLM (the user's Anna credits) picks ONE option and writes its input:
//   - anna:  Anna's own image / video / voice / music (host APIs, the user's Anna credits, no GlianaAI key);
//   - model: one of 170+ GlianaAI models (POST /v1/infer on the user's own gk_ key, BYOK);
//   - tool:  a GlianaAI tool (free ones need no key; paid ones run on the gk_ key).
// The plan says how it is paid and what it costs before anything runs.
import { AnnaAppRuntime } from '/static/anna-apps/_sdk/latest/index.js';
import {
  API, MODEL_KINDS, PICK_PROMPT, INPUT_PROMPT, ANNA_SCHEMAS, offeredModels, offeredTools, catalogText, extractJson, checkPick,
  cleanInput, attachImage, priceQuery, requestFor, mediaIn, fmtUsd, looksLikeKey, annaArgs,
} from './logic.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let anna = null;
let key = null;
let catalog = null; // { models, tools }
let attached = null; // data: URL
let plan = null; // { kind, item, input, shown, why, quoteMicro }
let tried = [];
let history = [];

function say(el, msg, err = false) {
  el.textContent = msg;
  el.classList.toggle('err', err);
}
const store = (k, v) => anna?.storage.set({ key: k, value: v }).catch(() => undefined);
const load = async (k) => (anna ? ((await anna.storage.get({ key: k }).catch(() => null))?.value ?? null) : null);

async function getJson(url, init) {
  const r = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json: j, headers: r.headers };
}

// ── Key (optional) ───────────────────────────────────────────────────────
async function balance() {
  if (!key) return null;
  const r = await getJson(`${API}/v1/keys/balance`, { headers: { authorization: `Bearer ${key}` } }).catch(() => null);
  return r?.ok ? r.json : null;
}
async function saveKey() {
  const v = $('key').value.trim();
  if (!looksLikeKey(v)) return say($('key-hint'), 'That is not a GlianaAI key (it starts with gk_).', true);
  key = v;
  const b = await balance();
  if (!b) {
    key = null;
    return say($('key-hint'), 'GlianaAI did not accept that key. Check it on the dashboard.', true);
  }
  await store('key', v);
  $('key').value = '';
  say($('key-hint'), `Saved. GlianaAI balance ${fmtUsd(b.balance_micro_usd)}.`);
  renderKeyButton(b);
}
function renderKeyButton(b) {
  $('key-btn').textContent = key ? `GlianaAI ${b ? fmtUsd(b.balance_micro_usd) : '…'}` : 'Add GlianaAI key';
}

// ── Catalog ──────────────────────────────────────────────────────────────
async function loadCatalog() {
  if (catalog) return catalog;
  const [m, t] = await Promise.all([getJson(`${API}/v1/models`), getJson(`${API}/v1/tools`)]);
  if (!m.ok || !t.ok) throw new Error('GlianaAI catalogue unavailable, try again in a moment');
  catalog = { models: offeredModels(m.json.models ?? m.json.data), tools: offeredTools(t.json.tools ?? t.json) };
  return catalog;
}

// ── Plan: pick, input, quote ─────────────────────────────────────────────
async function llm(systemPrompt, content, maxTokens) {
  if (!anna) throw new Error('Open this app inside Anna to plan with AI');
  const r = await anna.llm.complete({ systemPrompt, messages: [{ role: 'user', content }], maxTokens, temperature: 0, thinking: false });
  return extractJson(r?.content?.text);
}

async function makePlan(ask) {
  const cat = await loadCatalog();
  const hasKey = !!key;
  const avoid = tried.length ? `\nDo NOT pick: ${tried.join(', ')}.` : '';
  const note = attached ? '\n(The user attached an image.)' : '';
  const pick = checkPick(await llm(PICK_PROMPT, `OPTIONS:\n${catalogText(cat.models, cat.tools, hasKey)}\n\nREQUEST: ${ask}${note}${avoid}`, 300), cat.models, cat.tools, hasKey);
  if (!pick.ok) throw new Error(pick.why);

  let schema = null;
  let schemaText;
  if (pick.kind === 'anna') {
    schema = ANNA_SCHEMAS[pick.item.id];
    schemaText = `SCHEMA for Anna ${pick.item.id}:\n${JSON.stringify(schema)}`;
  } else if (pick.kind === 'model') {
    const s = await getJson(`${API}/v1/schema?model=${encodeURIComponent(pick.item.id)}`);
    if (!s.ok) throw new Error('Could not read that model’s inputs');
    schema = { required: s.json.required ?? [], props: s.json.props ?? {} };
    schemaText = `SCHEMA for model ${pick.item.id} (${pick.item.category}):\n${JSON.stringify(schema).slice(0, 6000)}`;
  } else {
    schemaText = `TOOL ${pick.item.name} (${pick.item.method} ${pick.item.path}):\n${pick.item.guidance ?? ''}\nEXAMPLE INPUT: ${JSON.stringify(pick.item.example ?? {})}`;
  }
  const raw = await llm(INPUT_PROMPT, `${schemaText}\n\nREQUEST: ${ask}${note}`, 1200);

  let input = raw;
  if (pick.kind === 'anna') {
    const a = annaArgs(pick.item.id, raw);
    if (a.missing.length) throw new Error(`The plan is missing ${a.missing.join(', ')}. Say a bit more about what you want.`);
    input = a.args;
  } else if (schema) {
    const c = cleanInput(raw, schema);
    if (c.missing.length) throw new Error(`The plan is missing ${c.missing.join(', ')}. Say a bit more about what you want.`);
    input = c.input;
  }
  const shown = { ...input };
  if (pick.kind !== 'anna') input = attachImage(input, attached);

  let quoteMicro = null;
  if (pick.kind === 'model') {
    const q = await getJson(`${API}/v1/price?${priceQuery(pick.item.id, input)}`);
    quoteMicro = q.ok ? (q.json.costMicroUsd ?? null) : null;
  } else if (pick.kind === 'tool') {
    quoteMicro = pick.item.priceMicroUsd ?? null;
  }
  return { kind: pick.kind, item: pick.item, input, shown, why: pick.why, quoteMicro };
}

const planName = (p) => (p.kind === 'anna' ? `Anna ${p.item.id}` : p.kind === 'model' ? p.item.id : p.item.name);
const planKind = (p) => (p.kind === 'anna' ? p.item.id : p.kind === 'model' ? MODEL_KINDS[p.item.category] : 'tool');
const payOf = (p) => (p.kind === 'anna' ? 'anna' : p.kind === 'tool' && p.quoteMicro === 0 ? 'free' : 'gliana');

function renderPlan() {
  $('p-name').textContent = planName(plan);
  $('p-kind').textContent = plan.kind === 'anna' ? `${plan.item.id} · built into Anna` : plan.kind === 'model' ? `${planKind(plan)} model · ${plan.item.provider ?? 'GlianaAI'}` : `tool · ${plan.item.category}`;
  const pay = payOf(plan);
  const badge = $('p-pay');
  badge.className = `badge ${pay}`;
  badge.textContent = pay === 'anna' ? 'Anna credits' : pay === 'free' ? 'Free' : 'GlianaAI balance';
  $('p-price').textContent = pay === 'anna' ? '' : pay === 'free' ? '$0' : plan.quoteMicro == null ? 'price on run' : `up to ${fmtUsd(plan.quoteMicro)}`;
  $('p-why').textContent = plan.why;
  $('p-input').innerHTML = Object.entries(plan.shown)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v === '{{ATTACHED_IMAGE}}' ? 'your attached image' : typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`)
    .join('');
  const runnable = pay !== 'gliana' || !!key;
  $('run').disabled = !runnable;
  $('run').textContent = runnable ? 'Run' : 'Add a GlianaAI key to run';
  $('plan-card').hidden = false;
}

// ── Run ──────────────────────────────────────────────────────────────────
async function runAnna(p) {
  const onProgress = (s) => say($('status'), `${s.state ?? 'working'}${s.progress?.queuePosition != null ? ` · queue ${s.progress.queuePosition}` : ''}…`);
  const id = p.item.id;
  if (id === 'image') {
    const r = await anna.image.generate(p.input, { timeoutMs: 180_000 });
    return { media: (r.images ?? []).map((i) => ({ url: i.url, kind: 'image' })), cost: r.quota_used };
  }
  if (id === 'video') {
    const j = await anna.video.generateAwait(p.input, { onProgress, timeoutMs: 10 * 60_000 });
    return { media: [{ url: j.result?.url, kind: 'video' }], cost: j.billedCostCU };
  }
  if (id === 'music') {
    const j = await anna.music.generateAwait(p.input, { onProgress, timeoutMs: 10 * 60_000 });
    return { media: [{ url: j.result?.url, kind: 'audio' }], cost: j.billedCostCU };
  }
  const out = await anna.audio.speak({ text: p.input.text, format: 'mp3', delivery: 'url' });
  return { media: [{ url: out.url, kind: 'audio' }], cost: out.quotaUsed ?? out.quota_used };
}

async function runGliana(p) {
  const { url, init } = requestFor(p, p.quoteMicro === 0 && p.kind === 'tool' ? null : key);
  const r = await getJson(url, { ...init, signal: AbortSignal.timeout(15 * 60_000) });
  if (r.status === 402 || r.json?.error === 'insufficient_balance') throw new Error('Not enough GlianaAI balance. Top up at dashboard.glianalabs.com.');
  if (r.json?.error === 'daily_cap_reached') throw new Error('This key reached its daily spending cap. Raise it on the dashboard or try tomorrow.');
  if (!r.ok) throw new Error(r.json?.detail || r.json?.error || `HTTP ${r.status}`);
  const media = mediaIn(r.json, planKind(p));
  const charged = Number(r.headers.get('x-gliana-charged-micro-usd') ?? r.json?.costMicroUsd ?? NaN);
  const left = Number(r.headers.get('x-gliana-balance-micro-usd') ?? NaN);
  return { media, json: media.length ? null : r.json, charged, left };
}

async function run() {
  const btn = $('run');
  btn.disabled = true;
  const k = planKind(plan);
  say($('status'), k === 'video' ? 'Running… videos can take a few minutes.' : 'Running…');
  try {
    const out = plan.kind === 'anna' ? await runAnna(plan) : await runGliana(plan);
    const cost =
      plan.kind === 'anna'
        ? `Paid with Anna credits${out.cost != null ? ` (${out.cost})` : ''} · links last about 30 minutes, download to keep`
        : [Number.isFinite(out.charged) ? `Charged ${fmtUsd(out.charged)}` : '', Number.isFinite(out.left) ? `GlianaAI balance ${fmtUsd(out.left)}` : ''].filter(Boolean).join(' · ');
    renderResult(out.media.filter((m) => m.url), out.json, cost);
    history = [{ at: Date.now(), name: planName(plan), url: plan.kind === 'anna' ? null : out.media[0]?.url ?? null, pay: payOf(plan), cost: Number.isFinite(out.charged) ? out.charged : null }, ...history].slice(0, 20);
    await store('history', history);
    renderHistory();
    anna?.chat?.append_artifact?.({ artifact: { kind: 'app_event', summary: `GlianaAI · ${planName(plan)}` } })?.catch?.(() => undefined);
    if (out.left != null && Number.isFinite(out.left)) $('key-btn').textContent = `GlianaAI ${fmtUsd(out.left)}`;
    say($('status'), 'Done.');
  } catch (e) {
    const quota = /QUOTA/i.test(String(e?.code ?? e?.message));
    say($('status'), quota ? 'Your Anna credits ran out; top up in Anna and try again.' : `Run failed: ${e.message}. A failed call is not charged.`, true);
  } finally {
    btn.disabled = false;
  }
}

function renderResult(media, json, cost) {
  $('r-media').innerHTML =
    media
      .map((m) => (m.kind === 'video' ? `<video src="${esc(m.url)}" controls playsinline></video>` : m.kind === 'audio' ? `<audio src="${esc(m.url)}" controls></audio>` : `<img src="${esc(m.url)}" alt="Generated image" />`))
      .join('') + media.map((m) => `<a class="dl" href="${esc(m.url)}" target="_blank" rel="noopener">Open / download</a>`).join(' ');
  $('r-text').hidden = !json;
  if (json) $('r-text').textContent = JSON.stringify(json, null, 2);
  $('r-cost').textContent = cost;
  $('result-card').hidden = false;
  $('result-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderHistory() {
  $('history-card').hidden = history.length === 0;
  $('history').innerHTML = history
    .map((h) => {
      const right = h.pay === 'anna' ? 'Anna credits' : h.pay === 'free' ? 'free' : h.cost != null ? fmtUsd(h.cost) : '';
      const label = `<span>${esc(h.name)} · ${new Date(h.at).toLocaleString()}</span><span>${right}</span>`;
      return h.url ? `<li><a href="${esc(h.url)}" target="_blank" rel="noopener">${label}</a></li>` : `<li><span class="h">${label}</span></li>`;
    })
    .join('');
}

// ── Wire up ──────────────────────────────────────────────────────────────
async function main() {
  try {
    anna = await AnnaAppRuntime.connect();
    await anna.window.set_title({ title: 'GlianaAI' }).catch(() => undefined);
  } catch {
    say($('status'), 'Preview mode: open in Anna to plan with AI.');
  }
  key = await load('key');
  history = (await load('history')) ?? [];
  renderHistory();
  const b = await balance();
  if (key && !b) key = null; // revoked or wrong
  renderKeyButton(b);
  if (anna?.entryPayload?.ask) $('ask').value = String(anna.entryPayload.ask);

  $('key-btn').onclick = () => ($('key-card').hidden = !$('key-card').hidden);
  $('key-save').onclick = saveKey;
  document.querySelectorAll('.ex').forEach((b) => (b.onclick = () => (($('ask').value = b.dataset.ask), $('ask').focus())));
  $('attach').onchange = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) return say($('status'), 'That image is over 8 MB. Use a smaller one.', true);
    const rd = new FileReader();
    rd.onload = () => {
      attached = String(rd.result);
      $('attach-label').textContent = `Attached: ${f.name.slice(0, 24)}`;
    };
    rd.readAsDataURL(f);
  };
  const doPlan = async () => {
    const ask = $('ask').value.trim();
    if (!ask) return say($('status'), 'Describe what you want first, or tap an example.', true);
    $('plan').disabled = true;
    $('replan').disabled = true;
    say($('status'), 'Planning…');
    try {
      plan = await makePlan(ask);
      tried.push(planName(plan));
      renderPlan();
      say($('status'), payOf(plan) === 'gliana' && !key ? 'This one runs on GlianaAI: add a key, or try another option.' : 'Check the plan, then run.');
    } catch (e) {
      const quota = /QUOTA/i.test(String(e?.code ?? e?.message));
      say($('status'), quota ? 'Your Anna credits ran out; top up in Anna and try again.' : `Could not plan: ${e.message}`, true);
    } finally {
      $('plan').disabled = false;
      $('replan').disabled = false;
    }
  };
  $('plan').onclick = () => {
    tried = [];
    doPlan();
  };
  $('replan').onclick = doPlan;
  $('run').onclick = run;
}

main();
