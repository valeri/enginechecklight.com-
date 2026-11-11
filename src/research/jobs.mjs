// Extended search as a background job. The router (src/app.js) checks the user's checks,
// stores job:<id> as "queued" and starts it: on Netlify through the background function
// netlify/functions/research-background.mjs (15-minute limit), in local dev in-process.
// Everything the job needs is read from the store, so calling the background function
// with a made-up or already used id does nothing.
import checkCode from './diagnose.mjs';
import { createRecallTranslator } from './translate.mjs';

export const JOB_STALE_MS = 16 * 60_000; // background functions stop at 15 minutes
export const jobKey = (id) => `job:${id}`;
export const kbOn = (store) => ({ get: (k) => store.get(`kb:${k}`), set: (k, v) => store.set(`kb:${k}`, v) });

/** History entry for a finished research answer (same shape for quick and extended). */
export function historyItem(id, at, body, data) {
  return {
    id,
    at,
    kind: 'research',
    req: { make: body.make || undefined, model: body.model || undefined, year: body.year || undefined, code: data.code?.full ?? null, hadPhoto: false },
    d: data.diagnosis,
    basic: { code: data.code, nhtsa: data.nhtsa },
  };
}

export async function addHistory(store, userId, item, max = 50) {
  const list = (await store.get(`history:${userId}`)) ?? [];
  list.unshift(item);
  await store.set(`history:${userId}`, list.slice(0, max));
}

export async function runJob(id, { store, env, now = Date.now }) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(id ?? ''))) return;
  const key = jobKey(id);
  const job = await store.get(key);
  if (!job || job.status !== 'queued') return;
  await store.set(key, { ...job, status: 'running', startedAt: now() });

  const credits = {
    available: async () => true, // checked by the router before the job was created
    async charge() {
      if (!job.pro) {
        await store.incr(`quota:${job.day}:${job.who}`);
        await store.incr(`quota:${job.day}:ip:${job.ip}`);
      }
    },
  };
  let status = 500, data = { error: 'research_failed' };
  try {
    const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
    const res = await checkCode(new Request('http://job.local/', { method: 'POST', body: JSON.stringify({ ...job.input, step: 'research' }) }), {
      apiKey, model: env.ANTHROPIC_MODEL, credits, kb: kbOn(store), localizeNhtsa: createRecallTranslator({ apiKey, store }),
    });
    status = res.status;
    data = await res.json();
  } catch (err) {
    console.error('job failed', err);
  }

  if (status !== 200) {
    await store.set(key, { ...job, status: 'failed', error: data.error ?? 'research_failed', finishedAt: now() });
    return;
  }
  const item = historyItem(id, now(), job.input, data);
  if (job.userId) await addHistory(store, job.userId, item);
  await store.set(key, { ...job, status: 'done', finishedAt: now(), result: data, item: { id: item.id, at: item.at, req: item.req } });
}
