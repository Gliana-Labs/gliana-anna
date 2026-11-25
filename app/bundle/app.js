// GlianaAI on Anna: describe what you want; Anna's LLM (the user's Anna credits) picks one GlianaAI model or tool from the
// live catalog and writes its input; the app shows the exact price from /v1/price; the run is paid from the user's own
// GlianaAI balance with their gk_ key (BYOK).
import { AnnaAppRuntime } from '/static/anna-apps/_sdk/latest/index.js';
import {
  API, MODEL_KINDS, PICK_PROMPT, INPUT_PROMPT, offeredModels, offeredTools, catalogText, extractJson, checkPick, cleanInput,
  attachImage, priceQuery, requestFor, mediaIn, fmtUsd, looksLikeKey,
} from './logic.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let anna = null;
let key = null;
let catalog = null; // { models, tools, text }
let attached = null; // data: URL
let plan = null; // { kind, item, input, why, quoteMicro }
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

// ── Key ──────────────────────────────────────────────────────────────────
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
  say($('key-hint'), `Saved. Balance ${fmtUsd(b.balance_micro_usd)}.`);
  renderKeyButton(b);
}
function renderKeyButton(b) {
  $('key-btn').textContent = key ? `Balance ${b ? fmtUsd(b.balance_micro_usd) : '…'}` : 'Add API key';
}

// ── Catalog ──────────────────────────────────────────────────────────────
async function loadCatalog() {
  if (catalog) return catalog;
  const [m, t] = await Promise.all([getJson(`${API}/v1/models`), getJson(`${API}/v1/tools`)]);
  if (!m.ok || !t.ok) throw new Error('GlianaAI catalog unavailable, try again in a moment');
  const models = offeredModels(m.json.models ?? m.json.data);
  const tools = offeredTools(t.json.tools ?? t.json);
  catalog = { models, tools, text: catalogText(models, tools) };
  return catalog;
}

// ── Plan: pick, then input, then quote ───────────────────────────────────
async function llm(systemPrompt, content, maxTokens) {
  if (!anna) throw new Error('Open this app inside Anna to plan with AI');
  const r = await anna.llm.complete({ systemPrompt, messages: [{ role: 'user', content }], maxTokens, temperature: 0, thinking: false });
  return extractJson(r?.content?.text);
}

async function makePlan(ask) {
  const cat = await loadCatalog();
  const avoid = tried.length ? `\nDo NOT pick: ${tried.join(', ')}.` : '';
  const pick = checkPick(await llm(PICK_PROMPT, `OPTIONS:\n${cat.text}\n\nREQUEST: ${ask}${attached ? '\n(The user attached an image.)' : ''}${avoid}`, 300), cat.models, cat.tools);
  if (!pick.ok) throw new Error(pick.why);
  let schemaText;
  let schema = null;
  if (pick.kind === 'model') {
    const s = await getJson(`${API}/v1/schema?model=${encodeURIComponent(pick.item.id)}`);
    if (!s.ok) throw new Error('Could not read that model’s inputs');
    schema = { required: s.json.required ?? [], props: s.json.props ?? {} };
    schemaText = `SCHEMA for model ${pick.item.id} (${pick.item.category}):\n${JSON.stringify(schema).slice(0, 6000)}`;
  } else {
    schemaText = `TOOL ${pick.item.name} (${pick.item.method} ${pick.item.path}):\n${pick.item.guidance ?? ''}\nEXAMPLE INPUT: ${JSON.stringify(pick.item.example ?? {})}`;
  }
  const raw = await llm(INPUT_PROMPT, `${schemaText}\n\nREQUEST: ${ask}${attached ? '\n(The user attached an image.)' : ''}`, 1200);
  let input = raw;
  if (schema) {
    const c = cleanInput(raw, schema);
    if (c.missing.length) throw new Error(`The plan is missing ${c.missing.join(', ')}. Say a bit more about what you want.`);
    input = c.input;
  }
  const shown = { ...input };
  input = attachImage(input, attached);
  let quoteMicro = null;
  if (pick.kind === 'model') {
    const q = await getJson(`${API}/v1/price?${priceQuery(pick.item.id, input)}`);
    quoteMicro = q.ok ? (q.json.costMicroUsd ?? null) : null;
  } else {
    quoteMicro = pick.item.priceMicroUsd ?? null;
  }
  return { kind: pick.kind, item: pick.item, input, shown, why: pick.why, quoteMicro };
}

async function renderPlan() {
  const name = plan.kind === 'model' ? plan.item.id : plan.item.name;
  $('p-name').textContent = name;
  $('p-kind').textContent = plan.kind === 'model' ? `${MODEL_KINDS[plan.item.category]} model · ${plan.item.provider ?? ''}` : `tool · ${plan.item.category}`;
  $('p-price').textContent = plan.quoteMicro == null ? 'price on run' : plan.quoteMicro === 0 ? 'free' : `up to ${fmtUsd(plan.quoteMicro)}`;
  $('p-why').textContent = plan.why;
  $('p-input').innerHTML = Object.entries(plan.shown)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v === '{{ATTACHED_IMAGE}}' ? 'your attached image' : typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`)
    .join('');
  const b = await balance();
  $('p-balance').textContent = b ? `balance ${fmtUsd(b.balance_micro_usd)}` : key ? '' : 'add your API key to run';
  $('run').disabled = !key;
  $('plan-card').hidden = false;
}

// ── Run ──────────────────────────────────────────────────────────────────
async function run() {
  if (!key) return say($('status'), 'Add your GlianaAI key first.', true);
  const btn = $('run');
  btn.disabled = true;
  const kind = plan.kind === 'model' ? MODEL_KINDS[plan.item.category] : 'tool';
  say($('status'), kind === 'video' ? 'Running… videos can take a few minutes.' : 'Running…');
  try {
    const { url, init } = requestFor(plan, key);
    const r = await getJson(url, { ...init, signal: AbortSignal.timeout(15 * 60_000) });
    if (r.status === 402 || r.json?.error === 'insufficient_balance') throw new Error('Not enough GlianaAI balance. Top up at dashboard.glianalabs.com.');
    if (r.json?.error === 'daily_cap_reached') throw new Error('This key reached its daily spending cap. Raise it on the dashboard or try tomorrow.');
    if (!r.ok) throw new Error(r.json?.detail || r.json?.error || `HTTP ${r.status}`);
    const charged = Number(r.headers.get('x-gliana-charged-micro-usd') ?? r.json?.costMicroUsd ?? NaN);
    const left = Number(r.headers.get('x-gliana-balance-micro-usd') ?? NaN);
    const media = mediaIn(r.json, kind);
    renderResult(media, media.length ? null : r.json, charged, left);
    const name = plan.kind === 'model' ? plan.item.id : plan.item.name;
    history = [{ at: Date.now(), name, url: media[0]?.url ?? null, kind: media[0]?.kind ?? 'text', cost: Number.isFinite(charged) ? charged : null }, ...history].slice(0, 20);
    await store('history', history);
    renderHistory();
    anna?.chat?.append_artifact?.({ artifact: { kind: 'app_event', summary: `GlianaAI ${name}${Number.isFinite(charged) ? ` · ${fmtUsd(charged)}` : ''}` } })?.catch?.(() => undefined);
    say($('status'), 'Done.');
  } catch (e) {
    say($('status'), `Run failed: ${e.message}. A failed call is not charged.`, true);
  } finally {
    btn.disabled = false;
  }
}

function renderResult(media, json, charged, left) {
  $('r-media').innerHTML = media
    .map((m) =>
      m.kind === 'video'
        ? `<video src="${esc(m.url)}" controls playsinline></video>`
        : m.kind === 'audio'
          ? `<audio src="${esc(m.url)}" controls></audio>`
          : `<img src="${esc(m.url)}" alt="Generated image" />`,
    )
    .join('') + media.map((m) => `<a href="${esc(m.url)}" target="_blank" rel="noopener">Open / download</a>`).join(' ');
  $('r-text').hidden = !json;
  if (json) $('r-text').textContent = JSON.stringify(json, null, 2);
  $('r-cost').textContent = [Number.isFinite(charged) ? `Charged ${fmtUsd(charged)}` : '', Number.isFinite(left) ? `balance ${fmtUsd(left)}` : ''].filter(Boolean).join(' · ');
  $('result-card').hidden = false;
}

function renderHistory() {
  $('history-card').hidden = history.length === 0;
  $('history').innerHTML = history
    .map((h) => {
      const label = `<span>${esc(h.name)} · ${new Date(h.at).toLocaleString()}</span><span>${h.cost != null ? fmtUsd(h.cost) : ''}</span>`;
      return h.url ? `<li><a href="${esc(h.url)}" target="_blank" rel="noopener">${label}</a></li>` : `<li><a>${label}</a></li>`;
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
  if (key && !b) key = null; // revoked or wrong: ask again
  renderKeyButton(b);
  if (!key) $('key-card').hidden = false;
  if (anna?.entryPayload?.ask) $('ask').value = String(anna.entryPayload.ask);

  $('key-btn').onclick = () => ($('key-card').hidden = !$('key-card').hidden);
  $('key-save').onclick = saveKey;
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
    if (!ask) return say($('status'), 'Describe what you want first.', true);
    $('plan').disabled = true;
    $('replan').disabled = true;
    say($('status'), 'Planning…');
    try {
      plan = await makePlan(ask);
      tried.push(plan.kind === 'model' ? plan.item.id : plan.item.name);
      await renderPlan();
      say($('status'), key ? 'Check the plan and price, then run.' : 'Add your GlianaAI key to run this plan.');
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
