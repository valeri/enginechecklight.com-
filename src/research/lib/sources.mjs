// Source tiers. The search runs on official domains first; every URL that
// reaches the user is labelled with its tier so the UI can show how far the
// answer can be trusted.

export const GOV = [
  "nhtsa.gov", "nhtsa.dot.gov", "tc.canada.ca", "service.gov.uk",
  "ec.europa.eu", "epa.gov", "arb.ca.gov",
];
export const STANDARDS = ["sae.org", "iso.org"];

const MAKER = {
  "land rover": ["landrover.com", "jaguarlandrover.com", "jlrext.com"],
  "range rover": ["landrover.com", "jaguarlandrover.com", "jlrext.com"],
  jaguar: ["jaguar.com", "jaguarlandrover.com", "jlrext.com"],
  audi: ["audi.com", "audiusa.com", "audi.de"],
  volkswagen: ["vw.com", "volkswagen.de", "volkswagen.com"],
  vw: ["vw.com", "volkswagen.de", "volkswagen.com"],
  skoda: ["skoda-auto.com"],
  seat: ["seat.com"],
  porsche: ["porsche.com"],
  bmw: ["bmw.com", "bmwusa.com", "bmwgroup.com"],
  mini: ["mini.com", "bmwgroup.com"],
  "mercedes-benz": ["mercedes-benz.com", "mbusa.com"],
  mercedes: ["mercedes-benz.com", "mbusa.com"],
  toyota: ["toyota.com", "toyota-tech.eu"],
  lexus: ["lexus.com"],
  honda: ["honda.com"],
  acura: ["acura.com", "honda.com"],
  nissan: ["nissanusa.com", "nissan-global.com"],
  infiniti: ["infinitiusa.com"],
  hyundai: ["hyundai.com", "hyundaiusa.com"],
  kia: ["kia.com"],
  ford: ["ford.com", "motorcraftservice.com"],
  lincoln: ["lincoln.com", "motorcraftservice.com"],
  chevrolet: ["chevrolet.com", "gm.com"],
  gmc: ["gmc.com", "gm.com"],
  cadillac: ["cadillac.com", "gm.com"],
  jeep: ["jeep.com", "mopar.com"],
  dodge: ["dodge.com", "mopar.com"],
  chrysler: ["chrysler.com", "mopar.com"],
  subaru: ["subaru.com"],
  mazda: ["mazdausa.com", "mazda.com"],
  mitsubishi: ["mitsubishicars.com", "mitsubishi-motors.com"],
  volvo: ["volvocars.com"],
  tesla: ["tesla.com"],
  opel: ["opel.com"],
  renault: ["renault.com"],
  peugeot: ["peugeot.com"],
};

const PROFESSIONAL = [
  "alldata.com", "mitchell1.com", "identifix.com", "autodata-group.com",
  "haynes.com", "bosch.com", "bosch-mobility.com", "delphiautoparts.com",
  "ngk.com", "denso.com",
];

export function makerDomains(make) {
  return MAKER[String(make ?? "").trim().toLowerCase()] ?? [];
}

export function officialDomains(make) {
  return [...new Set([...GOV, ...STANDARDS, ...makerDomains(make)])];
}

const hostMatches = (host, list) => list.some((d) => host === d || host.endsWith("." + d));

export function tierOf(url, make) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
  if (hostMatches(host, GOV)) return "official_government";
  if (hostMatches(host, STANDARDS)) return "official_standard";
  if (hostMatches(host, makerDomains(make))) return "official_manufacturer";
  if (hostMatches(host, PROFESSIONAL)) return "professional";
  return "community";
}

export const isOfficial = (tier) => typeof tier === "string" && tier.startsWith("official");
