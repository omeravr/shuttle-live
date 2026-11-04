// Replay a logger day through the real app.js (fake clock, stubbed map/DOM) and score it against
// what the buses' GPS later showed.
//
//   node tools/replay.mjs ~/tmp/861log/2026-11-04.jsonl [--from 06:00] [--to 23:00]
//
// Ground truth: the first GPS fix within NEAR_M of a stop is when that trip reached it.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEAR_M = 120;
const HORIZONS_MIN = [1, 3, 5, 10];
const TZ = "Asia/Jerusalem";

const args = process.argv.slice(2);
const file = args[0];
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const ilHM = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
const inWindow = (ms) => (!opt("--from") || ilHM(ms) >= opt("--from")) && (!opt("--to") || ilHM(ms) < opt("--to"));

const records = fs
  .readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .map((r) => ({ ...r, ms: Date.parse(r.t) }))
  .sort((a, b) => a.ms - b.ms);

// --- sandbox: real app code, fake time, inert map/DOM ---
let simNow = records[0]?.ms ?? Date.now();
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) {
    super(...(a.length ? a : [simNow]));
  }
  static now() {
    return simNow;
  }
}
const inert = () =>
  new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : k === "then" ? undefined : inert()),
    apply: () => inert(),
    construct: () => inert(),
  });
const el = () => {
  const e = inert();
  return new Proxy({}, {
    get: (_, k) => (k === "getBoundingClientRect" ? () => ({ top: 400, left: 0, width: 375, height: 400, bottom: 800, right: 375 }) : k === "classList" ? { add() {}, remove() {}, toggle() {}, contains: () => false } : e[k]),
    set: () => true,
  });
};
const sandbox = {
  Date: FakeDate,
  Intl,
  Math,
  JSON,
  Map,
  Set,
  Number,
  String,
  Object,
  Array,
  Promise,
  console,
  L: inert(),
  document: { getElementById: () => el(), createElement: () => el(), hidden: false, addEventListener() {} },
  window: { innerHeight: 800, innerWidth: 375 },
  location: { hostname: "localhost", search: "" },
  navigator: {},
  URLSearchParams,
  AbortSignal,
  fetch: () => new Promise(() => {}),
  setInterval: () => 0,
  setTimeout: () => 0,
  clearInterval: () => {},
};
vm.createContext(sandbox);
for (const f of ["route.js", "app.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
const run = (code) => vm.runInContext(code, sandbox);
const STOPS = run("STOPS");

// --- ground truth from every distinct GPS fix in the log ---
const fixesByTrip = new Map();
for (const r of records) {
  for (const f of r.positions?.fixes || []) {
    const m = fixesByTrip.get(f.trip) || new Map();
    m.set(f.recordedAt, f);
    fixesByTrip.set(f.trip, m);
  }
}
const hav = (a, b, c, d) => run(`haversine(${a},${b},${c},${d})`);
const actualAt = new Map(); // trip -> stopIdx -> ms
for (const [trip, m] of fixesByTrip) {
  const per = new Map();
  for (const f of [...m.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) {
    STOPS.forEach((s, i) => {
      if (!per.has(i) && hav(f.lat, f.lon, s.lat, s.lon) < NEAR_M) per.set(i, Date.parse(f.recordedAt));
    });
  }
  actualAt.set(trip, per);
}

// --- replay ---
const preds = new Map(); // `${trip}|${i}` -> [{t, ours, mot, stale}]
const markerErr = []; // displayed s at a fix's recorded time vs the fix s
const shownHist = new Map(); // trip -> [{t, s}]
let backward = 0;
let backwardAfterFix = 0;
let lurches = 0;
let ticks = 0;
const lastFixAt = new Map();

const tick = () => {
  run("updateBusMarkers()");
  ticks++;
  for (const b of run("state.buses")) {
    const p = run(`(() => { const b = state.buses.find(x => x.id === ${b.id}); const d = b && displayPlace(b); return d ? d.s : null; })()`);
    const sh = run(`shown.get(${b.id})`);
    if (p == null || !sh) continue;
    const h = shownHist.get(b.id) || [];
    const last = h[h.length - 1];
    if (last) {
      const ds = sh.s - last.s;
      const newFix = (lastFixAt.get(b.id) || 0) > last.t;
      if (ds < -1) newFix ? backwardAfterFix++ : backward++;
      if (ds > 60 * ((simNow - last.t) / 1000 || 1) && !newFix) lurches++;
    }
    h.push({ t: simNow, s: sh.s });
    shownHist.set(b.id, h);
  }
};

for (let k = 0; k < records.length; k++) {
  const r = records[k];
  simNow = r.ms;
  const arr = Object.values(r.arrivals || {});
  if (arr.every((a) => a && a.success)) {
    sandbox.__arr = arr.map((a) => a.data || {});
    run("ingest(__arr); state.fetchedAt = Date.now(); state.error = null; dataVersion++;");
  }
  if (r.positions && Array.isArray(r.positions.fixes)) {
    sandbox.__pos = r.positions;
    run("ingestGps(__pos); dataVersion++;");
    for (const f of r.positions.fixes) {
      const at = Date.parse(f.recordedAt);
      if (at > (lastFixAt.get(f.trip) || 0)) lastFixAt.set(f.trip, simNow);
    }
  }
  // predictions at this poll
  if (inWindow(simNow)) {
    for (const b of run("state.buses")) {
      const model = run(`busModel(state.buses.find(x => x.id === ${b.id}))`);
      if (!model) continue;
      STOPS.forEach((s, i) => {
        const ours = model.etaTo(i);
        const motMin = b.etas.get(String(s.code));
        const key = `${b.id}|${i}`;
        const list = preds.get(key) || [];
        list.push({ t: simNow, ours: ours == null ? null : simNow + ours * 60000, mot: motMin == null ? null : simNow + motMin * 60000, stale: model.stale });
        preds.set(key, list);
      });
    }
  }
  // 1 s ticks until the next poll, like the page's marker loop
  const next = records[k + 1]?.ms ?? simNow + 20000;
  for (let t = simNow; t < next; t += 1000) {
    simNow = t;
    tick();
  }
}

// marker vs GPS: for every fix, where the marker was at the fix's recorded time
for (const [trip, m] of fixesByTrip) {
  const h = shownHist.get(trip);
  if (!h || !h.length) continue;
  for (const f of m.values()) {
    const at = Date.parse(f.recordedAt);
    if (!inWindow(at) || at < h[0].t || at > h[h.length - 1].t) continue;
    let j = 0;
    while (j < h.length - 1 && h[j + 1].t <= at) j++;
    const fixS = run(`projectOnRoute(${f.lat}, ${f.lon}).s`);
    markerErr.push(h[j].s - fixS);
  }
}

// --- scoring ---
const stats = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const abs = a.map(Math.abs).sort((x, y) => x - y);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  return {
    n: a.length,
    bias_s: Math.round(a.reduce((s, x) => s + x, 0) / a.length),
    medAbs_s: Math.round(q(abs, 0.5)),
    p90Abs_s: Math.round(q(abs, 0.9)),
    within1min: `${Math.round((100 * abs.filter((x) => x <= 60).length) / abs.length)}%`,
    within2min: `${Math.round((100 * abs.filter((x) => x <= 120).length) / abs.length)}%`,
  };
};
const result = { horizons: {}, dangerous: 0, dangerousOf: 0 };
for (const H of HORIZONS_MIN) {
  const ours = [];
  const mot = [];
  const oursStale = [];
  for (const [trip, per] of actualAt) {
    for (const [i, A] of per) {
      if (!inWindow(A)) continue;
      const list = preds.get(`${trip}|${i}`);
      if (!list) continue;
      const target = A - H * 60000;
      const p = list.reduce((best, x) => (Math.abs(x.t - target) < Math.abs((best?.t ?? Infinity) - target) ? x : best), null);
      if (!p || Math.abs(p.t - target) > 30000) continue;
      if (p.ours != null) (p.stale ? oursStale : ours).push((p.ours - A) / 1000);
      if (p.mot != null) mot.push((p.mot - A) / 1000);
      // dangerous: shows the bus as already there/passed while it is still >= 2 min away
      if (H >= 3) {
        result.dangerousOf++;
        if (p.ours == null || p.ours - p.t < 30000) result.dangerous++;
      }
    }
  }
  result.horizons[`${H}min`] = { ours: stats(ours), oursWhenNoGps: stats(oursStale), mot: stats(mot) };
}
result.marker_vs_gps_m = (() => {
  const s = stats(markerErr);
  return s && { n: s.n, bias_m: s.bias_s, medAbs_m: s.medAbs_s, p90Abs_m: s.p90Abs_s };
})();
result.motion = { ticks, backwardWithoutNewFix: backward, backwardAfterNewFix: backwardAfterFix, forwardLurchesOver60mps: lurches };
result.trips = actualAt.size;
result.stopArrivalsSeen = [...actualAt.values()].reduce((s, m) => s + m.size, 0);
result.polls = records.length;
result.window = `${ilHM(records[0].ms)}–${ilHM(records[records.length - 1].ms)}`;
console.log(JSON.stringify(result, null, 1));
