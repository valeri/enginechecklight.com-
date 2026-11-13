// Credit packs shown on the "Buy credits" screen. 1 credit = 1 confirmed search answer.
// Edit credits and prices here. A pack whose price is null is shown but cannot be bought yet.
//   price: amount in `currency`, e.g. 9 or 9.5
export const CURRENCY = 'GEL';

export const PACKS = [
  { id: 'small', credits: 5, price: null },
  { id: 'medium', credits: 15, price: null, popular: true },
  { id: 'large', credits: 40, price: null },
];

export const findPack = (id) => PACKS.find((p) => p.id === id) ?? null;

// ---- never sell at a loss ------------------------------------------------------------------
// A pack can be bought only if every credit in it keeps at least MIN_MARGIN profit even in the
// worst case: the most a credit can cost us (quick + extended search of the same code, both at
// their hard caps), times a safety factor, after the payment provider's fee.
import { WORST_CASE_PER_CREDIT_USD } from './research/cost.mjs';

export const MIN_MARGIN = 0.5; // profit / price after fees
export const SAFETY = 1.25; // a search turn can overshoot its cap a little before it is stopped

/** Lowest allowed price for one credit, in CURRENCY. */
export function minPricePerCredit({ usdRate = 2.75, paymentFee = 0.035 } = {}) {
  return (WORST_CASE_PER_CREDIT_USD * SAFETY * usdRate) / ((1 - paymentFee) * (1 - MIN_MARGIN));
}

/** Packs as the app shows them: which can be bought, and the lowest allowed price of each. */
export function publicPacks(opts) {
  const floor = minPricePerCredit(opts);
  return PACKS.map((p) => {
    const minPrice = Math.ceil(floor * p.credits * 100) / 100;
    const buyable = typeof p.price === 'number' && p.price >= minPrice;
    return { id: p.id, credits: p.credits, price: p.price, currency: CURRENCY, popular: Boolean(p.popular), buyable, min_price: minPrice };
  });
}
