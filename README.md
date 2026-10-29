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
| RESEND_API_KEY | from resend.com | sign-in emails (without it: sign-in hidden) |
| EMAIL_FROM | EngineCheckLight <login@enginechecklight.com> | sender (domain verified in Resend) |
| PRO_EMAILS | comma-separated emails | Pro for testers |
| FREE_DAILY / IP_DAILY | 3 / 15 | optional limits |

## API
GET /api/me · POST /api/auth/start · GET /api/auth/verify · POST /api/auth/logout · POST /api/diagnose · POST /api/scan-code (Pro) · GET /api/history · POST /api/waitlist · GET /api/codes/:code
