import assert from "node:assert/strict";
import { parseDtc } from "../src/research/lib/dtc.mjs";
import { tierOf, officialDomains } from "../src/research/lib/sources.mjs";
import handler from "../src/research/diagnose.mjs";

// --- decoder ---
let d = parseDtc("b143c-11");
assert.equal(d.full, "B143C-11"); assert.equal(d.system, "body"); assert.equal(d.scope, "manufacturer");
assert.equal(d.failure_type.meaning, "Circuit short to ground");
d = parseDtc("B143C11"); assert.equal(d.full, "B143C-11");
d = parseDtc("P0401"); assert.equal(d.scope, "generic"); assert.equal(d.subsystem, "auxiliary_emission"); assert.equal(d.failure_type, null);
assert.equal(parseDtc("P1234").scope, "manufacturer");
assert.equal(parseDtc("P2002").scope, "generic");
assert.equal(parseDtc("P3100").scope, "manufacturer");
assert.equal(parseDtc("P3400").scope, "generic");
assert.equal(parseDtc("U0100-87").failure_type.meaning, "Missing message");
assert.equal(parseDtc("U0100-8F").failure_type.meaning, null);
assert.equal(parseDtc("U0100-8F").failure_type.category, "Bus signal / message failure");
for (const bad of ["", "X0100", "P4000", "P010", "P01000", "P0100-1", "hello"]) assert.equal(parseDtc(bad), null, bad);

// --- tiers ---
assert.equal(tierOf("https://static.nhtsa.gov/odi/tsbs/2019/x.pdf", "Audi"), "official_government");
assert.equal(tierOf("https://www.landrover.com/x", "Land Rover"), "official_manufacturer");
assert.equal(tierOf("https://www.landrover.com/x", "Audi"), "community");
assert.equal(tierOf("https://fakenhtsa.gov.evil.com/x", "Audi"), "community");
assert.equal(tierOf("not a url", "Audi"), null);
assert.ok(officialDomains("land rover").includes("landrover.com"));

// --- handler with mocked network ---
const calls = [];
const TSB = "https://static.nhtsa.gov/odi/tsbs/2018/MC-1.pdf";
const FORUM = "https://forum.example.com/t/1";
let stage = 0;
globalThis.fetch = async (url, opts) => {
  url = String(url);
  if (url.includes("api.nhtsa.gov/recalls")) return Response.json({ Count: 1, results: [{ NHTSACampaignNumber: "18V123000", Component: "ENGINE", Summary: "s", Remedy: "r", ReportReceivedDate: "01/02/2018" }] });
  if (url.includes("api.nhtsa.gov/complaints")) return Response.json({ count: 2, results: [{ odiNumber: 1, summary: "Code P0401 came on", components: "ENGINE" }, { odiNumber: 2, summary: "noise" }] });
  if (url.includes("api.anthropic.com")) {
    const body = JSON.parse(opts.body); calls.push(body); stage++;
    if (stage === 1) return Response.json({ stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } }, content: [
      { type: "web_search_tool_result", content: [{ type: "web_search_result", url: TSB, title: "TSB" }] },
      { type: "tool_use", name: "submit_diagnosis", input: { definition: { found: true, text: "EGR flow insufficient", source_url: TSB }, summary: "s", severity: "medium", safe_to_drive: "yes", safety_note: "n", causes: [], confidence: "high" } } ] });
    if (stage === 2) return Response.json({ stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [
      { type: "web_search_tool_result", content: [{ type: "web_search_result", url: FORUM, title: "Forum" }] }, { type: "text", text: "thinking" } ] });
    return Response.json({ stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 }, content: [
      { type: "tool_use", name: "submit_diagnosis", input: { definition: { found: true, text: "forum says", source_url: FORUM }, summary: "s", severity: "medium", safe_to_drive: "yes", safety_note: "n",
        causes: [{ name: "EGR valve", likelihood: 1, explanation: "e", source_urls: [FORUM, "https://invented.example.com/x"] }], bulletins: [{ title: "fake", url: "https://invented.example.com/tsb" }, { title: "real", url: TSB }], confidence: "high" } } ] });
  }
  throw new Error("unexpected fetch " + url);
};
const call = async (b) => { const r = await handler(new Request("http://x/", { method: "POST", body: JSON.stringify(b) })); return [r.status, await r.json()]; };
const car = { make: "Land Rover", model: "Range Rover Sport", year: "2016", code: "P0401" };

let [st, out] = await call({ ...car, step: "basic" });
assert.equal(st, 200); assert.equal(out.nhtsa.recalls.length, 1); assert.equal(out.nhtsa.complaints_with_code.length, 1); assert.equal(calls.length, 0);

[st] = await call({ ...car, code: "ZZZ", step: "basic" }); assert.equal(st, 400);
[st, out] = await call({ ...car, step: "research" }); assert.equal(st, 500); // no key

process.env.ANTHROPIC_API_KEY = "test";
[st, out] = await call({ ...car, step: "research", lang: "ka" });
assert.equal(st, 200);
const g = out.diagnosis;
assert.ok(calls[0].tools[0].allowed_domains.includes("nhtsa.gov"));       // stage A official only
assert.equal(calls[1].tools[0].allowed_domains, undefined);                // stage B open
assert.deepEqual(calls[2].tool_choice, { type: "tool", name: "submit_diagnosis" }); // forced after end_turn
assert.equal(g.definition.source_url, TSB); assert.equal(g.definition.official, true); // official wins
assert.deepEqual(g.causes[0].source_urls, [FORUM]);                        // invented URL dropped
assert.equal(g.bulletins.length, 1); assert.equal(g.bulletins[0].url, TSB);
assert.equal(g.sources.find((s) => s.url === TSB).tier, "official_government");
assert.equal(g.sources.find((s) => s.url === FORUM).tier, "community");
assert.equal(out.usage.web_searches, 1); assert.equal(out.usage.stages, 2);
assert.match(calls[0].system, /Georgian/);
console.log("all tests passed");
