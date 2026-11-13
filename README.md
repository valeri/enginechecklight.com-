# EngineCheckLight — enginechecklight.com

AI car diagnosis web app. Static front end in `public/`, API in one Netlify Function (`netlify/functions/api.mjs` → `src/app.js`), data in Netlify Blobs.

## Run locally
    npm install
    npm run dev        # http://localhost:8888, demo mode, sign-in link shown on screen
    npm test

## Deploy (Netlify site: fancy-choux-7c5271)
Functions do not deploy by drag-and-drop. Use one of:
- Git: push this folder to GitHub, then Netlify → Site configuration → Build & deploy → Link repository. No build command, publish `public`.
- CLI: `npx netlify-cli login` then `npx netlify-cli deploy --prod --site fancy-choux-7c5271`.

## Environment variables (Netlify → Site configuration → Environment variables)
| Name | Value | Needed for |
|---|---|---|
| SITE_URL | https://enginechecklight.com | sign-in links |
| ANTHROPIC_API_KEY | from console.anthropic.com | live AI (without it: demo mode) |
| ANTHROPIC_MODEL | optional, default claude-sonnet-5-5 | model for live code research |
| RESEND_API_KEY | from resend.com | sign-in emails (without it: sign-in hidden) |
| EMAIL_FROM | EngineCheckLight <login@enginechecklight.com> | sender (domain verified in Resend) |
| PRO_EMAILS | comma-separated emails | testers: search without spending credits |
| FREE_CREDITS | 3 | sign-up gift per new account (max 2 gifts per IP per day) |
| DAILY_SPEND_LIMIT_USD | 20 | our AI spend cap per day; paid searches pause past it |
| USD_RATE / PAYMENT_FEE | 2.75 / 0.035 | GEL per USD and the payment fee, for the no-loss price floor |

## Credits
1 credit = 1 answer (quick search, plus the extended search of the same code within 24 h). Code breakdown and recalls are free. Packs and prices: `src/packs.js`. A pack can be bought only if its price per credit keeps 50% margin in the worst case (`minPricePerCredit`, currently ≈ 3.42 ₾ per credit). Payments (Payze): `src/payments.js`, not connected yet.

## API
GET /api/me · POST /api/auth/start · GET /api/auth/verify · POST /api/auth/logout · POST /api/diagnose · POST /api/check (code + live web research, see docs/real-search.md) · POST /api/credits/checkout · POST /api/scan-code (Pro) · GET /api/history · POST /api/waitlist · GET /api/codes/:code
