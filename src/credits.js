// Credit balances. 1 credit = 1 confirmed search answer (quick search with a definition,
// or an extended search). Balances live in the store under credits:<userId>; every change
// is also written to a short ledger (ledger:<userId>) for support questions.
// New accounts get FREE_CREDITS (default 3) once, on their first sign-in.

export const creditKey = (userId) => `credits:${userId}`;
const LEDGER_MAX = 200;

export async function balance(store, userId) {
  if (!userId) return 0;
  return Math.max(0, (await store.get(creditKey(userId)))?.n ?? 0);
}

/** Add (or with a negative delta, spend) credits. Returns the new balance. */
export async function addCredits(store, userId, delta, reason, now = Date.now()) {
  const n = await store.add(creditKey(userId), delta);
  const key = `ledger:${userId}`;
  const ledger = (await store.get(key)) ?? [];
  ledger.unshift({ at: now, delta, reason, balance: n });
  await store.set(key, ledger.slice(0, LEDGER_MAX));
  return Math.max(0, n);
}

/** Give the sign-up gift once per account. Returns the (possibly updated) user record. */
export async function grantSignupCredits(store, user, amount, now = Date.now()) {
  if (user.signupCredits || amount <= 0) return user;
  const updated = { ...user, signupCredits: true };
  await store.set(`user:${user.id}`, updated); // mark first, so a retry cannot grant twice
  await addCredits(store, user.id, amount, 'signup_gift', now);
  return updated;
}

/**
 * A purchase confirmed by the payment provider. Idempotent per paymentId, so a repeated
 * webhook never adds the credits twice. Returns false when it was already applied.
 */
export async function grantPurchase(store, { userId, packId, credits, paymentId }, now = Date.now()) {
  const key = `payment:${paymentId}`;
  if (await store.get(key)) return false;
  await store.set(key, { userId, packId, credits, at: now });
  await addCredits(store, userId, credits, `purchase:${packId}:${paymentId}`, now);
  return true;
}
