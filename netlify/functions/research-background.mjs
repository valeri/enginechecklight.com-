// Background function (name ends in -background): Netlify answers 202 at once and lets
// this run for up to 15 minutes. It only runs jobs that /api/check created (src/research/jobs.mjs).
import { runJob } from '../../src/research/jobs.mjs';
import { blobStore } from '../../src/store.js';

export default async (req) => {
  const { jobId } = await req.json().catch(() => ({}));
  await runJob(jobId, { store: await blobStore('ecl'), env: process.env });
};
