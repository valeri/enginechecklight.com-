import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './prompts.js';
import { describeCode, normaliseCode } from './dtc.js';

export const MODELS = {
  fast: 'claude-haiku-5-5', // code / text only
  vision: 'claude-sonnet-5-5', // any photo
};

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const SAFE = ['yes', 'short_distance', 'no'];
const SOUND_TYPES = ['knock', 'squeal', 'grind', 'hiss', 'rattle', 'click', 'whine', 'clunk', 'hum'];
const SOUND_WHEN = ['start', 'idle', 'accelerate', 'brake', 'turn', 'bumps', 'always'];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export class InputError extends Error {}

/** Validate and normalise the request body. Throws InputError. */
export function parseInput(body = {}) {
  const car = body.car && typeof body.car === 'object' ? body.car : {};
  const clean = (v, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
  const year = Number(car.year);

  const input = {
    lang: clean(body.lang, 5) || 'en',
    region: clean(body.region, 40),
    car: {
      make: clean(car.make),
      model: clean(car.model),
      year: Number.isInteger(year) && year > 1950 && year < 2100 ? year : undefined,
      engine: clean(car.engine),
      mileage_km: Number.isFinite(Number(car.mileage_km)) ? Number(car.mileage_km) : undefined,
    },
    code: null,
    sound: null,
    text: clean(body.text, 2000),
    image: null,
  };

  if (body.code) {
    const info = describeCode(body.code);
    if (!info) throw new InputError('Invalid trouble code format (expected e.g. P0301 or B143C-11)');
    input.code = info;
  }

  if (body.sound) {
    const { type, when } = body.sound;
    if (!SOUND_TYPES.includes(type)) throw new InputError(`sound.type must be one of ${SOUND_TYPES.join(', ')}`);
    const whens = (Array.isArray(when) ? when : [when]).filter((w) => SOUND_WHEN.includes(w));
    input.sound = { type, when: whens };
  }

  if (body.image) {
    const { media_type, data } = body.image;
    if (!IMAGE_TYPES.includes(media_type)) throw new InputError('image.media_type must be jpeg, png or webp');
    if (typeof data !== 'string' || data.length === 0) throw new InputError('image.data must be base64');
    if ((data.length * 3) / 4 > MAX_IMAGE_BYTES) throw new InputError('Image too large (max 4 MB)');
    input.image = { media_type, data };
  }

  if (!input.code && !input.sound && !input.text && !input.image) {
    throw new InputError('Give at least one of: code, sound, text, image');
  }
  return input;
}

export function pickModel(input) {
  return input.image ? MODELS.vision : MODELS.fast;
}

function describeForModel(input) {
  const { car } = input;
  const lines = [`lang: ${input.lang}`];
  if (input.region) lines.push(`region: ${input.region}`);
  const carLine = [car.year, car.make, car.model, car.engine].filter(Boolean).join(' ');
  lines.push(`car: ${carLine || 'unknown'}${car.mileage_km ? `, ${car.mileage_km} km` : ''}`);
  if (input.code) {
    lines.push(
      `trouble code: ${input.code.code} (${input.code.system}, ${input.code.generic ? 'generic' : 'manufacturer-specific'})` +
        (input.code.meaning ? ` — standard meaning: ${input.code.meaning}` : ''),
    );
    if (input.code.ftb) {
      lines.push(
        `failure type: -${input.code.ftb}${input.code.ftbMeaning ? ` = ${input.code.ftbMeaning}` : ' (not in the SAE J2012-DA list)'} (base code ${input.code.base}). ` +
          'Use the failure type to narrow the cause, e.g. short to ground vs open circuit.',
      );
    }
  }
  if (input.sound) lines.push(`sound: ${input.sound.type}, happens when: ${input.sound.when.join(', ') || 'not specified'}`);
  if (input.text) lines.push(`driver says: """${input.text}"""`);
  if (input.image) lines.push('a photo from the driver is attached');
  return lines.join('\n');
}

const CONFIDENCE = ['high', 'medium', 'low'];

/** Clean the optional code_details block. Returns null when there is nothing useful in it. */
export function parseCodeDetails(cd) {
  if (!cd || typeof cd !== 'object') return null;
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const title = str(cd.title, 200);
  const what = str(cd.what_it_means, 800);
  if (!title && !what) return null;
  return {
    code: normaliseCode(cd.code) ?? str(cd.code, 12),
    title,
    module: str(cd.module, 120),
    component: str(cd.component, 160),
    failure_type: str(cd.failure_type, 400),
    what_it_means: what,
    where_to_look: (Array.isArray(cd.where_to_look) ? cd.where_to_look : [])
      .map((x) => str(x, 200))
      .filter(Boolean)
      .slice(0, 4),
    confidence: CONFIDENCE.includes(cd.confidence) ? cd.confidence : 'low',
  };
}

/** Pull the first JSON object out of the model text and check its shape. */
export function parseDiagnosis(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON in model response');
  const d = JSON.parse(text.slice(start, end + 1));

  if (typeof d.summary !== 'string' || !d.summary) throw new Error('missing summary');
  if (!SEVERITIES.includes(d.severity)) throw new Error('bad severity');
  if (!SAFE.includes(d.safe_to_drive)) throw new Error('bad safe_to_drive');
  if (!Array.isArray(d.causes) || d.causes.length === 0) throw new Error('missing causes');

  return {
    summary: d.summary,
    severity: d.severity,
    safe_to_drive: d.safe_to_drive,
    safety_note: d.safety_note ?? '',
    causes: d.causes.slice(0, 4).map((c) => ({
      name: String(c.name ?? ''),
      likelihood: Math.min(1, Math.max(0, Number(c.likelihood) || 0)),
      explanation: String(c.explanation ?? ''),
    })),
    diy_checks: (d.diy_checks ?? []).slice(0, 4).map(String),
    repair_cost: d.repair_cost ?? null,
    questions: (d.questions ?? []).slice(0, 3).map(String),
    disclaimer: d.disclaimer ?? 'AI estimate — confirm with a mechanic before major repairs.',
    code_details: parseCodeDetails(d.code_details),
  };
}

export const MOCK_DIAGNOSIS = {
  summary: 'EGR valve or EGR cooler is clogged with soot, so not enough exhaust gas is recirculated.',
  severity: 'medium',
  safe_to_drive: 'yes',
  safety_note: 'Safe to drive for now, but power may drop and the DPF can clog faster if ignored.',
  causes: [
    { name: 'Clogged EGR valve', likelihood: 0.55, explanation: 'Very common on 3.0 SDV6 engines after 100,000 km of city driving.' },
    { name: 'Blocked EGR cooler', likelihood: 0.25, explanation: 'Soot builds up inside the cooler passages.' },
    { name: 'Faulty EGR position sensor or wiring', likelihood: 0.2, explanation: 'The valve may be fine but report wrong position.' },
  ],
  diy_checks: ['Do a 20-minute motorway drive at steady speed, then clear the code and see if it returns.'],
  repair_cost: { currency: 'USD', low: 250, high: 900, note: 'Cleaning is cheaper; a new valve plus labour is the top of the range.' },
  questions: ['Is it mostly short city trips?', 'Has the DPF warning ever come on?'],
  disclaimer: 'AI estimate — confirm with a mechanic before major repairs.',
  code_details: {
    code: 'P0401',
    title: 'EGR flow insufficient: the engine computer sees less exhaust gas recirculation than it asked for.',
    module: 'Engine control module (ECM)',
    component: 'EGR valve, EGR cooler and EGR position sensor',
    failure_type: '',
    what_it_means: 'The ECM opens the EGR valve and expects intake pressure or airflow to change. On this engine it did not change enough, which almost always means soot is blocking the valve or cooler.',
    where_to_look: ['EGR valve on the intake side of the engine', 'EGR cooler and its pipes', 'EGR valve connector and wiring'],
    confidence: 'high',
  },
};

export function createDiagnoser({ apiKey, mock = false } = {}) {
  const client = mock ? null : new Anthropic({ apiKey });

  return async function diagnose(input) {
    const model = pickModel(input);
    if (mock) {
      // The sample code_details only fits P0401; for any other code the page falls back to local data.
      const details = input.code?.base === 'P0401' ? MOCK_DIAGNOSIS.code_details : null;
      return { model, diagnosis: { ...MOCK_DIAGNOSIS, code_details: details }, usage: null };
    }

    const content = [];
    if (input.image) {
      content.push({ type: 'image', source: { type: 'base64', media_type: input.image.media_type, data: input.image.data } });
    }
    content.push({ type: 'text', text: describeForModel(input) });

    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      const msg = await client.messages.create({
        model,
        max_tokens: 4000,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }],
      });
      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      try {
        return { model, diagnosis: parseDiagnosis(text), usage: msg.usage };
      } catch (err) {
        lastError = err; // retry once on malformed output
      }
    }
    throw new Error(`Model returned invalid diagnosis: ${lastError.message}`);
  };
}

// ---- Pro: read trouble codes from a screenshot or photo -------------------------------------
const SCAN_PROMPT = `This image is a screenshot of a car diagnostic (OBD2) app, a photo of a scan tool screen, or a photo of a car's dashboard or instrument display.
Find every diagnostic trouble code shown. Codes are one letter P, C, B or U followed by four characters, e.g. P0301, P0420, U0100, C1A20.
Many scan tools add a 2-character failure type suffix, shown as B143C-11, B143C:11, B143C 11 or B143C11. Always keep the suffix and write it as CODE-XX, e.g. B143C-11.
Ignore mileage, dates, VINs, part numbers and anything that is not a trouble code. If there are none, return an empty list.
Reply with ONLY JSON, e.g. {"codes": ["P0301", "B143C-11"]}`;

export function parseImage(body = {}) {
  const img = body.image || {};
  if (!IMAGE_TYPES.includes(img.media_type)) throw new InputError('image.media_type must be jpeg, png or webp');
  if (typeof img.data !== 'string' || !img.data) throw new InputError('image.data must be base64');
  if ((img.data.length * 3) / 4 > MAX_IMAGE_BYTES) throw new InputError('Image too large (max 4 MB)');
  return { media_type: img.media_type, data: img.data };
}

/** Pull valid, de-duplicated codes out of the model's reply. */
export function parseCodes(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  let list = [];
  if (start !== -1 && end > start) {
    try { list = JSON.parse(text.slice(start, end + 1)).codes ?? []; } catch { list = []; }
  }
  if (!Array.isArray(list)) list = [];
  const out = [];
  for (const raw of list) {
    const c = normaliseCode(raw);
    if (c && !out.includes(c)) out.push(c);
  }
  return out.slice(0, 8).map((c) => describeCode(c));
}

export function createScanner({ apiKey, mock = false } = {}) {
  const client = mock ? null : new Anthropic({ apiKey });
  return async function scan(image) {
    if (mock) return { model: MODELS.vision, codes: [describeCode('P0401')] };
    const msg = await client.messages.create({
      model: MODELS.vision,
      max_tokens: 1000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } },
        { type: 'text', text: SCAN_PROMPT },
      ] }],
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { model: MODELS.vision, codes: parseCodes(text), usage: msg.usage };
  };
}

export { describeForModel };
