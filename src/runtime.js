// Builds the app's dependencies from environment variables. Used by the Netlify function and dev server.
import { createDiagnoser, createScanner } from './diagnose.js';
import { createEmailSender } from './email.js';

export function buildDeps(env) {
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  // No API key yet, an empty one from .env (or MOCK=1): run in demo mode with a fixed sample answer.
  const mock = env.MOCK === '1' || !apiKey;
  return {
    env: { ...env, LIVE: mock ? '0' : '1' },
    diagnose: createDiagnoser({ apiKey, mock }),
    scan: createScanner({ apiKey, mock }),
    sendEmail: createEmailSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM }),
  };
}
