import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FTB, describeCode, normaliseCode } from '../src/dtc.js';
import { parseCodes, parseDiagnosis } from '../src/diagnose.js';

test('every FTB notation normalises to B143C-11', () => {
  for (const raw of ['B143C:11', 'b143c-11', 'B143C 11', 'B143C11', 'B143C_11', 'B143C.11', 'B143C - 11', '  B143C-11  ']) {
    assert.equal(normaliseCode(raw), 'B143C-11', raw);
  }
  assert.equal(normaliseCode('p0301'), 'P0301');
});

test('invalid codes are rejected', () => {
  for (const raw of ['B143C-1', 'B143C-111', 'B143C-1G', 'X0301', 'P4301', 'P030', '', null]) {
    assert.equal(normaliseCode(raw), null, String(raw));
  }
});

test('describeCode returns base, FTB and meanings', () => {
  assert.deepEqual(describeCode('b143c:11'), {
    code: 'B143C-11', base: 'B143C', ftb: '11', ftbMeaning: 'Circuit short to ground',
    system: 'Body', generic: false, meaning: null,
  });
  const p = describeCode('P0401-13');
  assert.equal(p.meaning, 'Exhaust gas recirculation (EGR) flow insufficient');
  assert.equal(p.ftbMeaning, 'Circuit open');
  assert.equal(p.generic, true);
  const plain = describeCode('U0100');
  assert.equal(plain.ftb, null);
  assert.equal(plain.ftbMeaning, null);
  assert.equal(plain.system, 'Network');
});

test('FTB table covers the SAE J2012-DA ranges', () => {
  const ranges = [['00', '09'], ['11', '1F'], ['21', '2F'], ['31', '3A'], ['41', '4B'], ['51', '56'], ['61', '68'], ['71', '7B'], ['81', '8F'], ['91', '98']];
  let n = 0;
  for (const [a, b] of ranges) {
    for (let i = parseInt(a, 16); i <= parseInt(b, 16); i++, n++) {
      const k = i.toString(16).toUpperCase().padStart(2, '0');
      assert.ok(FTB[k], `missing ${k}`);
    }
  }
  assert.equal(Object.keys(FTB).length, n);
  assert.equal(FTB['87'], 'Missing message');
});

test('parseCodes keeps the suffix and de-duplicates notations', () => {
  const codes = parseCodes('{"codes": ["B143C-11", "b143c:11", "P0301", "B143C", "junk"]}');
  assert.deepEqual(codes.map((c) => c.code), ['B143C-11', 'P0301', 'B143C']);
});

const base = { summary: 'x', severity: 'low', safe_to_drive: 'yes', causes: [{ name: 'a', likelihood: 1, explanation: '' }] };

test('parseDiagnosis cleans code_details', () => {
  const d = parseDiagnosis(JSON.stringify({
    ...base,
    code_details: {
      code: 'b143c:11', title: '  Rear wiper motor circuit  ', module: 'BCM', component: 'x'.repeat(500),
      failure_type: 'Short to ground', what_it_means: 'Wire touches the body.',
      where_to_look: [' tailgate loom ', '', 'C1', 'C2', 'C3', 'C4', 7], confidence: 'sure',
    },
  }));
  const cd = d.code_details;
  assert.equal(cd.code, 'B143C-11');
  assert.equal(cd.title, 'Rear wiper motor circuit');
  assert.equal(cd.component.length, 160);
  assert.deepEqual(cd.where_to_look, ['tailgate loom', 'C1', 'C2', 'C3']);
  assert.equal(cd.confidence, 'low');

  assert.equal(parseDiagnosis(JSON.stringify(base)).code_details, null);
  assert.equal(parseDiagnosis(JSON.stringify({ ...base, code_details: { module: 'BCM', title: ' ', what_it_means: '' } })).code_details, null);
  assert.equal(parseDiagnosis(JSON.stringify({ ...base, code_details: { what_it_means: 'ok', confidence: 'high' } })).code_details.confidence, 'high');
});
