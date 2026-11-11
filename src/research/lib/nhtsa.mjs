// NHTSA public APIs (US government, free, no key). Data is for US-market
// vehicles: recalls and owner complaints by make / model / model year.

const BASE = "https://api.nhtsa.gov";

async function getJson(url, ms = 6000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`NHTSA ${res.status}`);
  return res.json();
}

const q = (car) =>
  `make=${encodeURIComponent(car.make)}&model=${encodeURIComponent(car.model)}&modelYear=${encodeURIComponent(car.year)}`;
const clip = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n) + "…" : String(s ?? ""));

export async function nhtsaLookup(car, dtcBase) {
  const empty = { available: false, recalls: [], complaints_total: 0, complaints_with_code: [] };
  if (!car?.make || !car?.model || !/^\d{4}$/.test(String(car?.year ?? ""))) return empty;

  const [rec, comp] = await Promise.allSettled([
    getJson(`${BASE}/recalls/recallsByVehicle?${q(car)}`),
    getJson(`${BASE}/complaints/complaintsByVehicle?${q(car)}`),
  ]);
  if (rec.status === "rejected" && comp.status === "rejected") return empty;

  const recalls = (rec.value?.results ?? []).slice(0, 10).map((r) => ({
    campaign: r.NHTSACampaignNumber,
    component: r.Component,
    summary: clip(r.Summary, 400),
    remedy: clip(r.Remedy, 300),
    date: r.ReportReceivedDate,
    url: r.NHTSACampaignNumber ? `https://www.nhtsa.gov/recalls?nhtsaId=${r.NHTSACampaignNumber}` : null,
  }));

  const all = comp.value?.results ?? [];
  const needle = dtcBase ? dtcBase.toUpperCase() : null;
  const withCode = needle
    ? all.filter((c) => String(c.summary ?? "").toUpperCase().includes(needle)).slice(0, 5).map((c) => ({
        id: c.odiNumber, date: c.dateComplaintFiled, components: c.components, summary: clip(c.summary, 400),
      }))
    : [];

  return { available: true, recalls, complaints_total: all.length, complaints_with_code: withCode };
}
