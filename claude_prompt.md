You are working in my repo for EngineCheckLight (enginechecklight.com), an AI car-diagnostics app deployed on Netlify. Reply to me in Georgian.

GOAL
Wire real web-search diagnosis into the app. The backend is already written and unit-tested; the files are in `_incoming/`. Your job is to integrate them into this codebase, connect the UI and my credits system, and verify it with real calls locally.

STEP 0 — LOOK BEFORE YOU CHANGE ANYTHING
Read the repo and tell me in a short summary: framework and build tool, where Netlify functions live (check netlify.toml), how the app currently produces a diagnosis, where the credits logic is and how it stores balances, and whether any AI/API calls already exist. If an existing diagnose function overlaps with the new one, stop and ask me which to keep before replacing it.

STEP 1 — PLACE THE FILES
Move from `_incoming/` to:
- diagnose.mjs        -> <functions dir>/diagnose.mjs
- dtc.mjs, sources.mjs, nhtsa.mjs -> <functions dir>/lib/
- diagnoseClient.js   -> the front-end source folder, converted to the project's module style / TypeScript if the project uses it
- run.mjs             -> test/run.mjs (fix import paths if the functions dir differs)
- README.md           -> docs/real-search.md
Then delete `_incoming/`. Install `@netlify/blobs`. Run `node test/run.mjs`; it must print "all tests passed".

STEP 2 — HOW THE BACKEND WORKS (do not change this behaviour)
POST /.netlify/functions/diagnose with { step, code, make, model, year, engine, text, lang }.
- step "basic": instant, free, no AI. Returns exact code structure (system, generic vs manufacturer, failure-type suffix such as -11) plus NHTSA recalls and owner complaints.
- step "research": paid. Stage A searches official domains only (government, standards, manufacturer). Stage B searches the open web only if stage A did not find the definition or causes. An official definition always wins.
- Accuracy guards that must stay: the model may not guess a manufacturer-specific code; every returned URL must be one the search actually returned (others are dropped); each source carries a tier; confidence "high" only for an official definition.
- Answers with a found definition are cached in Netlify Blobs (knowledge base) and reused without an AI call.

STEP 3 — CREDITS
In diagnose.mjs, `chargeCredit(req)` is an empty hook. Connect it to my existing credits system:
- identify the user the same way the rest of the app does;
- "basic" is always free;
- "research" costs one credit, deducted only after a successful result, never for a knowledge-base hit (cached: true) and never on an error;
- no credits -> HTTP 402 { error: "no_credits" }.
If the credits system is not finished enough to do this, tell me what is missing instead of inventing a new one.

STEP 4 — UI
On the diagnosis flow:
- call diagnoseBasic first and show its result immediately (code breakdown, suffix meaning, recalls);
- then call diagnoseResearch and show: definition with its source link and tier badge, a clear "definition not found in sources" state when definition.found is false, causes with likelihood bars and source links, bulletins, cost range, driver checks, confidence, and a sources list grouped by tier using TIER_LABEL (en + ka);
- the code input must accept a suffix (B143C-11 and B143C11), so remove any 5/6-character limit;
- handle errors: invalid_code, need_code_or_text, no_credits (send to the credits purchase screen), rate_limited, research_failed, not_configured;
- keep the existing visual style and both languages (en, ka). Do not redesign screens.

STEP 5 — CONFIG
- Add ANTHROPIC_API_KEY to the local env file used by `netlify dev` and make sure that file is in .gitignore. Never print the key or commit it. Ask me for the key; do not look for one elsewhere.
- Optional ANTHROPIC_MODEL, default "claude-sonnet-5-5".
- Tell me which env variables I must add in the Netlify dashboard.

STEP 6 — VERIFY WITH REAL CALLS
Run `netlify dev` and test these, showing me the actual JSON for each:
1. basic   — P0401, Land Rover Range Rover Sport 2016
2. research — P0401, same car, lang "ka"
3. research — B143C-11, same car (manufacturer-specific with suffix)
4. research — same request as 2 again; must return cached: true
5. invalid code "ZZZ" -> 400
For 2 and 3 report: seconds taken, usage (tokens, web_searches, stages), definition.found, definition.tier, confidence, and whether stage A alone was enough.
If stage A fails with a 400 because the API rejects a domain in the allowed list, find which domain from the error, remove it from sources.mjs, and tell me.

STEP 7 — TIMEOUT
Check the synchronous function time limit for my Netlify plan against the measured times from step 6. If research can exceed it, propose (do not build yet) a background-function version with polling, and wait for my decision.

RULES
- Do not commit or push. Show me a summary of changed files and wait.
- Do not add new dependencies beyond @netlify/blobs without asking.
- Do not weaken the accuracy guards or the official-first order to make a test pass.
- If something in the repo contradicts these instructions, stop and ask.