// Small starter dictionary of common generic OBD2 codes.
// Used to (a) validate/normalise codes, (b) give the model a grounded meaning,
// (c) answer instantly offline. Extend with a full SAE J2012 list later.
const DTC = {
  P0101: 'Mass air flow (MAF) sensor range/performance',
  P0128: 'Coolant temperature below thermostat regulating temperature',
  P0171: 'System too lean (Bank 1)',
  P0172: 'System too rich (Bank 1)',
  P0174: 'System too lean (Bank 2)',
  P0300: 'Random/multiple cylinder misfire detected',
  P0301: 'Cylinder 1 misfire detected',
  P0302: 'Cylinder 2 misfire detected',
  P0303: 'Cylinder 3 misfire detected',
  P0304: 'Cylinder 4 misfire detected',
  P0401: 'Exhaust gas recirculation (EGR) flow insufficient',
  P0420: 'Catalyst system efficiency below threshold (Bank 1)',
  P0430: 'Catalyst system efficiency below threshold (Bank 2)',
  P0442: 'EVAP system small leak detected',
  P0455: 'EVAP system large leak detected',
  P0500: 'Vehicle speed sensor malfunction',
  P0505: 'Idle air control system malfunction',
  P0700: 'Transmission control system malfunction',
  P2002: 'Diesel particulate filter efficiency below threshold (Bank 1)',
  P2463: 'Diesel particulate filter restriction — soot accumulation',
  C1A20: 'Air suspension system fault (manufacturer specific)',
  U0100: 'Lost communication with ECM/PCM',
};

const CODE_RE = /^[PCBU][0-3][0-9A-F]{3}$/;

export function normaliseCode(raw) {
  if (!raw) return null;
  const code = String(raw).trim().toUpperCase().replace(/[\s-]/g, '');
  return CODE_RE.test(code) ? code : null;
}

export function describeCode(code) {
  const c = normaliseCode(code);
  if (!c) return null;
  const system = { P: 'Powertrain', C: 'Chassis', B: 'Body', U: 'Network' }[c[0]];
  const generic = c[1] === '0' || c[1] === '2';
  return {
    code: c,
    system,
    generic,
    meaning: DTC[c] ?? null,
  };
}
