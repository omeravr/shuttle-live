"use strict";

// Proxy for MOT real-time trips + last real GPS fix per trip: server.py when run locally,
// the Cloudflare Worker (worker/) on the hosted site
const WORKER_URL = "https://shuttle-live-proxy.omeravr.workers.dev";
const API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname) ? "/api" : `${WORKER_URL}/api`;
const ROUTE_DESCS = ["11861-1-0", "11861-2-0"];
const REFRESH_MS = 20000;
const GPS_FRESH_MIN = 5;
const GPS_LIVE_MIN = 2;
const GPS_GUESS_MAX_MIN = 5;
const MOT_MOVE_M = 30;
const MOT_REPORT_DELAY_MS = 60000;
const MOT_FIRST_SEEN_AGE_MS = 90000;
const SOURCE_LAG_WARN_MIN = 8;
const TZ = "Asia/Jerusalem";
const WALK_MPS = 1.2;
const NEAR_STOP_MAX_M = 2000;

// --- travel-time model, measured from 121 real trips of line 861 on 2026-11-03 (Open Bus GPS) ---
// Buses leave the lot on time: median 0.6 min after the scheduled start.
const DEPART_LATE_S = 36;
// Median minutes from leaving the lot to stop 1, by scheduled start hour (Israel time).
const HIGHWAY_MIN_BY_HOUR = {
  5: 22, 6: 22, 7: 21.7, 8: 22.7, 9: 20.6, 10: 18.6, 11: 19.9, 12: 17.8, 13: 20.2, 14: 18.6,
  15: 20.8, 16: 20.3, 17: 25.9, 18: 25.3, 19: 19.4, 20: 16.4, 21: 16, 22: 16, 23: 16,
};
// Median seconds stop-to-stop in Tel Aviv, including the wait at the departing stop.
const CITY_LEG_S = [228, 96, 108, 84, 222, 72];
// Tel Aviv part (stop 1 -> 7) by hour, relative to the all-day median of 13.8 min.
const CITY_FACTOR_BY_HOUR = {
  // 06:xx departures reach Tel Aviv in the 07:00 rush
  5: 0.87, 6: 0.87, 7: 0.87, 8: 1.09, 9: 0.94, 10: 0.82, 11: 0.91, 12: 0.97, 13: 0.93, 14: 1.14,
  15: 0.96, 16: 1.1, 17: 1.09, 18: 1.08, 19: 0.99, 20: 0.87, 21: 0.81, 22: 0.81, 23: 0.81,
};
// Seconds from the scheduled start to each stop in the official timetable (GTFS).
const STATIC_OFFSET_S = { 20876: 959, 28581: 1115, 20313: 1199, 25625: 1241, 25722: 1319, 21238: 1439, 21815: 1498 };
const MAX_DWELL_S = 45;

const HUB = { code: 3770, name: 'חנה וסע ראשל"צ', lat: 31.969304, lon: 34.75481 };

const STOPS = [
  { code: 20876, name: "דרך נמיר/שדרות שאול המלך", lat: 32.078509, lon: 34.793016 },
  { code: 28581, name: "מתחם שרונה/אליעזר קפלן", lat: 32.073491, lon: 34.787018 },
  { code: 20313, name: "אליעזר קפלן/דובנוב", lat: 32.07356, lon: 34.783258 },
  { code: 25625, name: "לונדון מיניסטור/אבן גבירול", lat: 32.074469, lon: 34.781836 },
  { code: 25722, name: "האופרה/שד' שאול המלך", lat: 32.075623, lon: 34.784789 },
  { code: 21238, name: "בית המשפט/ויצמן", lat: 32.078868, lon: 34.788581 },
  { code: 21815, name: 'ביה"ח איכילוב/ויצמן', lat: 32.080816, lon: 34.788879 },
];

const state = {
  arrivals: new Map(),
  buses: [],
  gps: new Map(),
  gpsError: null,
  fetchedAt: null,
  error: null,
  me: null,
  meSource: null,
  fittedToMe: false,
};
const newFixAt = new Map();
// bumped on every data update, so the display knows when its target may have jumped
let dataVersion = 0;

const $ = (id) => document.getElementById(id);

function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function bearing(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const y = Math.sin((bLon - aLon) * rad) * Math.cos(bLat * rad);
  const x = Math.cos(aLat * rad) * Math.sin(bLat * rad) - Math.sin(aLat * rad) * Math.cos(bLat * rad) * Math.cos((bLon - aLon) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

// --- route geometry: distance along ROUTE_PATH (route.js) ---
const ROUTE = (() => {
  const cum = [0];
  for (let i = 1; i < ROUTE_PATH.length; i++) {
    const [a, b] = [ROUTE_PATH[i - 1], ROUTE_PATH[i]];
    cum.push(cum[i - 1] + haversine(a[0], a[1], b[0], b[1]));
  }
  return { pts: ROUTE_PATH, cum, length: cum[cum.length - 1] };
})();

function projectOnRoute(lat, lon) {
  const k = Math.cos((lat * Math.PI) / 180);
  let best = { d: Infinity, s: 0 };
  for (let i = 1; i < ROUTE.pts.length; i++) {
    const [aLat, aLon] = ROUTE.pts[i - 1];
    const [bLat, bLon] = ROUTE.pts[i];
    const ax = aLon * k, ay = aLat, bx = bLon * k, by = bLat, px = lon * k, py = lat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const qLat = aLat + (bLat - aLat) * t;
    const qLon = aLon + (bLon - aLon) * t;
    const d = haversine(lat, lon, qLat, qLon);
    if (d < best.d) best = { d, s: ROUTE.cum[i - 1] + (ROUTE.cum[i] - ROUTE.cum[i - 1]) * t };
  }
  return best;
}

function pointAt(s) {
  s = Math.max(0, Math.min(ROUTE.length, s));
  let i = 1;
  while (i < ROUTE.cum.length - 1 && ROUTE.cum[i] < s) i++;
  const [aLat, aLon] = ROUTE.pts[i - 1];
  const [bLat, bLon] = ROUTE.pts[i];
  const seg = ROUTE.cum[i] - ROUTE.cum[i - 1];
  const t = seg ? (s - ROUTE.cum[i - 1]) / seg : 0;
  return { lat: aLat + (bLat - aLat) * t, lon: aLon + (bLon - aLon) * t, heading: bearing(aLat, aLon, bLat, bLon) };
}

HUB.s = 0;
STOPS.forEach((st) => (st.s = projectOnRoute(st.lat, st.lon).s));

// --- time helpers ---
function ilHour(ms) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(ms));
}

// MOT times are Israel wall-clock strings without an offset ("2026-11-03T21:00:59")
function parseIsraelTime(str) {
  if (!str) return NaN;
  const asUtc = Date.parse(`${str}Z`);
  if (Number.isNaN(asUtc)) return NaN;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(asUtc).map((p) => [p.type, p.value])
  );
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - (wall - asUtc);
}

// --- the travel-time profile: seconds from leaving the lot to each stop ---
const profiles = new Map();
function profileFor(hour) {
  if (profiles.has(hour)) return profiles.get(hour);
  const hw = (HIGHWAY_MIN_BY_HOUR[hour] ?? 18) * 60;
  const k = CITY_FACTOR_BY_HOUR[hour] ?? 1;
  const tau = [hw];
  CITY_LEG_S.forEach((leg, i) => tau.push(tau[i] + leg * k));
  profiles.set(hour, tau);
  return tau;
}

const ease = (f) => f * f * (3 - 2 * f);
function invEase(y) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 25; i++) {
    const mid = (lo + hi) / 2;
    if (ease(mid) < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
const dwellOf = (legS) => Math.min(MAX_DWELL_S, 0.35 * legS);

// route distance -> profile time
function tauAt(s, tau) {
  if (s <= STOPS[0].s) return (Math.max(0, s) / STOPS[0].s) * tau[0];
  for (let i = 0; i < STOPS.length - 1; i++) {
    const a = STOPS[i], b = STOPS[i + 1];
    if (s <= b.s) {
      const leg = tau[i + 1] - tau[i];
      const d = dwellOf(leg);
      return tau[i] + d + invEase((s - a.s) / (b.s - a.s)) * (leg - d);
    }
  }
  return tau[tau.length - 1];
}

// profile time -> route distance: waits at each stop, pulls away and brakes into the next
function sAtTau(t, tau) {
  if (t <= 0) return 0;
  if (t <= tau[0]) return (t / tau[0]) * STOPS[0].s;
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (t < tau[i + 1]) {
      const leg = tau[i + 1] - tau[i];
      const d = dwellOf(leg);
      const u = t - tau[i];
      if (u <= d) return STOPS[i].s;
      return STOPS[i].s + ease((u - d) / (leg - d)) * (STOPS[i + 1].s - STOPS[i].s);
    }
  }
  return STOPS[STOPS.length - 1].s;
}

// --- map ---
const map = L.map("map", { zoomControl: false }).setView([32.0765, 34.787], 15);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const firstStopIdx = ROUTE.cum.findIndex((c) => c >= STOPS[0].s);
L.polyline(ROUTE.pts.slice(0, firstStopIdx + 1), { color: "#0b8a5f", weight: 4, opacity: 0.45 }).addTo(map);
L.polyline(ROUTE.pts.slice(Math.max(0, firstStopIdx - 1)), { color: "#0b8a5f", weight: 5, opacity: 0.8 }).addTo(map);

// markers glide between per-second updates, but must not slide while Leaflet re-lays them out on zoom
map.on("zoomstart", () => map.getContainer().classList.add("no-glide"));
map.on("zoomend", () => setTimeout(() => map.getContainer().classList.remove("no-glide"), 50));

const stopMarkers = STOPS.map((s, i) =>
  L.marker([s.lat, s.lon], { icon: stopIcon(i + 1, false), zIndexOffset: 100 })
    .bindPopup(() => stopPopup(i))
    .addTo(map)
);
L.marker([HUB.lat, HUB.lon], {
  icon: L.divIcon({ className: "", html: '<div class="stop-marker hub">P</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
}).bindPopup(HUB.name).addTo(map);

const busLayer = L.layerGroup().addTo(map);
let meMarker = null;
let meAccuracy = null;

function stopIcon(n, nearest) {
  return L.divIcon({
    className: "",
    html: `<div class="stop-marker${nearest ? " nearest" : ""}">${n}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function busIcon(heading, classes) {
  const arrow = Number.isFinite(heading)
    ? `<div style="position:absolute;inset:0;transform:rotate(${Math.round(heading)}deg)"><div class="bus-arrow"></div></div>`
    : "";
  return L.divIcon({
    className: "bus-glide",
    html: `<div class="bus-wrap">${arrow}<div class="bus-marker ${classes}">🚌</div></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

// --- formatting ---
function fmtClock(d, seconds = false) {
  return d.toLocaleTimeString("he-IL", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}),
  });
}

function fmtDist(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} מ'` : `${(m / 1000).toFixed(1)} ק"מ`;
}

function fmtMin(min) {
  if (min < 1) return "עכשיו";
  return `${Math.round(min)} דק'`;
}

function fmtAge(min) {
  return min < 1 ? "עכשיו" : `לפני ${Math.round(min)} דק'`;
}

function isStale() {
  return state.fetchedAt != null && Date.now() - state.fetchedAt > 90000;
}

// MOT minutes are relative to the fetch; count them down between fetches
function minutesNow(a) {
  return a.minutes - (Date.now() - state.fetchedAt) / 60000;
}

// --- data ---
async function getJson(path) {
  const res = await fetch(`${API_BASE}/${path}`, { signal: AbortSignal.timeout(35000) });
  if (!res.ok) throw new Error(`שרת ${res.status}`);
  return res.json();
}

async function fetchRoute(routeDesc) {
  const body = await getJson(`arrivals?routeDesc=${encodeURIComponent(routeDesc)}`);
  if (!body.success) throw new Error(body.message || "API failure");
  return body.data || {};
}

const MISSING_GRACE_MS = 45000;
const SAME_TRIP_MIN = 7;

function ingest(results) {
  const arrivals = new Map(STOPS.map((s) => [String(s.code), []]));
  const trips = new Map();

  for (const data of results) {
    for (const [code, entry] of Object.entries(data)) {
      if (!entry || !arrivals.has(code)) continue;
      for (const t of entry.stopTimes || []) {
        if (t.minutesToArrival == null) continue;
        const a = {
          trip: t.tripIdToDate,
          minutes: Number(t.minutesToArrival),
          realtime: Boolean(t.isRealTime),
        };
        arrivals.get(code).push(a);
        if (a.realtime && a.trip != null) {
          const bus = trips.get(a.trip) || { id: a.trip, etas: new Map(), schedStart: null };
          bus.etas.set(code, a.minutes);
          const loc = t.routeLocation;
          if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) bus.motLoc = { lat: loc.lat, lon: loc.lng };
          // the timetable start of this trip, from any stop's static time
          const st = parseIsraelTime(t.staticArrivalTime);
          if (!bus.schedStart && Number.isFinite(st) && STATIC_OFFSET_S[code] != null) {
            bus.schedStart = st - STATIC_OFFSET_S[code] * 1000;
          }
          trips.set(a.trip, bus);
        }
      }
    }
  }
  for (const list of arrivals.values()) list.sort((x, y) => x.minutes - y.minutes);

  const now = Date.now();
  for (const b of trips.values()) if (b.motLoc) trackMotFix(b.id, b.motLoc, now);

  // MOT sometimes drops a trip for a single update; keep it briefly so its marker doesn't
  // vanish and reappear
  for (const b of trips.values()) b.seenAt = now;
  for (const old of state.buses) {
    if (!trips.has(old.id) && now - old.seenAt < MISSING_GRACE_MS) trips.set(old.id, old);
  }

  state.arrivals = arrivals;
  state.buses = [...trips.values()];
}

function ingestGps(body) {
  const gps = new Map();
  for (const f of body.fixes || []) {
    const at = new Date(f.recordedAt);
    if (!Number.isFinite(f.lat) || !Number.isFinite(f.lon) || Number.isNaN(at.getTime())) continue;
    const fix = { lat: f.lat, lon: f.lon, at, velocity: f.velocity };
    const prev = state.gps.get(f.trip);
    if (prev && fix.at > prev.at) newFixAt.set(f.trip, Date.now());
    gps.set(f.trip, fix);
  }
  state.gps = gps;
}

// MOT's own live location for each trip (routeLocation in the arrivals feed). It is the bus's last
// reported GPS, minutes fresher than Open Bus, but has no timestamp: we time it by when it changed.
const motFixes = new Map();
function trackMotFix(trip, loc, now) {
  const prev = motFixes.get(trip);
  if (prev && haversine(prev.lat, prev.lon, loc.lat, loc.lon) < MOT_MOVE_M) return;
  let at;
  if (prev) {
    // MOT shows a new location a median 62 s after the bus reported it (matched to Open Bus fixes,
    // which carry the real time), so it was recorded about a minute before we noticed it
    at = new Date(now - MOT_REPORT_DELAY_MS);
    newFixAt.set(trip, now);
  } else {
    // first time we see this trip, so we don't know when it was reported. Open Bus may know; a
    // bus seen at the lot may have left long ago, so that one can't anchor time
    const ob = state.gps.get(trip);
    if (ob && haversine(ob.lat, ob.lon, loc.lat, loc.lon) < MOT_MOVE_M) at = ob.at;
    else if (haversine(loc.lat, loc.lon, HUB.lat, HUB.lon) < 400) at = null;
    else at = new Date(now - MOT_FIRST_SEEN_AGE_MS);
  }
  motFixes.set(trip, { lat: loc.lat, lon: loc.lon, at, velocity: null, source: "mot" });
}

// the freshest real position we have for the trip, from MOT or Open Bus
function busFix(bus) {
  const ob = state.gps.get(bus.id);
  const mot = motFixes.get(bus.id);
  const fix = mot && mot.at && (!ob || mot.at > ob.at) ? mot : ob;
  if (!fix) return null;
  const ageMin = (Date.now() - fix.at) / 60000;
  return { ...fix, ageMin, fresh: ageMin <= GPS_FRESH_MIN };
}

// Where the bus is now: start from the most recent real evidence (a GPS fix, else leaving the
// lot on schedule) and advance it by how long this line really takes at this hour.
function busModel(bus) {
  const now = Date.now();
  const hour = ilHour(bus.schedStart ?? now);
  const tau = profileFor(hour);
  const fix = busFix(bus);
  const fixS = fix ? projectOnRoute(fix.lat, fix.lon).s : null;

  let tau0;
  let t0;
  let anchor;
  if (fix && fixS > 400) {
    tau0 = tauAt(fixS, tau);
    t0 = fix.at.getTime();
    anchor = "gps";
  } else if (bus.schedStart) {
    tau0 = 0;
    t0 = bus.schedStart + DEPART_LATE_S * 1000;
    // still seen standing at the lot after that: it hasn't left yet
    if (fix && fix.at.getTime() > t0) t0 = fix.at.getTime();
    anchor = "schedule";
  } else {
    // no timetable and no GPS: fall back to MOT's own prediction for its first listed stop
    const idx = STOPS.findIndex((s) => bus.etas.has(String(s.code)));
    if (idx < 0) return null;
    tau0 = tau[idx];
    t0 = state.fetchedAt + bus.etas.get(String(STOPS[idx].code)) * 60000;
    anchor = "mot";
  }

  // Never guess further than GPS_GUESS_MAX_MIN past the last real fix (enough to cover the ~2 min
  // it takes a fix to reach us). After that the bus stays put, marked stale, until a new fix.
  const lastReal = fix ? fix.at.getTime() : t0;
  const stale = !fix || fix.ageMin > GPS_GUESS_MAX_MIN;
  const until = Math.min(now, Math.max(t0, lastReal + GPS_GUESS_MAX_MIN * 60000));
  const raw = tau0 + (now - t0) / 1000;
  const t = Math.max(0, tau0 + (until - t0) / 1000);
  const s = sAtTau(t, tau);
  const p = pointAt(s);
  const estimated = !fix || haversine(p.lat, p.lon, fix.lat, fix.lon) > 40;

  // with no recent GPS, which stop is next and when come from MOT, not from our guess
  const motEta = (i) => {
    const m = bus.etas.get(String(STOPS[i].code));
    return m == null ? null : Math.max(0, m - (now - state.fetchedAt) / 60000);
  };
  const nextIdx = stale
    ? STOPS.findIndex((_, i) => (motEta(i) ?? -1) > 0)
    : tau.findIndex((x) => x > Math.max(0, raw));
  return {
    lat: p.lat, lon: p.lon, s, heading: s > 0 ? p.heading : undefined, fix, fixS, anchor, estimated, stale,
    departsIn: raw < 0 ? -raw / 60 : 0,
    nextIdx,
    done: !stale && nextIdx < 0 && raw > tau[tau.length - 1] + 60,
    // minutes until it reaches stop i, null once it's there or past it
    etaTo: (i) => (stale ? motEta(i) : tau[i] > raw - 5 ? Math.max(0, (tau[i] - Math.max(0, raw)) / 60) : null),
  };
}

function busEtaAt(bus, stopIdx) {
  const m = busModel(bus);
  return m ? m.etaTo(stopIdx) : null;
}

// Next arrival at a stop: tracked buses by the model, plus timetable-only trips from MOT
function stopNext(stopIdx) {
  let best = null;
  const tracked = [];
  for (const b of state.buses) {
    const m = busEtaAt(b, stopIdx);
    if (m == null) continue;
    tracked.push(m);
    if (!best || m < best.minutes) best = { minutes: m, tracked: true, trip: b.id };
  }
  for (const a of state.arrivals.get(String(STOPS[stopIdx].code)) || []) {
    if (a.realtime) continue;
    const m = minutesNow(a);
    // MOT also lists a timetable copy of trips it is tracking; that copy is the same bus
    if (tracked.some((t) => Math.abs(t - m) < SAME_TRIP_MIN)) continue;
    if (m > -1 && (!best || m < best.minutes)) best = { minutes: Math.max(0, m), tracked: false, trip: null };
  }
  if (best) best.clock = fmtClock(new Date(Date.now() + best.minutes * 60000));
  return best;
}

function busLabel(bus) {
  const m = busModel(bus);
  if (!m) return "בדרך";
  if (m.departsIn > 0.5 && !m.stale) return `בחניון ראשל"צ, יוצא בעוד ~${Math.round(m.departsIn)} דק'`;
  if (m.nextIdx < 0) return m.stale ? "אין GPS, לא ידוע איפה" : "סיים בת״א";
  if (m.nextIdx === 0) return "בדרך לת״א";
  return `בדרך ל${STOPS[m.nextIdx].name}`;
}

function placeName(lat, lon) {
  let best = null;
  for (const s of [HUB, ...STOPS]) {
    const d = haversine(lat, lon, s.lat, s.lon);
    if (!best || d < best.d) best = { s, d };
  }
  return best.d < 250 ? `ליד ${best.s === HUB ? "החניון בראשל״צ" : best.s.name}` : "בדרך";
}

// what is real and what is estimated, in one line
function busTruth(bus) {
  const place = displayPlace(bus);
  const fix = busFix(bus);
  if (!fix) return "אין GPS מהאוטובוס · זמנים לפי משרד התחבורה";
  const gps = `GPS ${fmtClock(fix.at)} ${placeName(fix.lat, fix.lon)} (${fmtAge(fix.ageMin)})`;
  if (place && place.stale) return `אין GPS כבר ${Math.round(fix.ageMin)} דק' · מיקום אחרון ידוע ${placeName(fix.lat, fix.lon)} · זמנים לפי משרד התחבורה`;
  if (place && !place.estimated) return fix.ageMin <= GPS_LIVE_MIN ? `מיקום חי · ${gps}` : gps;
  if (place && onHighway(place)) return `מיקום משוער, בכביש המהיר אין GPS · ${gps}`;
  return `מיקום משוער · ${gps}`;
}

// between the lot and the first Tel Aviv stop buses send no GPS; travel time there varies by ±5 min
function onHighway(place) {
  return place.s > 400 && place.s < STOPS[0].s - 300;
}

// The model moves when data changes. Between GPS fixes the bus never drives backward on screen (it
// holds until the target catches up) and closes forward gaps gradually instead of teleporting.
// A new GPS fix is real evidence: the model re-anchors on it (projected forward to now), so if that
// puts the bus behind the marker, the marker glides back to it rather than staying wrong.
const CATCHUP_TAU_S = 3;
const CATCHUP_MAX_MPS = 20;
const CORRECT_BACK_MIN_M = 150;
const CORRECT_BACK_MAX_MPS = 150;
const CORRECT_BACK_JUMP_M = 600;
const SNAP_M = 4000;
const shown = new Map();
function displayPlace(bus) {
  const place = busModel(bus);
  if (!place) return null;
  const fixAt = place.fix ? place.fix.at.getTime() : 0;
  const prev = shown.get(bus.id);
  if (!prev) return { ...place, offset: 0, correcting: false };

  const dt = Math.min(5, Math.max(0, (Date.now() - prev.t) / 1000));
  let offset = prev.version === dataVersion ? prev.offset : prev.s - place.s;
  let correcting = prev.correcting;
  if (fixAt > prev.fixAt && Math.abs(prev.s - place.s) > CORRECT_BACK_MIN_M) {
    // a long correction reads better as "position updated" (with the GPS pulse) than as the bus
    // racing or reversing down the road
    if (Math.abs(prev.s - place.s) > CORRECT_BACK_JUMP_M) return { ...place, offset: 0, correcting: false };
    correcting = true;
  }

  // fade the gap out; drifting forward is gentle, a correction from a new GPS fix is quicker
  const cap = correcting ? CORRECT_BACK_MAX_MPS : CATCHUP_MAX_MPS;
  const faded = offset * Math.exp(-dt / CATCHUP_TAU_S);
  const step = Math.min(Math.abs(offset - faded), cap * dt);
  offset -= Math.sign(offset) * step;
  if (Math.abs(offset) < 2 || offset < -SNAP_M) offset = 0;
  if (offset === 0) correcting = false;
  // without new GPS evidence, never drive backward on screen: hold until the target catches up
  const s = correcting ? place.s + offset : Math.max(prev.s, place.s + offset);
  offset = s - place.s;
  if (offset === 0) return { ...place, offset, correcting };
  const p = pointAt(s);
  const estimated = !place.fix || haversine(p.lat, p.lon, place.fix.lat, place.fix.lon) > 40;
  return { ...place, lat: p.lat, lon: p.lon, s, heading: p.heading, estimated, offset, correcting };
}

// `far`: the rider isn't near the route, so the stop shouldn't be marked as "theirs"
function nearestStop() {
  if (!state.me) return null;
  let best = null;
  STOPS.forEach((s, i) => {
    const d = haversine(state.me.lat, state.me.lon, s.lat, s.lon);
    if (!best || d < best.dist) best = { stop: s, index: i, dist: d };
  });
  best.far = best.dist > NEAR_STOP_MAX_M;
  return best;
}

function stopPopup(i) {
  const el = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = STOPS[i].name;
  const line = document.createElement("div");
  const next = stopNext(i);
  line.textContent = next
    ? `הבא ~${next.clock} (${fmtMin(next.minutes)})${next.tracked ? "" : " לפי לו״ז"}`
    : "אין נסיעות קרובות";
  el.append(title, line);
  return el;
}

function myStopAndTarget() {
  const near = nearestStop();
  const myIdx = near ? near.index : 0;
  const target = stopNext(myIdx);
  return { near, myIdx, target, closestId: target && target.tracked ? target.trip : null };
}

function busPopup(bus) {
  const { myIdx } = myStopAndTarget();
  const el = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = busLabel(bus);
  const eta = busEtaAt(bus, myIdx);
  const line1 = document.createElement("div");
  line1.textContent = eta == null ? "כבר עבר את התחנה שלך" : `לתחנה שלך: ~${fmtMin(eta)}`;
  const mot = bus.etas.get(String(STOPS[myIdx].code));
  const line2 = document.createElement("div");
  line2.className = "popup-sub";
  line2.textContent = busTruth(bus);
  el.append(title, line1, line2);
  if (mot != null && eta != null) {
    const line3 = document.createElement("div");
    line3.className = "popup-sub";
    line3.textContent = `משרד התחבורה: ${fmtMin(mot - (Date.now() - state.fetchedAt) / 60000)}`;
    el.append(line3);
  }
  return el;
}

// One marker per bus, persisted per trip: it moves every second and an open popup stays open
const busMarkers = new Map();
function updateBusMarkers() {
  const { closestId } = myStopAndTarget();
  const live = new Set();
  for (const b of state.buses) {
    const place = displayPlace(b);
    if (!place || place.done) continue;
    live.add(b.id);
    shown.set(b.id, {
      s: place.s,
      offset: place.offset,
      correcting: place.correcting,
      version: dataVersion,
      fixAt: place.fix ? place.fix.at.getTime() : 0,
      t: Date.now(),
    });
    const isLive = place.fix && place.fix.ageMin <= GPS_LIVE_MIN && !place.estimated;
    const pinged = Date.now() - (newFixAt.get(b.id) || 0) < 2500;
    // no recent GPS behind this position (typically on the highway): draw it as clearly approximate
    const approx = place.stale || (place.estimated && onHighway(place));
    const classes = [b.id === closestId ? "closest" : "", isLive ? "live" : "", pinged ? "ping" : "", approx ? "approx" : ""]
      .join(" ")
      .trim();
    const iconKey = `${classes}|${Math.round((place.heading ?? -1) / 10)}`;
    let m = busMarkers.get(b.id);
    if (!m) {
      const id = b.id;
      m = L.marker([place.lat, place.lon])
        .bindPopup(() => busPopup(state.buses.find((x) => x.id === id) || b))
        .addTo(busLayer);
      busMarkers.set(id, m);
    } else {
      m.setLatLng([place.lat, place.lon]);
      if (m.isPopupOpen()) m.setPopupContent(busPopup(b));
    }
    if (m.iconKey !== iconKey) {
      m.setIcon(busIcon(place.heading, classes));
      m.setZIndexOffset(b.id === closestId ? 1000 : 500);
      m.iconKey = iconKey;
    }
  }
  for (const [id, m] of busMarkers) {
    if (!live.has(id)) {
      busLayer.removeLayer(m);
      busMarkers.delete(id);
    }
  }
}

function render() {
  const { near, myIdx, target, closestId } = myStopAndTarget();

  stopMarkers.forEach((m, i) => m.setIcon(stopIcon(i + 1, near && !near.far && near.index === i)));
  updateBusMarkers();

  renderFreshness();
  renderHero(near, myIdx, target);
  renderStops(near);
  renderBuses(closestId, myIdx);
}

function renderFreshness() {
  const el = $("freshness");
  el.classList.remove("stale");
  if (state.error && (!state.fetchedAt || isStale())) {
    el.textContent = `שגיאה בטעינה: ${state.error}`;
    el.classList.add("stale");
    return;
  }
  if (!state.fetchedAt) {
    el.textContent = "טוען נתונים…";
    return;
  }
  const parts = [`זמן אמת · ${fmtClock(new Date(state.fetchedAt), true)}`];
  const lag = gpsSourceLagMin();
  if (lag != null && lag > SOURCE_LAG_WARN_MIN) {
    // the GPS feed itself is behind, not one bus: say so instead of looking like guesswork
    parts.push(`ה-GPS מתעכב ב-${Math.round(lag)} דק', זמנים לפי משרד התחבורה`);
    el.classList.add("stale");
  }
  el.textContent = parts.join(" · ");
}

// Buses only report in Tel Aviv, so judge the feed by buses MOT places there: if even the freshest
// of them is old, the feed is behind. null when no bus should be reporting.
function gpsSourceLagMin() {
  const inCity = state.buses.filter((b) => STOPS.slice(1).some((s) => b.etas.has(String(s.code))) && !b.etas.has(String(STOPS[0].code)));
  if (!inCity.length) return null;
  const ages = inCity.map((b) => busFix(b)?.ageMin ?? Infinity);
  return Math.min(...ages);
}

function renderHero(near, myIdx, target) {
  const eta = $("heroEta");
  const detail = $("heroDetail");
  const myStop = STOPS[myIdx];
  if (!state.fetchedAt) {
    eta.textContent = "—";
    detail.textContent = "טוען נתונים…";
    return;
  }
  if (!target) {
    eta.textContent = "אין כרגע";
    detail.textContent = `אין נסיעות קרובות ל${myStop.name}`;
    return;
  }
  eta.textContent = `~${fmtMin(target.minutes)} · ${target.clock}`;
  const parts = [`לתחנה ${myStop.name}`];
  if (isStale()) parts.push(`לא עדכני, נתון אחרון מ-${fmtClock(new Date(state.fetchedAt))}`);
  else if (!target.tracked) parts.push("לפי לוח זמנים, האוטובוס עוד לא משדר");
  else {
    const bus = state.buses.find((b) => b.id === target.trip);
    const place = bus && displayPlace(bus);
    const waiting = place && place.departsIn > 0;
    if (place && place.stale) parts.push("אין GPS מהאוטובוס, הזמן לפי משרד התחבורה");
    else if (place && (onHighway(place) || waiting)) parts.push("הערכה, בכביש המהיר אין GPS (±כמה דק')");
  }
  if (near && near.far) {
    parts.push(`את/ה ${fmtDist(near.dist)} מהתחנה הקרובה`);
  } else if (near) {
    parts.push(`${fmtDist(near.dist)} ממך (~${Math.max(1, Math.round((near.dist * 1.3) / WALK_MPS / 60))} דק' הליכה)`);
  } else {
    parts.push(state.meSource === "denied" ? "אין גישה למיקום, לחץ על המפה לבחור מיקום" : "מאתר מיקום…");
  }
  detail.textContent = parts.join(" · ");
}

function renderStops(near) {
  const list = $("stopList");
  list.replaceChildren();
  STOPS.forEach((s, i) => {
    const li = document.createElement("li");
    if (near && !near.far && near.index === i) li.classList.add("nearest");

    const dot = document.createElement("span");
    dot.className = "stop-dot";
    dot.textContent = String(i + 1);

    const main = document.createElement("div");
    main.className = "row-main";
    const name = document.createElement("p");
    name.className = "stop-name";
    name.textContent = s.name;
    const sub = document.createElement("p");
    sub.className = "row-sub";
    const next = stopNext(i);
    const bits = [];
    if (state.me) bits.push(`${fmtDist(haversine(state.me.lat, state.me.lon, s.lat, s.lon))} ממך`);
    if (near && !near.far && near.index === i) bits.push("הכי קרובה");
    if (next) bits.push(next.tracked ? `~${next.clock}` : `${next.clock} · לו״ז`);
    sub.textContent = bits.join(" · ") || `תחנה ${s.code}`;
    main.append(name, sub);

    const end = document.createElement("span");
    end.className = next ? (next.tracked ? "row-end" : "row-end sched") : "row-end none";
    end.textContent = next ? fmtMin(next.minutes) : "—";

    li.append(dot, main, end);
    li.addEventListener("click", () => flyToVisible([s.lat, s.lon], 17, () => stopMarkers[i].openPopup()));
    list.append(li);
  });
}

function renderBuses(closestId, myIdx) {
  const list = $("busList");
  list.replaceChildren();
  const buses = state.buses.filter((b) => {
    const m = busModel(b);
    return m && !m.done;
  });
  $("busCount").textContent = buses.length ? `(${buses.length})` : "";
  if (!buses.length) {
    const li = document.createElement("li");
    li.className = "row-sub";
    li.textContent = state.fetchedAt ? "אין כרגע אוטובוסים משדרים בדרך לתחנות" : "טוען…";
    list.append(li);
    return;
  }
  const sorted = [...buses].sort((a, b) => (busEtaAt(a, myIdx) ?? 999) - (busEtaAt(b, myIdx) ?? 999));
  for (const b of sorted) {
    const model = busModel(b);
    const li = document.createElement("li");
    if (b.id === closestId) li.classList.add("closest");

    const chip = document.createElement("span");
    chip.className = "bus-chip";
    chip.textContent = "🚌";

    const main = document.createElement("div");
    main.className = "row-main";
    const name = document.createElement("p");
    name.className = "bus-name";
    name.textContent = busLabel(b);
    const sub = document.createElement("p");
    sub.className = "row-sub";
    const bits = [];
    if (model.nextIdx > 0) bits.push(`לתחנה הבאה ~${fmtMin(model.etaTo(model.nextIdx))}`);
    bits.push(busTruth(b));
    sub.textContent = bits.join(" · ");
    main.append(name, sub);

    const end = document.createElement("span");
    const eta = busEtaAt(b, myIdx);
    end.className = eta == null ? "row-end none" : "row-end";
    end.textContent = eta == null ? "עבר" : fmtMin(eta);

    li.append(chip, main, end);
    li.addEventListener("click", () => {
      const p = displayPlace(b);
      if (p) flyToVisible([p.lat, p.lon], 16, () => busMarkers.get(b.id)?.openPopup());
    });
    list.append(li);
  }
}

// a slow GPS source must not let refreshes pile up and land out of order
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const btn = $("refreshBtn");
  btn.classList.add("spinning");
  const gpsReq = getJson("positions");
  try {
    const results = await Promise.all(ROUTE_DESCS.map(fetchRoute));
    ingest(results);
    state.fetchedAt = Date.now();
    state.error = null;
    dataVersion++;
  } catch (e) {
    const offline = e.name === "TypeError" || e.name === "TimeoutError" || e.name === "AbortError";
    state.error = offline ? "אין חיבור לשרת" : e.message || String(e);
  }
  // GPS is a separate, slower source; arrivals still work without it
  try {
    ingestGps(await gpsReq);
    state.gpsError = null;
    dataVersion++;
  } catch (e) {
    state.gpsError = e.message || String(e);
  }
  refreshing = false;
  btn.classList.remove("spinning");
  render();
}

function setMe(lat, lon, accuracy, source) {
  state.me = { lat, lon };
  state.meSource = source;
  if (!meMarker) {
    meMarker = L.marker([lat, lon], {
      icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      zIndexOffset: 2000,
    }).addTo(map);
    meAccuracy = L.circle([lat, lon], { radius: accuracy || 0, color: "#1a73e8", weight: 1, fillOpacity: 0.08 }).addTo(map);
  } else {
    meMarker.setLatLng([lat, lon]);
    meAccuracy.setLatLng([lat, lon]).setRadius(accuracy || 0);
  }
  if (!state.fittedToMe) {
    state.fittedToMe = true;
    fitToMe();
  }
  render();
}

// keep fitted points out from under the topbar and the sheet (bottom on phones, side on desktop)
function mapPadding() {
  const sheet = $("sheet").getBoundingClientRect();
  const sideSheet = sheet.height > window.innerHeight * 0.6 && sheet.width < window.innerWidth * 0.6;
  if (sideSheet) return { paddingTopLeft: [40, 90], paddingBottomRight: [sheet.width + 40, 40] };
  return { paddingTopLeft: [40, 90], paddingBottomRight: [40, sheet.height + 40] };
}

// Center a point in the part of the map the panels don't cover, then run `then` (open its popup)
function flyToVisible(latlng, zoom, then) {
  const sheet = $("sheet");
  if (sheet.classList.contains("expanded")) sheet.classList.remove("expanded");
  // the sheet animates its height; measure the padding after it settles
  setTimeout(() => {
    map.flyToBounds([latlng, latlng], { ...mapPadding(), maxZoom: zoom, duration: 0.8 });
    if (!then) return;
    // registered after the fly starts, so a moveend left over from an earlier pan can't trigger
    // it; the timer covers browsers that skip the animation (low power, background)
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      then();
    };
    map.once("moveend", run);
    setTimeout(run, 1100);
  }, 260);
}

// Leaflet only keeps popups inside the map box; also keep them out from under our panels
L.Popup.prototype.options.autoPan = false;
map.on("popupopen", (e) => {
  const el = e.popup.getElement();
  if (!el) return;
  const mapBox = map.getContainer().getBoundingClientRect();
  const sheet = $("sheet").getBoundingClientRect();
  const sideSheet = sheet.height > window.innerHeight * 0.6 && sheet.width < window.innerWidth * 0.6;
  const free = {
    top: mapBox.top + 80,
    bottom: (sideSheet ? mapBox.bottom : sheet.top) - 16,
    left: mapBox.left + 12,
    right: (sideSheet ? sheet.left : mapBox.right) - 12,
  };
  const box = el.getBoundingClientRect();
  let dx = 0;
  let dy = 0;
  if (box.top < free.top) dy = box.top - free.top;
  else if (box.bottom > free.bottom) dy = box.bottom - free.bottom;
  if (box.left < free.left) dx = box.left - free.left;
  else if (box.right > free.right) dx = box.right - free.right;
  if (dx || dy) map.panBy([dx, dy], { duration: 0.3 });
});

function fitToMe() {
  if (!state.me) return;
  const near = nearestStop();
  const pts = [[state.me.lat, state.me.lon]];
  if (near && near.dist < 5000) pts.push([near.stop.lat, near.stop.lon]);
  if (pts.length === 1) pts.push([state.me.lat + 0.002, state.me.lon + 0.002], [state.me.lat - 0.002, state.me.lon - 0.002]);
  map.flyToBounds(pts, { ...mapPadding(), maxZoom: 17 });
}

map.fitBounds(STOPS.map((s) => [s.lat, s.lon]), mapPadding());

function startGeolocation() {
  const params = new URLSearchParams(location.search);
  const lat = parseFloat(params.get("lat"));
  const lon = parseFloat(params.get("lon"));
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    setMe(lat, lon, 0, "manual");
    return;
  }
  if (!("geolocation" in navigator)) {
    state.meSource = "denied";
    render();
    return;
  }
  navigator.geolocation.watchPosition(
    (p) => setMe(p.coords.latitude, p.coords.longitude, p.coords.accuracy, "gps"),
    () => {
      if (state.meSource !== "manual") {
        state.meSource = "denied";
        render();
      }
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
  );
}

map.on("click", (e) => {
  if (state.meSource === "gps") return;
  setMe(e.latlng.lat, e.latlng.lng, 0, "manual");
});

$("refreshBtn").addEventListener("click", refresh);
$("locateBtn").addEventListener("click", () => (state.me ? fitToMe() : startGeolocation()));
$("handle").addEventListener("click", () => $("sheet").classList.toggle("expanded"));

setInterval(() => {
  if (!document.hidden) refresh();
}, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
// buses move every second; text and countdowns every 10s
setInterval(() => {
  if (!document.hidden && state.fetchedAt) updateBusMarkers();
}, 1000);
setInterval(() => {
  if (!document.hidden) render();
}, 10000);

render();
refresh();
startGeolocation();
