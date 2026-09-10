import { randomUUID } from 'node:crypto';
import { identifier, modelId as validateModelId } from '../lib/validate.js';
import { now } from '../db/database.js';
import { providerCredentials, providerFetch, upstreamUrl } from './providers.js';

// The thinking ladder the chat offers. Each rung is probed by sending `reasoning_effort` and
// looking at what comes back: a rejection means the provider refused the parameter, reasoning
// text means the model actually thought, and silence means the parameter was accepted but
// probably ignored.
export const THINKING_LEVELS = [
  { id: 'low', label: 'Low', value: 'low' },
  { id: 'medium', label: 'Medium', value: 'medium' },
  { id: 'high', label: 'High', value: 'high' },
  { id: 'xhigh', label: 'Extra High', value: 'xhigh' },
  { id: 'max', label: 'Max', value: 'max' }
];

// A real 8x8 solid-red PNG. Small enough to be cheap to send, and unambiguous enough that a
// vision-capable model can say what it is.
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4I6KBFTEMLQkAh11GAWmISxcAAAAASUVORK5CYII=';

// A minimal one-page PDF. The probe is about whether the provider accepts a file part at all,
// not about whether the model reads the page correctly.
const TINY_PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

const PING_TOOL = {
  type: 'function',
  function: {
    name: 'ping',
    description: 'Reply to the user. Takes no arguments.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }
};

// Every selected model of every provider, which is what the Testing page runs against.
export function listTestableModels(db) {
  return db.prepare(`
    SELECT p.id AS provider_id, p.name AS provider_name, pm.model_id AS model_id
    FROM providers p
    JOIN provider_models pm ON pm.provider_id = p.id
    ORDER BY p.name COLLATE NOCASE, pm.model_id COLLATE NOCASE
  `).all().map((row) => ({
    providerId: row.provider_id,
    providerName: row.provider_name,
    modelId: row.model_id,
    key: `${row.provider_id}:${row.model_id}`
  }));
}

function shortReason(text) {
  return String(text ?? '').replace(/\s+/gu, ' ').trim().slice(0, 160);
}

async function ask(db, providerId, body, timeoutMs) {
  const { provider, credentials } = providerCredentials(db, providerId);
  const startedAt = Date.now();
  let response;
  try {
    response = await providerFetch(upstreamUrl(provider.baseUrl, '/chat/completions'), credentials, {
      method: 'POST',
      timeoutMs,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: body.model, ...body.extra })
    });
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - startedAt, reason: shortReason(error.message) };
  }
  const ms = Date.now() - startedAt;
  if (!response?.ok) {
    let detail = '';
    try { detail = JSON.stringify(await response.json()); } catch { detail = ''; }
    return { ok: false, status: response?.status || 0, ms, reason: shortReason(detail || `HTTP ${response?.status}`) };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: response?.status || 0, ms, reason: 'The provider returned an invalid response.' };
  }
  const message = payload?.choices?.[0]?.message;
  const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content
    : (typeof message?.reasoning === 'string' ? message.reasoning : '');
  return {
    ok: true,
    status: response.status,
    ms,
    content: typeof message?.content === 'string' ? message.content : '',
    reasoning,
    toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls : [],
    payload
  };
}

// One probe = one question to the model plus a verdict. `works` is only claimed when there is
// evidence in the response, never from a bare 200.
async function probe(db, providerId, model, extra, { timeoutMs, judge }) {
  const result = await ask(db, providerId, { model, extra }, timeoutMs);
  if (!result.ok) return { status: 'rejected', reason: result.reason, ms: result.ms };
  const verdict = judge(result);
  return { ...verdict, ms: result.ms };
}

async function testThinkingLevel(db, providerId, model, level, timeoutMs) {
  return probe(db, providerId, model, {
    messages: [{ role: 'user', content: 'Work out 17 * 23 step by step, then answer with only the number.' }],
    reasoning_effort: level.value
  }, {
    timeoutMs,
    judge: (result) => (result.reasoning.trim()
      ? { status: 'works', reason: 'The model returned reasoning text.' }
      : { status: 'accepted', reason: 'The parameter was accepted but no reasoning came back.' })
  });
}

async function testVision(db, providerId, model, timeoutMs) {
  return probe(db, providerId, model, {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Reply with the single word RED if this image is entirely red, otherwise reply NO.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PNG}` } }
      ]
    }]
  }, {
    timeoutMs,
    judge: (result) => (result.content.trim()
      ? { status: 'works', reason: `The model answered the image: ${shortReason(result.content).slice(0, 40)}` }
      : { status: 'accepted', reason: 'The image was accepted but the model returned nothing.' })
  });
}

async function testFiles(db, providerId, model, timeoutMs) {
  return probe(db, providerId, model, {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Reply with the single word OK if you received the attached file.' },
        { type: 'file', file: { filename: 'glow-test.pdf', file_data: `data:application/pdf;base64,${Buffer.from(TINY_PDF).toString('base64')}` } }
      ]
    }]
  }, {
    timeoutMs,
    judge: (result) => (result.content.trim()
      ? { status: 'works', reason: 'The file part was accepted.' }
      : { status: 'accepted', reason: 'The file was accepted but the model returned nothing.' })
  });
}

async function testTools(db, providerId, model, timeoutMs) {
  return probe(db, providerId, model, {
    messages: [{ role: 'user', content: 'Use the ping tool now. Do not answer in plain text.' }],
    tools: [PING_TOOL],
    tool_choice: 'auto'
  }, {
    timeoutMs,
    judge: (result) => (result.toolCalls.length
      ? { status: 'works', reason: `The model called ${shortReason(result.toolCalls[0]?.function?.name || 'a tool')}.` }
      : { status: 'accepted', reason: 'Tools were accepted but the model did not call one.' })
  });
}

function scoreResults(results) {
  const thinking = THINKING_LEVELS.reduce((total, level) => {
    const status = results.thinking[level.id]?.status;
    return total + (status === 'works' ? 12 : status === 'accepted' ? 4 : 0);
  }, 0);
  const vision = results.vision.status === 'works' ? 20 : results.vision.status === 'accepted' ? 8 : 0;
  const files = results.files.status === 'works' ? 10 : results.files.status === 'accepted' ? 4 : 0;
  const tools = results.tools.status === 'works' ? 20 : results.tools.status === 'accepted' ? 5 : 0;
  const latency = results.baseline.status === 'works' ? Math.max(0, 10 - Math.floor((results.baseline.ms || 0) / 1_000)) : 0;
  return thinking + vision + files + tools + latency;
}

// Every probe, in the order it runs. Publishing the list means the UI can say "step 4 of 9"
// instead of looking stuck.
export const PROBE_STEPS = [
  { id: 'baseline', label: 'Waking the model up' },
  ...THINKING_LEVELS.map((level) => ({ id: `thinking:${level.id}`, label: `Thinking level ${level.label}` })),
  { id: 'vision', label: 'Image input' },
  { id: 'files', label: 'File attachments' },
  { id: 'tools', label: 'Tool use' }
];

async function testOneModel(db, { providerId, providerName, modelId: model }, { timeoutMs, emit, index = 0, total = 1 }) {
  const results = { baseline: { status: 'rejected', reason: 'Not run.', ms: 0 }, thinking: {}, vision: {}, files: {}, tools: {} };
  const key = `${providerId}:${model}`;
  let stepIndex = 0;
  // Announced before the probe runs, so the UI can name the model and the capability while it
  // waits on the network rather than only after it comes back.
  const step = (id) => {
    const found = PROBE_STEPS.find((entry) => entry.id === id);
    stepIndex += 1;
    emit?.('progress', {
      key, providerName, modelId: model, step: id, label: found?.label || id,
      stepIndex, stepTotal: PROBE_STEPS.length, index, total
    });
  };

  step('baseline');
  results.baseline = await probe(db, providerId, model, {
    messages: [{ role: 'user', content: 'Reply with the single word READY.' }]
  }, { timeoutMs, judge: (result) => (result.content.trim() ? { status: 'works', reason: shortReason(result.content).slice(0, 40) } : { status: 'accepted', reason: 'No content returned.' }) });

  if (results.baseline.status === 'rejected') {
    // Nothing else can be learned from a model that will not answer at all.
    const skipped = { status: 'skipped', reason: 'The model did not answer the baseline question.', ms: 0 };
    for (const level of THINKING_LEVELS) results.thinking[level.id] = { ...skipped };
    results.vision = { ...skipped };
    results.files = { ...skipped };
    results.tools = { ...skipped };
    stepIndex = PROBE_STEPS.length;
    emit?.('progress', { key, providerName, modelId: model, step: 'skipped', label: 'Skipping the rest — the model did not answer', stepIndex, stepTotal: PROBE_STEPS.length, index, total });
    return finish(db, { providerId, providerName, modelId: model }, results);
  }

  for (const level of THINKING_LEVELS) {
    step(`thinking:${level.id}`);
    results.thinking[level.id] = await testThinkingLevel(db, providerId, model, level, timeoutMs);
  }
  step('vision');
  results.vision = await testVision(db, providerId, model, timeoutMs);
  step('files');
  results.files = await testFiles(db, providerId, model, timeoutMs);
  step('tools');
  results.tools = await testTools(db, providerId, model, timeoutMs);
  return finish(db, { providerId, providerName, modelId: model }, results);
}

function finish(db, target, results) {
  const entry = {
    id: randomUUID(),
    providerId: target.providerId,
    providerName: target.providerName,
    modelId: target.modelId,
    results,
    score: scoreResults(results),
    testedAt: now()
  };
  db.prepare(`
    INSERT INTO model_tests (id, provider_id, provider_name, model_id, results, score, tested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider_id, model_id) DO UPDATE SET
      provider_name = excluded.provider_name,
      results = excluded.results,
      score = excluded.score,
      tested_at = excluded.tested_at
  `).run(entry.id, entry.providerId, entry.providerName, entry.modelId, JSON.stringify(results), entry.score, entry.testedAt);
  return entry;
}

function parseResults(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// The stored report, best first. Rank is by score, then by how quickly the model answered.
export function modelTestReport(db) {
  const rows = db.prepare('SELECT * FROM model_tests ORDER BY score DESC, tested_at DESC').all();
  const entries = rows.map((row) => ({
    providerId: row.provider_id,
    providerName: row.provider_name,
    modelId: row.model_id,
    key: `${row.provider_id}:${row.model_id}`,
    score: Number(row.score),
    testedAt: row.tested_at,
    results: parseResults(row.results)
  }));
  entries.sort((a, b) => b.score - a.score || (a.results?.baseline?.ms || 0) - (b.results?.baseline?.ms || 0));
  entries.forEach((entry, index) => { entry.rank = index + 1; });
  return { entries, levels: THINKING_LEVELS, testedAt: entries[0]?.testedAt || null };
}

// The levels the chat offers for one model: what the probe proved, best evidence first.
export function supportedThinkingLevels(db, rawProviderId, rawModelId) {
  const providerId = identifier(rawProviderId, 'Provider ID');
  const model = validateModelId(rawModelId);
  const row = db.prepare('SELECT results, tested_at FROM model_tests WHERE provider_id = ? AND model_id = ?').get(providerId, model);
  if (!row) return { tested: false, testedAt: null, levels: THINKING_LEVELS.map((level) => ({ ...level, status: 'unknown' })) };
  const results = parseResults(row.results);
  return {
    tested: true,
    testedAt: row.tested_at,
    levels: THINKING_LEVELS.map((level) => ({ ...level, status: results.thinking?.[level.id]?.status || 'unknown', reason: results.thinking?.[level.id]?.reason || '' }))
  };
}

export async function runModelTests(db, { timeoutMs = 20_000, emit, only = null } = {}) {
  const models = listTestableModels(db).filter((model) => !only || only.includes(model.key));
  emit?.('started', { total: models.length, steps: PROBE_STEPS.length, models: models.map(({ key, providerName, modelId }) => ({ key, providerName, modelId })) });
  const completed = [];
  for (const [index, model] of models.entries()) {
    // Named before the first probe, so a slow model is visibly "being tested" from the start.
    emit?.('model-start', { key: model.key, providerName: model.providerName, modelId: model.modelId, index, total: models.length });
    try {
      const entry = await testOneModel(db, model, { timeoutMs, emit, index, total: models.length });
      completed.push(entry);
      emit?.('model', { key: model.key, providerName: model.providerName, modelId: model.modelId, score: entry.score, index, total: models.length });
    } catch (error) {
      emit?.('model', { key: model.key, providerName: model.providerName, modelId: model.modelId, error: shortReason(error.message), index, total: models.length });
    }
  }
  const report = modelTestReport(db);
  emit?.('completed', report);
  return report;
}
