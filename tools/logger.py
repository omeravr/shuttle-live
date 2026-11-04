"""Record exactly what the live site receives, for offline replay and scoring.

Every POLL_S seconds: both 861 arrival feeds and the GPS positions, from the deployed Worker.
One JSON line per poll in <out>/<date>.jsonl.

    caffeinate -i python3 tools/logger.py --out ~/tmp/861log
"""

import argparse
import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

WORKER = "https://shuttle-live-proxy.omeravr.workers.dev/api"
ROUTE_DESCS = ["11861-1-0", "11861-2-0"]
POLL_S = 20


def get(path):
    # Cloudflare rejects Python's default user agent; say who we are instead
    req = urllib.request.Request(
        f"{WORKER}/{path}",
        headers={"Origin": "https://omeravr.github.io", "User-Agent": "shuttle-live-logger/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as res:
            return json.loads(res.read())
    except Exception as e:  # noqa: BLE001 - keep logging through upstream hiccups
        return {"error": f"{type(e).__name__}: {e}"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    while True:
        started = time.time()
        rec = {
            "t": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "arrivals": {rd: get(f"arrivals?routeDesc={rd}") for rd in ROUTE_DESCS},
            "positions": get("positions"),
        }
        day = datetime.now().strftime("%Y-%m-%d")
        with open(out / f"{day}.jsonl", "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        time.sleep(max(1, POLL_S - (time.time() - started)))


if __name__ == "__main__":
    main()
