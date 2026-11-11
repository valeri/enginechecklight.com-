// All API routes. Pure: takes a Request plus dependencies, returns a Response.
// The Netlify function (netlify/functions/api.mjs), the local dev server and the tests all call it.
import { createHash, randomBytes } from 'node:crypto';
import { InputError, parseImage, parseInput } from './diagnose.js';
import { describeCode } from './dtc.js';
import { loginEmail } from './email.js';
import checkCode, { cachedAnswer, checkInput } from './research/diagnose.mjs';
import { JOB_STALE_MS, addHistory, historyItem, jobKey, kbOn } from './research/jobs.mjs';
import { createRecallTranslator } from './research/translate.mjs';

const DAY_MS = 86_400_000;
const LOGIN_TTL_MS = 15 * 60_000;
const SESSION_TTL_MS = 30 * DAY_MS;
const HISTORY_MAX = 50;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

const sha = (s) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const dayKey = (now) => new Date(now).toISOString().slice(0, 10);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`;
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

/**
 * deps: { store, env, ip, now(), diagnose(input), scan(image), sendEmail?(msg) }
 * env keys used: FREE_DAILY, IP_DAILY, PRO_EMAILS, SITE_URL, DEV_LOGIN_LINKS, LIVE, ANTHROPIC_API_KEY, ANTHROPIC_MODEL
 */
export async function handle(req, deps) {
  const { store, env = {}, ip = 'unknown' } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;
  const freeDaily = Number(env.FREE_DAILY ?? 3);
  const ipDaily = Number(env.IP_DAILY ?? 15);
  const proEmails = new Set(String(env.PRO_EMAILS ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean));
  const loginEnabled = Boolean(deps.sendEmail) || env.DEV_LOGIN_LINKS === '1';
  const setCookies = [];

  // ---- who is calling -------------------------------------------------------------------
  const cookies = parseCookies(req);
  let user = null;
  if (cookies.ecl_sess) {
    const sess = await store.get(`session:${sha(cookies.ecl_sess)}`);
    if (sess && sess.exp > now) {
      user = await store.get(`user:${sess.userId}`);
    }
  }
  const isPro = Boolean(user && (user.pro || proEmails.has(user.email)));
  let deviceId = cookies.ecl_dev;
  if (!deviceId || deviceId.length > 64) {
    deviceId = token().slice(0, 24);
    setCookies.push(cookie('ecl_dev', deviceId, 400 * 86400));
  }
  const who = user ? `u:${user.id}` : `d:${deviceId}`;
  const day = dayKey(now);

  async function quota() {
    if (isPro) return { limit: null, remaining: null, pro: true };
    const used = (await store.get(`quota:${day}:${who}`))?.n ?? 0;
    return { limit: freeDaily, remaining: Math.max(0, freeDaily - used), pro: false };
  }

  const out = (data, status = 200, extra = {}) => {
    const res = json(data, status, extra);
    for (const c of setCookies) res.headers.append('set-cookie', c);
    return res;
  };

  try {
    // ---- account ----------------------------------------------------------------------
    if (path === '/api/me' && method === 'GET') {
      return out({
        user: user ? { email: user.email, pro: isPro } : null,
        quota: await quota(),
        features: { login: loginEnabled, live: env.LIVE === '1' },
      });
    }

    if (path === '/api/auth/start' && method === 'POST') {
      if (!loginEnabled) return out({ error: 'login_unavailable' }, 503);
      const body = await readJson(req);
      const email = String(body.email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return out({ error: 'bad_email' }, 400);
      const lang = body.lang === 'ka' ? 'ka' : 'en';
      // Abuse limits: 5 links per address per day, 20 per IP per day.
      if ((await store.incr(`rl:login:${day}:e:${sha(email)}`)) > 5) return out({ error: 'too_many' }, 429);
      if ((await store.incr(`rl:login:${day}:ip:${ip}`)) > 20) return out({ error: 'too_many' }, 429);
      const t = token();
      await store.set(`login:${sha(t)}`, { email, lang, exp: now + LOGIN_TTL_MS });
      const site = (env.SITE_URL ?? url.origin).replace(/\/+$/, '');
      const link = `${site}/api/auth/verify?token=${t}`;
      if (deps.sendEmail) {
        await deps.sendEmail({ to: email, ...loginEmail(link, lang) });
        return out({ ok: true });
      }
      return out({ ok: true, devLink: link }); // local development only (DEV_LOGIN_LINKS=1)
    }

    if (path === '/api/auth/verify' && method === 'GET') {
      const t = url.searchParams.get('token') ?? '';
      const key = `login:${sha(t)}`;
      const login = t ? await store.get(key) : null;
      if (!login || login.exp < now) {
        if (login) await store.del(key);
        return new Response(null, { status: 302, headers: { location: '/?login=expired' } });
      }
      await store.del(key); // single use
      const userId = sha(login.email).slice(0, 32);
      const existing = await store.get(`user:${userId}`);
      await store.set(`user:${userId}`, existing ?? { id: userId, email: login.email, createdAt: now, lang: login.lang });
      const sessionToken = token();
      await store.set(`session:${sha(sessionToken)}`, { userId, exp: now + SESSION_TTL_MS });
      const res = new Response(null, { status: 302, headers: { location: '/?login=ok' } });
      res.headers.append('set-cookie', cookie('ecl_sess', sessionToken, SESSION_TTL_MS / 1000));
      return res;
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      if (cookies.ecl_sess) await store.del(`session:${sha(cookies.ecl_sess)}`);
      setCookies.push(cookie('ecl_sess', '', 0));
      return out({ ok: true });
    }

    // ---- diagnosis -------------------------------------------------------------------
    if (path === '/api/diagnose' && method === 'POST') {
      let input;
      try {
        input = parseInput(await readJson(req));
      } catch (err) {
        if (err instanceof InputError) return out({ error: 'bad_input', message: err.message }, 400);
        throw err;
      }
      const q = await quota();
      if (!isPro) {
        if (q.remaining <= 0) return out({ error: 'quota_exceeded', quota: q }, 402);
        const ipUsed = (await store.get(`quota:${day}:ip:${ip}`))?.n ?? 0;
        if (ipUsed >= ipDaily) return out({ error: 'quota_exceeded', quota: { ...q, remaining: 0 } }, 402);
      }

      let result;
      try {
        result = await deps.diagnose(input);
      } catch (err) {
        console.error('diagnose failed', err);
        return out({ error: 'diagnosis_failed' }, 502);
      }

      if (!isPro) {
        await store.incr(`quota:${day}:${who}`);
        await store.incr(`quota:${day}:ip:${ip}`);
      }
      const diagnosis = input.code ? { ...result.diagnosis, code_info: input.code } : result.diagnosis;
      const item = {
        id: token().slice(0, 12),
        at: now,
        req: { make: input.car.make, model: input.car.model, year: input.car.year, code: input.code?.code ?? null, hadPhoto: Boolean(input.image) },
        d: diagnosis,
      };
      if (user) {
        const list = (await store.get(`history:${user.id}`)) ?? [];
        list.unshift(item);
        await store.set(`history:${user.id}`, list.slice(0, HISTORY_MAX));
      }
      return out({ ...diagnosis, item: { id: item.id, at: item.at, req: item.req }, meta: { model: result.model, live: env.LIVE === '1', quota: await quota() } });
    }

    // Code check with live web research (src/research/). Steps:
    //   basic    free, instant: exact code breakdown + NHTSA recalls.
    //   quick    one fast search (synchronous). Uses a daily check only if it found the definition.
    //   research extended two-stage search as a background job -> 202 { jobId }, then poll
    //            GET /api/check/<jobId>. Uses a daily check only when it succeeds.
    // Never charged for a knowledge-base hit or an error.
    if (path === '/api/check' && method === 'POST') {
      const canSpend = async () => {
        if (isPro) return true;
        if ((await quota()).remaining <= 0) return false;
        return ((await store.get(`quota:${day}:ip:${ip}`))?.n ?? 0) < ipDaily;
      };
      const kb = kbOn(store);
      const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
      const copy = req.clone(); // checkCode reads the body; the copy is for the history entry / job
      const body = await copy.json().catch(() => ({}));

      if (body.step === 'research') {
        const input = checkInput(body);
        if (input.error) return out({ error: input.error }, 400);
        if (!apiKey) return out({ error: 'not_configured' }, 500);
        const hit = await cachedAnswer(body, kb);
        if (hit) return out({ step: 'research', code: input.dtc, diagnosis: hit.diagnosis, cached: true, researched_at: hit.at, quota: await quota() });
        if (!(await canSpend())) return out({ error: 'no_credits', quota: await quota() }, 402);
        if (!deps.startJob) return out({ error: 'not_configured' }, 500);
        const jobId = token().slice(0, 24);
        const fields = ['code', 'make', 'model', 'year', 'engine', 'text', 'lang'];
        const jobInput = Object.fromEntries(fields.filter((k) => body[k] != null).map((k) => [k, String(body[k]).slice(0, 2000)]));
        await store.set(jobKey(jobId), { status: 'queued', input: jobInput, who, ip, day, pro: isPro, userId: user?.id ?? null, createdAt: now });
        try {
          await deps.startJob(jobId, url.origin);
        } catch (err) {
          console.error('job start failed', err);
          await store.set(jobKey(jobId), { status: 'failed', error: 'research_failed', who });
          return out({ error: 'research_failed' }, 502);
        }
        return out({ step: 'research', jobId, status: 'queued' }, 202);
      }

      const credits = { available: canSpend, async charge() {
        if (!isPro) {
          await store.incr(`quota:${day}:${who}`);
          await store.incr(`quota:${day}:ip:${ip}`);
        }
        return quota();
      } };
      const res = await checkCode(req, { apiKey, model: env.ANTHROPIC_MODEL, credits, kb, localizeNhtsa: createRecallTranslator({ apiKey, store }) });
      const data = await res.json();
      if (res.status === 402) return out({ ...data, quota: await quota() }, 402);
      if (res.status !== 200 || data.step === 'basic') return out(data, res.status);

      const item = historyItem(token().slice(0, 12), now, body, data);
      if (user && data.diagnosis?.definition?.found) await addHistory(store, user.id, item, HISTORY_MAX);
      return out({ ...data, quota: data.quota ?? (await quota()), item: { id: item.id, at: item.at, req: item.req } });
    }

    const jobMatch = path.match(/^\/api\/check\/([A-Za-z0-9_-]{8,64})$/);
    if (jobMatch && method === 'GET') {
      const job = await store.get(jobKey(jobMatch[1]));
      if (!job || job.who !== who) return out({ error: 'not_found' }, 404);
      let { status } = job;
      const stale = (status === 'queued' && now - job.createdAt > 5 * 60_000) || (status === 'running' && now - job.startedAt > JOB_STALE_MS);
      if (stale) status = 'failed';
      if (status === 'done') return out({ status, ...job.result, item: job.item, quota: await quota() });
      if (status === 'failed') return out({ status, error: job.error ?? 'research_failed', quota: await quota() });
      return out({ status });
    }

    if (path === '/api/scan-code' && method === 'POST') {
      if (!isPro) return out({ error: 'pro_required' }, 402);
      let image;
      try {
        image = parseImage(await readJson(req));
      } catch (err) {
        if (err instanceof InputError) return out({ error: 'bad_input', message: err.message }, 400);
        throw err;
      }
      try {
        const result = await deps.scan(image);
        return out({ codes: result.codes, meta: { live: env.LIVE === '1' } });
      } catch (err) {
        console.error('scan failed', err);
        return out({ error: 'scan_failed' }, 502);
      }
    }

    if (path === '/api/history' && method === 'GET') {
      if (!user) return out({ error: 'login_required' }, 401);
      return out({ items: (await store.get(`history:${user.id}`)) ?? [] });
    }

    if (path === '/api/waitlist' && method === 'POST') {
      const body = await readJson(req);
      const email = String(body.email ?? user?.email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return out({ error: 'bad_email' }, 400);
      if ((await store.incr(`rl:wait:${day}:ip:${ip}`)) > 10) return out({ error: 'too_many' }, 429);
      const key = `waitlist:${sha(email)}`;
      if (!(await store.get(key))) {
        await store.set(key, { email, at: now, lang: body.lang === 'ka' ? 'ka' : 'en', plan: ['monthly', 'yearly'].includes(body.plan) ? body.plan : null });
      }
      return out({ ok: true });
    }

    const codeMatch = path.match(/^\/api\/codes\/([^/]+)$/);
    if (codeMatch && method === 'GET') {
      const info = describeCode(decodeURIComponent(codeMatch[1]));
      return info ? out(info) : out({ error: 'invalid_code' }, 400);
    }

    return out({ error: 'not_found' }, 404);
  } catch (err) {
    console.error('api error', err);
    return out({ error: 'server_error' }, 500);
  }
}
