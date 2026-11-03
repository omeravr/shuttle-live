import http.client
import io
import json
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

import server

SAMPLE = {"data": {"20876": {"stopTimes": []}}, "success": True, "message": None}


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def fake_upstream(body):
    return mock.patch.object(server.urllib.request, "urlopen", return_value=FakeResponse(body))


class ProxyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def setUp(self):
        server._cache.clear()

    # http.client, not urllib, so mocking the proxy's upstream call can't hit the test client
    def get(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=5)
        try:
            conn.request("GET", path)
            res = conn.getresponse()
            return res.status, res.headers, res.read()
        finally:
            conn.close()

    def test_proxies_valid_route(self):
        with fake_upstream(json.dumps(SAMPLE).encode()) as up:
            status, headers, body = self.get("/api/arrivals?routeDesc=11861-2-0")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), SAMPLE)
        self.assertIn("application/json", headers["Content-Type"])
        url = up.call_args[0][0].full_url
        self.assertIn("routeDesc=11861-2-0", url)
        self.assertIn("stopCodes=20876%2C28581", url)

    def test_rejects_other_routes(self):
        with fake_upstream(b"{}") as up:
            for q in ["", "?routeDesc=", "?routeDesc=480-1-0", "?routeDesc=11861-3-0", "?routeDesc=11861-1-0%26x=1"]:
                status, _, _ = self.get(f"/api/arrivals{q}")
                self.assertEqual(status, 400, q)
        up.assert_not_called()

    def test_caches_upstream(self):
        with fake_upstream(json.dumps(SAMPLE).encode()) as up:
            self.get("/api/arrivals?routeDesc=11861-1-0")
            up.return_value = FakeResponse(json.dumps(SAMPLE).encode())
            self.get("/api/arrivals?routeDesc=11861-1-0")
        self.assertEqual(up.call_count, 1)

    def test_cache_is_per_route(self):
        with fake_upstream(json.dumps(SAMPLE).encode()) as up:
            up.side_effect = lambda *a, **k: FakeResponse(json.dumps(SAMPLE).encode())
            self.get("/api/arrivals?routeDesc=11861-1-0")
            self.get("/api/arrivals?routeDesc=11861-2-0")
        self.assertEqual(up.call_count, 2)

    def test_concurrent_misses_share_one_upstream_call(self):
        calls = []

        def slow(*args, **kwargs):
            calls.append(1)
            time.sleep(0.3)
            return FakeResponse(json.dumps(SAMPLE).encode())

        with mock.patch.object(server.urllib.request, "urlopen", side_effect=slow):
            threads = [threading.Thread(target=self.get, args=("/api/arrivals?routeDesc=11861-2-0",)) for _ in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertEqual(len(calls), 1)

    def test_upstream_error_is_502(self):
        with mock.patch.object(server.urllib.request, "urlopen", side_effect=urllib.error.URLError("down")):
            status, _, _ = self.get("/api/arrivals?routeDesc=11861-2-0")
        self.assertEqual(status, 502)

    def test_upstream_html_is_502_and_not_cached(self):
        with fake_upstream(b"<html>maintenance</html>") as up:
            status, _, _ = self.get("/api/arrivals?routeDesc=11861-2-0")
        self.assertEqual(status, 502)
        self.assertEqual(server._cache, {})

    def test_positions_keeps_latest_fix_per_trip(self):
        def row(journey, at, lat):
            return {"siri_ride__journey_ref": journey, "recorded_at_time": at, "lat": lat, "lon": 34.78, "velocity": 20}

        by_line = {
            "44919": [],
            "44920": [
                row("2026-11-03-586229119", "2026-11-03T19:20:00+00:00", 32.07),
                row("2026-11-03-586229119", "2026-11-03T19:21:00+00:00", 32.08),
                row("2026-11-03-586229120", "2026-11-03T19:15:00+00:00", 31.97),
                row("garbage", "2026-11-03T19:15:00+00:00", 1),
            ],
        }

        def upstream(req, timeout):
            line = urllib.parse.parse_qs(urllib.parse.urlparse(req.full_url).query)["siri_routes__line_ref"][0]
            self.assertIn("recorded_at_time_to", req.full_url)
            return FakeResponse(json.dumps(by_line[line]).encode())

        with mock.patch.object(server.urllib.request, "urlopen", side_effect=upstream) as up:
            status, _, body = self.get("/api/positions")
        self.assertEqual(status, 200)
        self.assertEqual(up.call_count, 2)
        fixes = {f["trip"]: f for f in json.loads(body)["fixes"]}
        self.assertEqual(set(fixes), {586229119, 586229120})
        self.assertEqual(fixes[586229119]["lat"], 32.08)
        self.assertEqual(fixes[586229119]["recordedAt"], "2026-11-03T19:21:00+00:00")

    def test_positions_bad_upstream_is_502(self):
        with fake_upstream(b'{"detail": "error"}'):
            status, _, _ = self.get("/api/positions")
        self.assertEqual(status, 502)

    def test_serves_static_files(self):
        status, headers, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn(b"861", body)
        for path in ["/app.js", "/styles.css"]:
            status, headers, _ = self.get(path)
            self.assertEqual(status, 200, path)
            self.assertEqual(headers["Cache-Control"], "no-cache", path)

    def test_no_path_traversal(self):
        status, _, body = self.get("/../../../../etc/passwd")
        self.assertNotIn(b"root:", body)


if __name__ == "__main__":
    unittest.main()
