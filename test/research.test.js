// /api/check: quick search, extended background job, daily checks and the knowledge base.
// Network is mocked; the search logic itself is covered by test/run.mjs.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { runJob } from '../src/research/jobs.mjs';
import { minPricePerCredit, publicPacks } from '../src/packs.js';
import { WORST_CASE_PER_CREDIT_USD } from '../src/research/cost.mjs';

const BASE = 'https://enginechecklight.com';
const TSB = 'https://static.nhtsa.gov/odi/tsbs/2018/MC-1.pdf';
const realFetch = globalThis.fetch;
let ai; // { calls, fail, found }

beforeEach(() => {
  ai = { calls: 0, fail: false, found: true, expensive: false };
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.includes('api.nhtsa.gov')) return Response.json({ results: [] });
    if (url.includes('api.anthropic.com')) {
      ai.calls++;
      if (ai.fail) return new Response('boom', { status: 500 });
      if (ai.expensive) return Response.json({ stop_reason: 'pause_turn', usage: { input_tokens: 200_000, output_tokens: 1000 }, content: [{ type: 'text', text: 'still searching' }] });
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
  const deps = { store, env: { ANTHROPIC_API_KEY: 'test', DEV_LOGIN_LINKS: '1', ...env }, ip: '1.2.3.4', now: () => clock };
  const jobs = [];
  deps.startJob = async (id) => { jobs.push(id); };
  const run = (id) => runJob(id, { store, env: deps.env, now: () => clock });
  function client() {
    const jar = {};
    return async function call(path, body) {
      const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/json' };
      const res = await handle(new Request(BASE + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined }), deps);
      for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); jar[k] = v; }
      return { status: res.status, body: res.status === 302 ? null : await res.json() };
    };
  }
  async function signedIn(email = 'u@example.com') {
    const call = client();
    const start = await call('/api/auth/start', { email });
    await call(new URL(start.body.devLink).pathname + new URL(start.body.devLink).search);
    return call;
  }
  const balanceOf = async (call) => (await call('/api/me')).body.credits.balance;
  return { client, signedIn, balanceOf, store, jobs, run, tick: (ms) => (clock += ms) };
}

const CAR = { make: 'Land Rover', model: 'Range Rover Sport', year: '2016', code: 'P0401' };

test('basic is free for everyone and makes no AI call', async () => {
  const { client } = setup();
  const r = await client()('/api/check', { ...CAR, step: 'basic' });
  assert.equal(r.status, 200);
  assert.equal(r.body.code.full, 'P0401');
  assert.equal(ai.calls, 0);
});

test('anonymous search -> 402 no_credits with need_login', async () => {
  const { client } = setup();
  for (const step of ['quick', 'research']) {
    const r = await client()('/api/check', { ...CAR, step });
    assert.equal(r.status, 402, step);
    assert.equal(r.body.need_login, true);
  }
  assert.equal(ai.calls, 0);
});

test('quick search with an answer uses one credit; a knowledge-base hit is free', async () => {
  const { signedIn, balanceOf, store } = setup();
  const call = await signedIn();
  const r = await call('/api/check', { ...CAR, step: 'quick', lang: 'ka' });
  assert.equal(r.status, 200);
  assert.equal(r.body.cached, false);
  assert.equal(r.body.charged, true);
  assert.equal(r.body.can_extend, false);
  assert.equal(r.body.credits.balance, 2);
  assert.ok(r.body.usage.cost_usd > 0);
  assert.ok((store._data.get('spend:2026-11-11')?.n ?? 0) > 0); // our spend is counted

  const again = await call('/api/check', { ...CAR, step: 'quick', lang: 'ka' });
  assert.equal(again.body.cached, true);
  assert.equal(ai.calls, 1);
  assert.equal(await balanceOf(call), 2);
});

test('no definition: the quick search uses one credit and the extended search of that code is included', async () => {
  const { signedIn, balanceOf, jobs, run } = setup();
  const call = await signedIn();
  ai.found = false;
  const q = await call('/api/check', { ...CAR, step: 'quick' });
  assert.equal(q.status, 200);
  assert.equal(q.body.can_extend, true);
  assert.equal(q.body.extend_included, true);
  assert.equal(await balanceOf(call), 2);

  ai.found = true;
  const start = await call('/api/check', { ...CAR, step: 'research' });
  assert.equal(start.status, 202);
  assert.equal(start.body.prepaid, true);
  await run(jobs[0]);
  const done = await call(`/api/check/${start.body.jobId}`);
  assert.equal(done.body.status, 'done');
  assert.equal(await balanceOf(call), 2); // still one credit for the code
});

test('quick search errors are free', async () => {
  const { signedIn, balanceOf } = setup();
  const call = await signedIn();
  ai.fail = true;
  const r = await call('/api/check', { ...CAR, step: 'quick' });
  assert.equal(r.status, 502);
  assert.equal(r.body.can_extend, true);
  assert.equal(await balanceOf(call), 3);
});

test('a search that runs past its cost cap is stopped and not charged', async () => {
  const { signedIn, balanceOf, store } = setup();
  const call = await signedIn();
  ai.expensive = true;
  const r = await call('/api/check', { ...CAR, step: 'quick' });
  assert.equal(r.status, 502);
  assert.equal(r.body.detail, 'budget_exceeded');
  assert.ok(ai.calls <= 2);
  assert.equal(await balanceOf(call), 3);
  assert.ok(store._data.get('spend:2026-11-11').n > 0);
});

test('extended search: job, charged once on success, only its owner can read it', async () => {
  const { signedIn, client, balanceOf, jobs, run } = setup();
  const call = await signedIn();
  const start = await call('/api/check', { ...CAR, step: 'research' });
  assert.equal(start.status, 202);
  assert.equal(start.body.prepaid, false);
  assert.equal((await call(`/api/check/${start.body.jobId}`)).body.status, 'queued');
  assert.equal(await balanceOf(call), 3);

  await run(jobs[0]);
  const done = await call(`/api/check/${start.body.jobId}`);
  assert.equal(done.body.status, 'done');
  assert.equal(done.body.credits.balance, 2);

  await run(jobs[0]); // a second start of the same job does nothing
  await run('made-up-job-id-123');
  assert.equal(await balanceOf(call), 2);
  assert.equal(ai.calls, 1);
  assert.equal((await client()(`/api/check/${start.body.jobId}`)).status, 404);
});

test('extended search that fails is not charged', async () => {
  const { signedIn, balanceOf, jobs, run } = setup();
  const call = await signedIn();
  ai.fail = true;
  const start = await call('/api/check', { ...CAR, step: 'research' });
  await run(jobs[0]);
  assert.equal((await call(`/api/check/${start.body.jobId}`)).body.status, 'failed');
  assert.equal(await balanceOf(call), 3);
});

test('a job that never finishes is reported as failed', async () => {
  const { signedIn, tick } = setup();
  const call = await signedIn();
  const start = await call('/api/check', { ...CAR, step: 'research' });
  tick(6 * 60_000);
  assert.equal((await call(`/api/check/${start.body.jobId}`)).body.status, 'failed');
});

test('extended search of a known answer is served from the knowledge base at once', async () => {
  const { signedIn, jobs } = setup();
  const call = await signedIn();
  await call('/api/check', { ...CAR, step: 'quick' });
  const r = await call('/api/check', { ...CAR, step: 'research' });
  assert.equal(r.status, 200);
  assert.equal(r.body.cached, true);
  assert.equal(jobs.length, 0);
});

test('no credits left -> 402 for quick and extended, without an AI call', async () => {
  const { signedIn, jobs } = setup({ FREE_CREDITS: '1' });
  const call = await signedIn();
  assert.equal((await call('/api/check', { ...CAR, step: 'quick' })).status, 200);
  for (const step of ['quick', 'research']) {
    const r = await call('/api/check', { ...CAR, code: 'P0300', step });
    assert.equal(r.status, 402, step);
    assert.equal(r.body.error, 'no_credits');
    assert.equal(r.body.credits.balance, 0);
  }
  assert.equal(ai.calls, 1);
  assert.equal(jobs.length, 0);
});

test('daily AI spend limit pauses paid searches', async () => {
  const { signedIn, store } = setup({ DAILY_SPEND_LIMIT_USD: '1' });
  const call = await signedIn();
  await store.add('spend:2026-11-11', 1_000_000);
  const r = await call('/api/check', { ...CAR, step: 'quick' });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'busy');
  assert.equal(ai.calls, 0);
});

test('every pack price must keep 50% margin in the worst case', () => {
  const floor = minPricePerCredit({ usdRate: 2.75, paymentFee: 0.035 });
  const worstCostGel = WORST_CASE_PER_CREDIT_USD * 2.75;
  assert.ok((floor * (1 - 0.035) - worstCostGel) / floor >= 0.5);
  for (const p of publicPacks()) if (p.buyable) assert.ok(p.price / p.credits >= floor, p.id);
});

test('invalid code -> 400, missing key -> not_configured', async () => {
  const { signedIn } = setup({ ANTHROPIC_API_KEY: '' });
  const call = await signedIn();
  assert.equal((await call('/api/check', { ...CAR, code: 'ZZZ', step: 'basic' })).status, 400);
  assert.equal((await call('/api/check', { ...CAR, code: 'ZZZ', step: 'research' })).body.error, 'invalid_code');
  assert.equal((await call('/api/check', { make: 'Audi', step: 'basic' })).body.error, 'need_code_or_text');
  for (const step of ['quick', 'research']) {
    const r = await call('/api/check', { ...CAR, step });
    assert.equal(r.status, 500, step);
    assert.equal(r.body.error, 'not_configured');
  }
});
