"""Local dev server: serves the static site and proxies the two data sources.

/api/arrivals  MOT real-time arrival predictions (api.bus.gov.il, sends no CORS headers)
/api/positions last real GPS fix per trip from the MOT SIRI feed, via Open Bus (hasadna)

Upstream answers are cached briefly so several open tabs don't multiply requests.
"""

import json
import re
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 8861
UPSTREAM = "https://api.bus.gov.il/prod/mot-scheduler-prod/api/he/Calendar/GetRouteCalendarAtStopsByStopCodes"
STOP_CODES = "20876,28581,20313,25625,25722,21238,21815"
ROUTE_DESC = re.compile(r"^11861-[12]-0$")
GPS_UPSTREAM = "https://open-bus-stride-api.hasadna.org.il/siri_vehicle_locations/list"
LINE_REFS = (44919, 44920)
GPS_LOOKBACK_MIN = 30
CACHE_SECONDS = 10
HEADERS = {"Accept": "application/json", "User-Agent": "shuttle-861-live/1.0"}

_cache: dict[str, tuple[float, bytes]] = {}
_lock = threading.Lock()
_key_locks: dict[str, threading.Lock] = {}


def cached(key: str, load) -> bytes:
    with _lock:
        key_lock = _key_locks.setdefault(key, threading.Lock())
    # one upstream call per key at a time; concurrent requests wait and share its result
    with key_lock:
        with _lock:
            hit = _cache.get(key)
            if hit and time.time() - hit[0] < CACHE_SECONDS:
                return hit[1]
        body = load()
        with _lock:
            _cache[key] = (time.time(), body)
        return body


def get_json(url: str, timeout: int):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read())


def fetch_arrivals(route_desc: str) -> bytes:
    def load():
        query = urllib.parse.urlencode({"stopCodes": STOP_CODES, "routeDesc": route_desc})
        return json.dumps(get_json(f"{UPSTREAM}?{query}", 15)).encode()

    return cached(f"arrivals:{route_desc}", load)


def fetch_positions() -> bytes:
    def load():
        now = datetime.now(timezone.utc).replace(microsecond=0)
        # an open-ended time range makes this API scan for over a minute and 500
        frm = (now - timedelta(minutes=GPS_LOOKBACK_MIN)).isoformat()
        to = (now + timedelta(minutes=5)).isoformat()
        latest: dict[str, dict] = {}
        for line_ref in LINE_REFS:
            query = urllib.parse.urlencode({
                "siri_routes__line_ref": line_ref,
                "recorded_at_time_from": frm,
                "recorded_at_time_to": to,
                "limit": 1000,
            })
            rows = get_json(f"{GPS_UPSTREAM}?{query}", 30)
            if not isinstance(rows, list):
                raise ValueError("unexpected GPS response")
            for r in rows:
                # journey_ref is "<date>-<trip id>"; the trip id matches the MOT tripIdToDate
                trip = str(r.get("siri_ride__journey_ref", "")).rsplit("-", 1)[-1]
                if not trip.isdigit():
                    continue
                prev = latest.get(trip)
                if not prev or r["recorded_at_time"] > prev["recordedAt"]:
                    latest[trip] = {
                        "trip": int(trip),
                        "lat": r["lat"],
                        "lon": r["lon"],
                        "recordedAt": r["recorded_at_time"],
                        "velocity": r.get("velocity"),
                    }
        return json.dumps({"fixes": list(latest.values())}).encode()

    return cached("positions", load)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(Path(__file__).parent), **kwargs)

    def end_headers(self):
        # without this the browser heuristically caches app.js and keeps running old code after edits
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/api/arrivals":
            route_desc = urllib.parse.parse_qs(url.query).get("routeDesc", [""])[0]
            if not ROUTE_DESC.match(route_desc):
                return self.send_error(400, "bad routeDesc")
            return self.send_upstream(lambda: fetch_arrivals(route_desc))
        if url.path == "/api/positions":
            return self.send_upstream(fetch_positions)
        return super().do_GET()

    def send_upstream(self, load):
        try:
            body = load()
        except Exception as e:
            return self.send_error(502, f"upstream failed: {type(e).__name__}")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print(f"http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
