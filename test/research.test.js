// /api/check: quick search, extended background job, daily checks and the knowledge base.
// Network is mocked; the search logic itself is covered by test/run.mjs.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { runJob } from '../src/research/jobs.mjs';

const BASE = 'https://enginechecklight.com';
const TSB = 'https://static.nhtsa.gov/odi/tsbs/2018/MC-1.pdf';
const realFetch = globalThis.fetch;
let ai; // { calls, fail, found }

beforeEach(() => {
  ai = { calls: 0, fail: false, found: true };
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.includes('api.nhtsa.gov')) return Response.json({ results: [] });
    if (url.includes('api.anthropic.com')) {
      ai.calls++;
      if (ai.fail) return new Response('boom', { status: 500 });
      const definition = ai.found ? { found: true, text: 'EGR flow insufficient', source_url: TSB } : { found: false, text: '' };
      return Response.json({
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
        content: [
          { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: TSB, title: 'TSB' }] },
          { type: 'tool_use', name: 'submit_diagnosis', input: {
            definition, summary: 's', severity: 'medium', safe_to_drive: 'yes', safety_note: 'n',
            causes: [{ name: 'EGR valve', likelihood: 1, explanation: 'e', source_urls: [TSB] }], confidence: 'high' } },
        ],
      });
    }
    throw new Error('unexpected fetch ' + url);
  };
});
after(() => { globalThis.fetch = realFetch; });

function setup(env = {}) {
  const store = memoryStore();
  let clock = Date.parse('2026-11-11T10:00:00Z');
  const deps = { store, env: { FREE_DAILY: '2', IP_DAILY: '15', ANTHROPIC_API_KEY: 'test', ...env }, ip: '1.2.3.4', now: () => clock };
  const jobs = [];
  deps.startJob = async (id) => { jobs.push(id); };
  const run = (id) => runJob(id, { store, env: deps.env, now: () => clock });
  function client() {
    const jar = {};
    return async function call(path, body) {
      const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/json' };
      const res = await handle(new Request(BASE + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined }), deps);
      for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); jar[k] = v; }
      return { status: res.status, body: await res.json() };
    };
  }
  const call = client();
  const remaining = async () => (await call('/api/me')).body.quota.remaining;
  return { call, client, remaining, store, jobs, run, tick: (ms) => (clock += ms) };
}

const CAR = { make: 'Land Rover', model: 'Range Rover Sport', year: '2016', code: 'P0401' };

test('basic is free and makes no AI call', async () => {
  const { call, remaining } = setup();
  const r = await call('/api/check', { ...CAR, step: 'basic' });
  assert.equal(r.status, 200);
  assert.equal(r.body.code.full, 'P0401');
  assert.equal(ai.calls, 0);
  assert.equal(await remaining(), 2);
});

test('quick search with a definition uses one check; a knowledge-base hit is free', async () => {
  const { call, remaining, store } = setup();
  const r = await call('/api/check', { ...CAR, step: 'quick', lang: 'ka' });
  assert.equal(r.status, 200);
  assert.equal(r.body.cached, false);
  assert.equal(r.body.can_extend, false);
  assert.equal(r.body.usage.stages, 1);
  assert.equal(r.body.quota.remaining, 1);
  assert.ok([...store._data.keys()].some((k) => k.startsWith('kb:')));

  const again = await call('/api/check', { ...CAR, step: 'quick', lang: 'ka' });
  assert.equal(again.body.cached, true);
  assert.equal(ai.calls, 1);
  assert.equal(await remaining(), 1);
});

test('quick search without a definition is free and offers the extended search', async () => {
  const { call, remaining, store } = setup();
  ai.found = false;
  const r = await call('/api/check', { ...CAR, step: 'quick' });
  assert.equal(r.status, 200);
  assert.equal(r.body.diagnosis.definition.found, false);
  assert.equal(r.body.can_extend, true);
  assert.equal(r.body.charged, false);
  assert.equal(await remaining(), 2);
  assert.ok(![...store._data.keys()].some((k) => k.startsWith('kb:')));
});

test('quick search errors are free and offer the extended search', async () => {
  const { call, remaining } = setup();
  ai.fail = true;
  const r = await call('/api/check', { ...CAR, step: 'quick' });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'research_failed');
  assert.equal(r.body.can_extend, true);
  assert.equal(await remaining(), 2);
});

test('extended search runs as a job, is charged once, and only its owner can read it', async () => {
  const { call, client, remaining, jobs, run, store } = setup();
  const start = await call('/api/check', { ...CAR, step: 'research' });
  assert.equal(start.status, 202);
  assert.equal(start.body.jobId, jobs[0]);
  assert.equal((await call(`/api/check/${start.body.jobId}`)).body.status, 'queued');
  assert.equal(await remaining(), 2); // nothing charged before it runs

  await run(start.body.jobId);
  const done = await call(`/api/check/${start.body.jobId}`);
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'done');
  assert.equal(done.body.diagnosis.definition.found, true);
  assert.equal(done.body.quota.remaining, 1);

  await run(start.body.jobId); // a second start of the same job does nothing
  await run('made-up-job-id-123');
  assert.equal(await remaining(), 1);
  assert.equal(ai.calls, 1);

  const stranger = client();
  assert.equal((await stranger(`/api/check/${start.body.jobId}`)).status, 404);
  // the result also went into the knowledge base
  assert.ok([...store._data.keys()].some((k) => k.startsWith('kb:')));
});

test('extended search that fails is not charged', async () => {
  const { call, remaining, jobs, run } = setup();
  ai.fail = true;
  const start = await call('/api/check', { ...CAR, step: 'research' });
  await run(jobs[0]);
  const r = await call(`/api/check/${start.body.jobId}`);
  assert.equal(r.body.status, 'failed');
  assert.equal(r.body.error, 'research_failed');
  assert.equal(await remaining(), 2);
});

test('a job that never finishes is reported as failed', async () => {
  const { call, tick } = setup();
  const start = await call('/api/check', { ...CAR, step: 'research' });
  tick(6 * 60_000);
  assert.equal((await call(`/api/check/${start.body.jobId}`)).body.status, 'failed');
});

test('extended search of a known answer is served from the knowledge base at once', async () => {
  const { call, jobs } = setup();
  await call('/api/check', { ...CAR, step: 'quick' });
  const r = await call('/api/check', { ...CAR, step: 'research' });
  assert.equal(r.status, 200);
  assert.equal(r.body.cached, true);
  assert.equal(jobs.length, 0);
});

test('no checks left -> 402 no_credits for quick and extended, without an AI call', async () => {
  const { call, jobs } = setup({ FREE_DAILY: '1' });
  assert.equal((await call('/api/check', { ...CAR, step: 'quick' })).status, 200);
  for (const step of ['quick', 'research']) {
    const r = await call('/api/check', { ...CAR, code: 'P0300', step });
    assert.equal(r.status, 402, step);
    assert.equal(r.body.error, 'no_credits');
    assert.equal(r.body.quota.remaining, 0);
  }
  assert.equal(ai.calls, 1);
  assert.equal(jobs.length, 0);
});

test('invalid code -> 400, missing key -> not_configured', async () => {
  const { call } = setup({ ANTHROPIC_API_KEY: '' });
  assert.equal((await call('/api/check', { ...CAR, code: 'ZZZ', step: 'basic' })).status, 400);
  assert.equal((await call('/api/check', { ...CAR, code: 'ZZZ', step: 'research' })).body.error, 'invalid_code');
  assert.equal((await call('/api/check', { make: 'Audi', step: 'basic' })).body.error, 'need_code_or_text');
  for (const step of ['quick', 'research']) {
    const r = await call('/api/check', { ...CAR, step });
    assert.equal(r.status, 500, step);
    assert.equal(r.body.error, 'not_configured');
  }
});
