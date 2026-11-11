import { handle } from '../../src/app.js';
import { buildDeps } from '../../src/runtime.js';
import { blobStore } from '../../src/store.js';

// Extended research runs in netlify/functions/research-background.mjs (answers 202 at once).
async function startJob(jobId, origin) {
  const res = await fetch(`${origin}/.netlify/functions/research-background`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId }),
  });
  if (res.status !== 202 && !res.ok) throw new Error(`background start ${res.status}`);
}

let cached;

export default async (req, context) => {
  cached ??= { deps: buildDeps(process.env), store: await blobStore('ecl') };
  return handle(req, { ...cached.deps, store: cached.store, startJob, ip: context.ip ?? 'unknown' });
};

export const config = { path: '/api/*' };
