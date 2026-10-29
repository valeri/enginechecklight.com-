import { handle } from '../../src/app.js';
import { buildDeps } from '../../src/runtime.js';
import { blobStore } from '../../src/store.js';

let cached;

export default async (req, context) => {
  cached ??= { deps: buildDeps(process.env), store: await blobStore('ecl') };
  return handle(req, { ...cached.deps, store: cached.store, ip: context.ip ?? 'unknown' });
};

export const config = { path: '/api/*' };
