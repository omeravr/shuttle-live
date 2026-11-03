// Cloudflare Worker: the same two endpoints as server.py, for the hosted site.
//   /api/arrivals?routeDesc=11861-1-0|11861-2-0  MOT real-time arrivals (the MOT API sends no CORS headers)
//   /api/positions                                last real GPS fix per trip (Open Bus / SIRI)

const MOT_URL = "https://api.bus.gov.il/prod/mot-scheduler-prod/api/he/Calendar/GetRouteCalendarAtStopsByStopCodes";
const STOP_CODES = "20876,28581,20313,25625,25722,21238,21815";
const ROUTE_DESC = /^11861-[12]-0$/;
const GPS_URL = "https://open-bus-stride-api.hasadna.org.il/siri_vehicle_locations/list";
const LINE_REFS = [44919, 44920];
const GPS_LOOKBACK_MIN = 30;
const CACHE_SECONDS = 10;
const ALLOWED_ORIGINS = ["https://omeravr.github.io", "http://localhost:8861", "http://127.0.0.1:8861"];
const UPSTREAM_HEADERS = { Accept: "application/json", "User-Agent": "shuttle-861-live/1.0" };

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    Vary: "Origin",
  };
}

async function getJson(url, timeoutMs) {
  const res = await fetch(url, { headers: UPSTREAM_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.json();
}

async function arrivals(routeDesc) {
  const q = new URLSearchParams({ stopCodes: STOP_CODES, routeDesc });
  return getJson(`${MOT_URL}?${q}`, 15000);
}

async function positions() {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "+00:00");
  const latest = new Map();
  for (const lineRef of LINE_REFS) {
    // an open-ended time range makes this API scan for over a minute and 500
    const q = new URLSearchParams({
      siri_routes__line_ref: String(lineRef),
      recorded_at_time_from: iso(now - GPS_LOOKBACK_MIN * 60000),
      recorded_at_time_to: iso(now + 5 * 60000),
      limit: "1000",
    });
    const rows = await getJson(`${GPS_URL}?${q}`, 30000);
    if (!Array.isArray(rows)) throw new Error("unexpected GPS response");
    for (const r of rows) {
      // journey_ref is "<date>-<trip id>"; the trip id matches the MOT tripIdToDate
      const trip = String(r.siri_ride__journey_ref || "").split("-").pop();
      if (!/^\d+$/.test(trip)) continue;
      const prev = latest.get(trip);
      if (!prev || r.recorded_at_time > prev.recordedAt) {
        latest.set(trip, { trip: Number(trip), lat: r.lat, lon: r.lon, recordedAt: r.recorded_at_time, velocity: r.velocity });
      }
    }
  }
  return { fixes: [...latest.values()] };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: cors(origin) });

    const url = new URL(request.url);
    let load;
    if (url.pathname === "/api/arrivals") {
      const routeDesc = url.searchParams.get("routeDesc") || "";
      if (!ROUTE_DESC.test(routeDesc)) return new Response("bad routeDesc", { status: 400, headers: cors(origin) });
      load = () => arrivals(routeDesc);
    } else if (url.pathname === "/api/positions") {
      load = positions;
    } else {
      return new Response("not found", { status: 404, headers: cors(origin) });
    }

    // share one upstream answer across viewers for a few seconds
    const cacheKey = new Request(`https://cache.local${url.pathname}?${url.searchParams}`);
    const cache = caches.default;
    let res = await cache.match(cacheKey);
    if (!res) {
      try {
        const body = JSON.stringify(await load());
        res = new Response(body, {
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
        });
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
      } catch (e) {
        return new Response(`upstream failed: ${e.message}`, { status: 502, headers: cors(origin) });
      }
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors(origin))) out.headers.set(k, v);
    out.headers.set("Cache-Control", "no-store");
    return out;
  },
};
