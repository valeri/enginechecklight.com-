import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { MOCK_DIAGNOSIS } from '../src/diagnose.js';
import { describeCode } from '../src/dtc.js';
import { buildDeps } from '../src/runtime.js';

const BASE = 'https://enginechecklight.com';

function setup(env = {}, extra = {}) {
  const store = memoryStore();
  let clock = Date.parse('2026-10-29T10:00:00Z');
  const sent = [];
  const deps = {
    store,
    env: { FREE_DAILY: '3', IP_DAILY: '15', SITE_URL: BASE, ...env },
    ip: '1.2.3.4',
    now: () => clock,
    diagnose: async () => ({ model: 'mock', diagnosis: MOCK_DIAGNOSIS }),
    scan: async () => ({ model: 'mock', codes: [describeCode('P0401')] }),
    sendEmail: async (m) => sent.push(m),
    ...extra,
  };
  const jar = {};
  async function call(path, { method = 'GET', body, ip } = {}) {
    const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
    if (body) headers['content-type'] = 'application/json';
    const res = await handle(new Request(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), { ...deps, ip: ip ?? deps.ip });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const [k, v] = pair.split('=');
      if (attrs.some((a) => a.trim() === 'Max-Age=0')) delete jar[k];
      else jar[k] = v;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }
  return { call, store, sent, jar, tick: (ms) => (clock += ms) };
}

const diag = (call, extra) => call('/api/diagnose', { method: 'POST', body: { code: 'P0401', car: { make: 'Land Rover' }, ...extra }, ...extra?._opts });

test('anonymous visitor gets 3 free checks per day, then 402, then resets next day', async () => {
  const { call, tick } = setup();
  const me = await call('/api/me');
  assert.equal(me.body.quota.remaining, 3);
  for (let i = 2; i >= 0; i--) {
    const r = await diag(call);
    assert.equal(r.status, 200);
    assert.equal(r.body.meta.quota.remaining, i);
  }
  assert.equal((await diag(call)).status, 402);
  tick(24 * 3600_000);
  assert.equal((await diag(call)).status, 200);
});

test('device cookie is set once and reused', async () => {
  const { call, jar } = setup();
  await call('/api/me');
  const first = jar.ecl_dev;
  assert.ok(first);
  await call('/api/me');
  assert.equal(jar.ecl_dev, first);
});

test('per-IP cap stops cookie clearing abuse', async () => {
  const { call, jar } = setup({ IP_DAILY: '4' });
  for (let i = 0; i < 4; i++) {
    delete jar.ecl_dev; // new "device" every time
    assert.equal((await diag(call)).status, 200);
  }
  delete jar.ecl_dev;
  assert.equal((await diag(call)).status, 402);
});

test('bad input is rejected without using a free check', async () => {
  const { call } = setup();
  const r = await call('/api/diagnose', { method: 'POST', body: { code: 'hello' } });
  assert.equal(r.status, 400);
  assert.equal((await call('/api/me')).body.quota.remaining, 3);
});

test('a failed AI call does not use a free check', async () => {
  const { call } = setup({}, { diagnose: async () => { throw new Error('down'); } });
  assert.equal((await diag(call)).status, 502);
  assert.equal((await call('/api/me')).body.quota.remaining, 3);
});

test('magic-link sign-in: email sent, link works once, session cookie, history saved', async () => {
  const { call, sent, jar } = setup();
  const start = await call('/api/auth/start', { method: 'POST', body: { email: 'Valeri@Example.com', lang: 'ka' } });
  assert.equal(start.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'valeri@example.com');
  assert.match(sent[0].subject, /EngineCheckLight/);
  const link = sent[0].text.match(/https:\/\/\S+/)[0];
  const path = link.replace(BASE, '');

  const v = await call(path);
  assert.equal(v.status, 302);
  assert.equal(v.headers.get('location'), '/?login=ok');
  assert.ok(jar.ecl_sess);

  const reuse = await call(path);
  assert.equal(reuse.headers.get('location'), '/?login=expired');

  const me = await call('/api/me');
  assert.equal(me.body.user.email, 'valeri@example.com');

  await diag(call);
  const h = await call('/api/history');
  assert.equal(h.body.items.length, 1);
  assert.equal(h.body.items[0].req.code, 'P0401');

  await call('/api/auth/logout', { method: 'POST' });
  assert.equal((await call('/api/me')).body.user, null);
  assert.equal((await call('/api/history')).status, 401);
});

test('sign-in links expire after 15 minutes', async () => {
  const { call, sent, tick } = setup();
  await call('/api/auth/start', { method: 'POST', body: { email: 'a@b.co' } });
  tick(16 * 60_000);
  const path = sent[0].text.match(/https:\/\/\S+/)[0].replace(BASE, '');
  assert.equal((await call(path)).headers.get('location'), '/?login=expired');
});

test('sign-in is off without an email provider', async () => {
  const { call } = setup({}, { sendEmail: null });
  assert.equal((await call('/api/me')).body.features.login, false);
  assert.equal((await call('/api/auth/start', { method: 'POST', body: { email: 'a@b.co' } })).status, 503);
});

test('bad email and rate limit on sign-in', async () => {
  const { call } = setup();
  assert.equal((await call('/api/auth/start', { method: 'POST', body: { email: 'nope' } })).status, 400);
  for (let i = 0; i < 5; i++) await call('/api/auth/start', { method: 'POST', body: { email: 'x@y.co' } });
  assert.equal((await call('/api/auth/start', { method: 'POST', body: { email: 'x@y.co' } })).status, 429);
});

test('code scanning is Pro only; PRO_EMAILS unlocks it and removes the limit', async () => {
  const { call, sent } = setup({ PRO_EMAILS: 'valeri@example.com' });
  const img = { image: { media_type: 'image/png', data: 'AAAA' } };
  assert.equal((await call('/api/scan-code', { method: 'POST', body: img })).status, 402);
  await call('/api/auth/start', { method: 'POST', body: { email: 'valeri@example.com' } });
  await call(sent[0].text.match(/https:\/\/\S+/)[0].replace(BASE, ''));
  const s = await call('/api/scan-code', { method: 'POST', body: img });
  assert.equal(s.status, 200);
  assert.equal(s.body.codes[0].code, 'P0401');
  for (let i = 0; i < 6; i++) assert.equal((await diag(call)).status, 200);
  assert.equal((await call('/api/me')).body.quota.pro, true);
});

test('waitlist stores each email once', async () => {
  const { call, store } = setup();
  assert.equal((await call('/api/waitlist', { method: 'POST', body: { email: 'w@x.co', plan: 'yearly' } })).status, 200);
  await call('/api/waitlist', { method: 'POST', body: { email: 'W@x.co' } });
  const keys = [...store._data.keys()].filter((k) => k.startsWith('waitlist:'));
  assert.equal(keys.length, 1);
  assert.equal(store._data.get(keys[0]).plan, 'yearly');
  assert.equal((await call('/api/waitlist', { method: 'POST', body: { email: 'bad' } })).status, 400);
});

test('diagnose accepts a failure type suffix and stores the canonical code', async () => {
  const { call, sent } = setup();
  await call('/api/auth/start', { method: 'POST', body: { email: 'ftb@example.com' } });
  await call(sent[0].text.match(/https:\/\/\S+/)[0].replace(BASE, ''));
  const r = await call('/api/diagnose', { method: 'POST', body: { code: 'B143C:11', car: { make: 'Land Rover' } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.req.code, 'B143C-11');
  assert.equal(r.body.code_info.code, 'B143C-11');
  assert.equal(r.body.code_info.ftbMeaning, 'Circuit short to ground');
  const h = await call('/api/history');
  assert.equal(h.body.items[0].req.code, 'B143C-11');
  assert.equal(h.body.items[0].d.code_info.ftb, '11');
  const bad = await call('/api/diagnose', { method: 'POST', body: { code: 'B143C-111' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /B143C-11/);
});

test('code lookup and unknown routes', async () => {
  const { call } = setup();
  const r = await call('/api/codes/p0420');
  assert.equal(r.body.code, 'P0420');
  assert.equal((await call('/api/codes/B143C%3A11')).body.code, 'B143C-11');
  assert.equal((await call('/api/nope')).status, 404);
});

test('an empty or blank ANTHROPIC_API_KEY means demo mode', async () => {
  for (const key of [undefined, '', '   ']) {
    const deps = buildDeps({ ANTHROPIC_API_KEY: key });
    assert.equal(deps.env.LIVE, '0', JSON.stringify(key));
    const r = await deps.diagnose({ code: describeCode('P0301'), image: null });
    assert.equal(r.diagnosis.summary, MOCK_DIAGNOSIS.summary);
  }
});
