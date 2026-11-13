// Payment provider (Payze). Not connected yet: until it is, the "Buy" buttons show
// "payments are being connected" and no money is taken.
//
// To connect, implement:
//   createCheckout({ user, pack, origin }) -> { url }
//     create a Payze payment for pack.price (pack.currency), with our own reference
//     `${user.id}:${pack.id}:<random>`, success/fail return URLs on `origin`, and return the
//     payment page URL.
//   a webhook route (e.g. POST /api/payments/payze) that verifies the provider's signature,
//     then calls grantPurchase(store, { userId, packId, credits, paymentId }) from src/credits.js.
//     grantPurchase is idempotent per paymentId, so a repeated webhook never adds credits twice.
// Credits must only ever be added from the verified webhook, never from the browser's return URL.

export function createCheckoutFromEnv(_env) {
  return null; // not connected
}
