# Shuttle 861 Live

Live map of line 861, the free fast-lane shuttle between the Rishon LeZion park & ride and Tel Aviv: all buses on the route, your location, the nearest stop and when the next bus gets there.

## Data

- **Trips and timetable:** Ministry of Transport real-time API (`api.bus.gov.il`, the one behind route.bus.gov.il).
- **Bus GPS:** the MOT SIRI feed via [Open Bus](https://open-bus-stride-api.hasadna.org.il/docs) (Hasadna). Fixes arrive about 2 minutes late, and buses only report near the lot and in Tel Aviv.
- **Movement between fixes:** each bus starts from its last real GPS fix (or leaving the lot on schedule) and advances by the travel times this line really took at that hour, measured from 121 trips on 2026-11-03. Every bus shows where and when its last real fix was.

The MOT API sends no CORS headers, so the browser reaches both sources through a small proxy:
`server.py` locally, and a Cloudflare Worker (`worker/`) for the hosted site.

## Run locally

```bash
python3 server.py
```

Open http://localhost:8861. Add `?lat=..&lon=..` to test a location without GPS.

## Tests

```bash
python3 -m unittest test_server
```

## Deploy

- Site: GitHub Pages from `main`.
- Proxy: `cd worker && npx wrangler@4 deploy`, then set `WORKER_URL` in `app.js`.
