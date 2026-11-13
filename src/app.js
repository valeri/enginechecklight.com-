// All API routes. Pure: takes a Request plus dependencies, returns a Response.
// The Netlify function (netlify/functions/api.mjs), the local dev server and the tests all call it.
import { createHash, randomBytes } from 'node:crypto';
import { InputError, parseImage, parseInput } from './diagnose.js';
import { describeCode } from './dtc.js';
import { loginEmail } from './email.js';
import checkCode, { cachedAnswer, checkInput } from './research/diagnose.mjs';
import { JOB_STALE_MS, addHistory, historyItem, jobKey, kbOn } from './research/jobs.mjs';
import { createRecallTranslator } from './research/translate.mjs';
import { addCredits, balance, grantSignupCredits } from './credits.js';
import { findPack, publicPacks } from './packs.js';

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
 * deps.createCheckout?({ user, pack, origin }) -> { url }   (payment provider, see src/payments.js)
 * env keys used: FREE_CREDITS, PRO_EMAILS (testers: no credits needed), SITE_URL, DEV_LOGIN_LINKS, LIVE,
 *   ANTHROPIC_API_KEY, ANTHROPIC_MODEL, DAILY_SPEND_LIMIT_USD, USD_RATE, PAYMENT_FEE
 */
export async function handle(req, deps) {
  const { store, env = {}, ip = 'unknown' } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;
  const freeCredits = Number(env.FREE_CREDITS ?? 3);
  const spendLimitUsd = Number(env.DAILY_SPEND_LIMIT_USD ?? 20);
  const priceOpts = { usdRate: Number(env.USD_RATE ?? 2.75), paymentFee: Number(env.PAYMENT_FEE ?? 0.035) };
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
  // Testers in PRO_EMAILS search without spending credits.
  const unlimited = Boolean(user && (user.pro || proEmails.has(user.email)));
  let deviceId = cookies.ecl_dev;
  if (!deviceId || deviceId.length > 64) {
    deviceId = token().slice(0, 24);
    setCookies.push(cookie('ecl_dev', deviceId, 400 * 86400));
  }
  const who = user ? `u:${user.id}` : `d:${deviceId}`;
  const day = dayKey(now);

  // ---- credits ----------------------------------------------------------------------------
  // 1 credit = 1 answer. Only signed-in users have credits (new accounts get FREE_CREDITS once).
  async function wallet() {
    return { balance: user ? await balance(store, user.id) : 0, unlimited, signedIn: Boolean(user) };
  }
  const canSpend = async () => Boolean(user) && (unlimited || (await balance(store, user.id)) >= 1);
  const spend = async (reason) => {
    if (user && !unlimited) await addCredits(store, user.id, -1, reason, now);
    return wallet();
  };
  const noCredits = async () => out({ error: 'no_credits', need_login: !user, credits: await wallet() }, 402);
  // Our daily AI spend in micro-USD; past DAILY_SPEND_LIMIT_USD paid searches pause until tomorrow.
  const spendKey = `spend:${day}`;
  const recordSpend = async (usd) => { if (usd > 0) await store.add(spendKey, Math.round(usd * 1e6)); };
  const overSpendLimit = async () => ((await store.get(spendKey))?.n ?? 0) >= spendLimitUsd * 1e6;

  const out = (data, status = 200, extra = {}) => {
    const res = json(data, status, extra);
    for (const c of setCookies) res.headers.append('set-cookie', c);
    return res;
  };

  try {
    // ---- account ----------------------------------------------------------------------
    if (path === '/api/me' && method === 'GET') {
      return out({
        user: user ? { email: user.email } : null,
        credits: await wallet(),
        packs: publicPacks(priceOpts),
        features: { login: loginEnabled, live: env.LIVE === '1', payments: Boolean(deps.createCheckout), freeCredits },
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
      let account = await store.get(`user:${userId}`);
      if (!account) {
        account = { id: userId, email: login.email, createdAt: now, lang: login.lang };
        await store.set(`user:${userId}`, account);
      }
      // Sign-up gift, once per account. At most 2 gifts per IP per day, so new emails can't farm it.
      if (!account.signupCredits && (await store.incr(`rl:gift:${day}:ip:${ip}`)) <= 2) {
        await grantSignupCredits(store, account, freeCredits, now);
      }
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
      if (!(await canSpend())) return noCredits();

      let result;
      try {
        result = await deps.diagnose(input);
      } catch (err) {
        console.error('diagnose failed', err);
        return out({ error: 'diagnosis_failed' }, 502);
      }

      const credits = await spend('diagnose');
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
      return out({ ...diagnosis, item: { id: item.id, at: item.at, req: item.req }, meta: { model: result.model, live: env.LIVE === '1', credits } });
    }

    // Code check with live web research (src/research/). Steps:
    //   basic    free, instant: exact code breakdown + NHTSA recalls.
    //   quick    one fast search (synchronous). Costs 1 credit when it returns an answer.
    //   research extended two-stage search as a background job -> 202 { jobId }, then poll
    //            GET /api/check/<jobId>. Free if the user already paid for this code + car in the
    //            last 24 h (the quick search found no definition); otherwise 1 credit on success.
    // Never charged for a knowledge-base hit or an error. Every search has a hard cost cap
    // (src/research/cost.mjs), and our total AI spend per day is capped (DAILY_SPEND_LIMIT_USD).
    if (path === '/api/check' && method === 'POST') {
      const kb = kbOn(store);
      const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
      const copy = req.clone(); // checkCode reads the body; the copy is for the history entry / job
      const body = await copy.json().catch(() => ({}));
      const step = ['quick', 'research'].includes(body.step) ? body.step : 'basic';
      const localizeNhtsa = createRecallTranslator({ apiKey, store });
      if (step === 'basic') return checkCode(req, { apiKey, localizeNhtsa }).then(async (r) => out(await r.json(), r.status));

      const input = checkInput(body);
      if (input.error) return out({ error: input.error }, 400);
      if (!apiKey) return out({ error: 'not_configured' }, 500);
      const hit = await cachedAnswer(body, kb);
      if (hit) return out({ step, code: input.dtc, diagnosis: hit.diagnosis, cached: true, researched_at: hit.at, credits: await wallet() });

      // One credit covers a code: quick search, then the extended search of the same code + car.
      const passKey = user ? `pass:${user.id}:${sha(JSON.stringify([input.dtc?.full, input.car, input.lang, input.text]))}` : null;
      const pass = passKey ? await store.get(passKey) : null;
      const prepaid = Boolean(pass && pass.exp > now);
      if (!prepaid && !(await canSpend())) return noCredits();
      if (await overSpendLimit()) return out({ error: 'busy' }, 503);
      const failKey = `rl:fail:${day}:${user.id}`;
      if (((await store.get(failKey))?.n ?? 0) >= 5) return out({ error: 'rate_limited' }, 429);

      if (step === 'research') {
        if (!deps.startJob) return out({ error: 'not_configured' }, 500);
        const jobId = token().slice(0, 24);
        const fields = ['code', 'make', 'model', 'year', 'engine', 'text', 'lang'];
        const jobInput = Object.fromEntries(fields.filter((k) => body[k] != null).map((k) => [k, String(body[k]).slice(0, 2000)]));
        await store.set(jobKey(jobId), { status: 'queued', input: jobInput, who, userId: user.id, unlimited, prepaid, passKey, createdAt: now });
        try {
          await deps.startJob(jobId, url.origin);
        } catch (err) {
          console.error('job start failed', err);
          await store.set(jobKey(jobId), { status: 'failed', error: 'research_failed', who });
          return out({ error: 'research_failed' }, 502);
        }
        return out({ step, jobId, status: 'queued', prepaid }, 202);
      }

      // quick
      const credits = { available: async () => true, charge: async () => undefined }; // charged below, after success
      const res = await checkCode(req, { apiKey, model: env.ANTHROPIC_MODEL, credits, kb, localizeNhtsa });
      const data = await res.json();
      await recordSpend(data.usage?.cost_usd ?? 0);
      if (res.status !== 200) {
        if (res.status >= 500 || res.status === 429) await store.incr(failKey);
        return out(data, res.status);
      }
      if (!prepaid) {
        await spend(`quick:${data.code?.full ?? 'text'}`);
        await store.set(passKey, { exp: now + DAY_MS });
      }
      const item = historyItem(token().slice(0, 12), now, body, data);
      if (data.diagnosis?.definition?.found) await addHistory(store, user.id, item, HISTORY_MAX);
      return out({ ...data, charged: !prepaid, extend_included: Boolean(data.can_extend), credits: await wallet(), item: { id: item.id, at: item.at, req: item.req } });
    }

    const jobMatch = path.match(/^\/api\/check\/([A-Za-z0-9_-]{8,64})$/);
    if (jobMatch && method === 'GET') {
      const job = await store.get(jobKey(jobMatch[1]));
      if (!job || job.who !== who) return out({ error: 'not_found' }, 404);
      let { status } = job;
      const stale = (status === 'queued' && now - job.createdAt > 5 * 60_000) || (status === 'running' && now - job.startedAt > JOB_STALE_MS);
      if (stale) status = 'failed';
      if (status === 'done') return out({ status, ...job.result, item: job.item, credits: await wallet() });
      if (status === 'failed') return out({ status, error: job.error ?? 'research_failed', credits: await wallet() });
      return out({ status });
    }

    // Read trouble codes from a photo. Free for signed-in users, 20 per day.
    if (path === '/api/scan-code' && method === 'POST') {
      if (!user) return out({ error: 'login_required' }, 401);
      if ((await store.incr(`rl:scan:${day}:${user.id}`)) > 20) return out({ error: 'too_many' }, 429);
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

    // Buy a credit pack: the payment provider returns a checkout page to send the user to.
    // Credits are added only by the provider's confirmed payment (grantPurchase in src/credits.js).
    if (path === '/api/credits/checkout' && method === 'POST') {
      if (!user) return out({ error: 'login_required' }, 401);
      const { packId } = await readJson(req);
      const pack = publicPacks(priceOpts).find((p) => p.id === packId);
      if (!pack || !findPack(packId)) return out({ error: 'bad_pack' }, 400);
      if (!pack.buyable) return out({ error: 'pack_unavailable' }, 409); // no price yet, or below the no-loss floor
      if (!deps.createCheckout) return out({ error: 'payments_unavailable' }, 503);
      try {
        const { url: checkoutUrl } = await deps.createCheckout({ user, pack, origin: url.origin });
        return out({ url: checkoutUrl });
      } catch (err) {
        console.error('checkout failed', err);
        return out({ error: 'checkout_failed' }, 502);
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
