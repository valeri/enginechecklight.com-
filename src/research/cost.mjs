// What one search costs us, in USD. Prices from https://platform.claude.com/docs/en/about-claude/pricing
// (checked 2026-11-11). Update them here if Anthropic changes prices.
export const PRICES = {
  'claude-sonnet-5-5': { input: 2 / 1e6, output: 10 / 1e6 },
  'claude-haiku-5-5': { input: 0.1 / 1e6, output: 0.5 / 1e6 },
  'claude-opus-5-5': { input: 4 / 1e6, output: 20 / 1e6 },
};
export const WEB_SEARCH_USD = 10 / 1000;

// Hard cost caps per search. A search that reaches its cap is told to answer at once, and is
// stopped if it goes on. Together they bound what one credit can ever cost us.
export const QUICK_CAP_USD = 0.18;
export const EXTENDED_CAP_USD = 0.3;
export const WORST_CASE_PER_CREDIT_USD = QUICK_CAP_USD + EXTENDED_CAP_USD; // one credit = quick + extended of the same code

export function costOf(usage, model) {
  const p = PRICES[model] ?? PRICES['claude-opus-5-5']; // unknown model: assume the dearer price
  return (usage.input_tokens ?? 0) * p.input + (usage.output_tokens ?? 0) * p.output + (usage.web_searches ?? 0) * WEB_SEARCH_USD;
}
