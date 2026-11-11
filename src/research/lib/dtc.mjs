// Deterministic DTC decoding. No network, no AI: this part is always exact.
// Structure follows SAE J2012 / ISO 15031-6; the 2-character suffix is the
// failure type byte (FTB) from SAE J2012-DA / ISO 14229.

const SYSTEM = { P: "powertrain", C: "chassis", B: "body", U: "network" };

const P_SUBSYSTEM = {
  0: "fuel_air_metering", 1: "fuel_air_metering", 2: "injector_circuit",
  3: "ignition_misfire", 4: "auxiliary_emission", 5: "speed_idle_control",
  6: "computer_output_circuit", 7: "transmission", 8: "transmission",
  9: "transmission", A: "hybrid_propulsion",
};

const FTB_CATEGORY = {
  0: "General failure information", 1: "General electrical failure",
  2: "General signal failure", 3: "FM / PWM failure",
  4: "System internal failure", 5: "System programming failure",
  6: "Algorithm based failure", 7: "Mechanical failure",
  8: "Bus signal / message failure", 9: "Component failure",
};

const FTB = {
  "00": "No sub type information",
  "01": "General electrical failure", "02": "General signal failure", "03": "FM / PWM failure",
  "04": "System internal failure", "05": "System programming failure", "06": "Algorithm based failure",
  "07": "Mechanical failure", "08": "Bus signal / message failure", "09": "Component failure",
  "11": "Circuit short to ground", "12": "Circuit short to battery", "13": "Circuit open",
  "14": "Circuit short to ground or open", "15": "Circuit short to battery or open",
  "16": "Circuit voltage below threshold", "17": "Circuit voltage above threshold",
  "18": "Circuit current below threshold", "19": "Circuit current above threshold",
  "1A": "Circuit resistance below threshold", "1B": "Circuit resistance above threshold",
  "1C": "Circuit voltage out of range", "1D": "Circuit current out of range",
  "1E": "Circuit resistance out of range", "1F": "Circuit intermittent",
  "21": "Signal amplitude below minimum", "22": "Signal amplitude above maximum",
  "23": "Signal stuck low", "24": "Signal stuck high", "25": "Signal shape / waveform failure",
  "26": "Signal rate of change below threshold", "27": "Signal rate of change above threshold",
  "28": "Signal bias level out of range / zero adjustment failure", "29": "Signal invalid",
  "2F": "Signal erratic",
  "31": "No signal", "32": "Signal low time below minimum", "33": "Signal low time above maximum",
  "34": "Signal high time below minimum", "35": "Signal high time above maximum",
  "36": "Signal frequency too low", "37": "Signal frequency too high",
  "38": "Signal frequency incorrect", "39": "Signal has too few pulses", "3A": "Signal has too many pulses",
  "41": "General checksum failure", "42": "General memory failure", "43": "Special memory failure",
  "44": "Data memory failure", "45": "Program memory failure",
  "46": "Calibration / parameter memory failure", "47": "Watchdog / safety microcontroller failure",
  "48": "Supervision software failure", "49": "Internal electronic failure",
  "4A": "Incorrect component installed", "4B": "Over temperature",
  "51": "Not programmed", "52": "Not activated", "53": "Deactivated", "54": "Missing calibration",
  "55": "Not configured", "56": "Invalid / incompatible configuration",
  "57": "Invalid / incompatible software component",
  "61": "Signal calculation failure", "62": "Signal compare failure",
  "63": "Circuit / component protection time-out", "64": "Signal plausibility failure",
  "65": "Signal has too few transitions / events", "66": "Signal has too many transitions / events",
  "67": "Signal incorrect after event", "68": "Event information",
  "71": "Actuator stuck", "72": "Actuator stuck open", "73": "Actuator stuck closed",
  "74": "Actuator slipping", "75": "Emergency position not reachable", "76": "Wrong mounting position",
  "77": "Commanded position not reachable", "78": "Alignment or adjustment incorrect",
  "79": "Mechanical linkage failure", "7A": "Fluid leak or seal failure", "7B": "Low fluid level",
  "81": "Invalid serial data received", "82": "Alive / sequence counter incorrect or not updated",
  "83": "Value of signal protection calculation incorrect", "84": "Signal below allowable range",
  "85": "Signal above allowable range", "86": "Signal invalid", "87": "Missing message", "88": "Bus off",
  "91": "Parametric", "92": "Performance or incorrect operation", "93": "No operation",
  "94": "Unexpected operation", "95": "Incorrect assembly", "96": "Component internal failure",
  "97": "Component or system operation obstructed or blocked",
  "98": "Component or system over temperature",
};

function scopeOf(letter, d1, d2) {
  if (d1 === "0") return "generic";
  if (letter === "P") {
    if (d1 === "1") return "manufacturer";
    if (d1 === "2") return "generic";
    return parseInt(d2, 16) <= 3 ? "manufacturer" : "generic"; // P3000-P33FF maker, P3400+ generic
  }
  if (d1 === "3") return letter === "U" ? "generic" : "reserved";
  return "manufacturer";
}

export function parseDtc(raw) {
  const s = String(raw ?? "").toUpperCase().replace(/[\s_]/g, "");
  const m = /^([PCBU])([0-3])([0-9A-F])([0-9A-F]{2})(?:-?([0-9A-F]{2}))?$/.exec(s);
  if (!m) return null;
  const [, letter, d1, d2, rest, ftb] = m;
  const base = letter + d1 + d2 + rest;
  const out = {
    input: String(raw),
    base,
    full: ftb ? `${base}-${ftb}` : base,
    system: SYSTEM[letter],
    scope: scopeOf(letter, d1, d2),
    subsystem: letter === "P" && (d1 === "0" || d1 === "2") ? P_SUBSYSTEM[d2] ?? null : null,
    failure_type: null,
  };
  if (ftb) {
    out.failure_type = {
      byte: ftb,
      category: FTB_CATEGORY[ftb[0]] ?? "Reserved / manufacturer defined",
      meaning: FTB[ftb] ?? null,
      standard: "SAE J2012-DA / ISO 14229",
    };
  }
  return out;
}
