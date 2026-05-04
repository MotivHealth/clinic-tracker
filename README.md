# Galston Clinic Tracker

Tracks occupancy for **Galston Health and Chiropractic** and **Back on Track Chiropractic** — Mon–Fri, multiple times per day.

## What it does

- Scans both clinics every 2 hours, Mon–Fri, 7am–8pm Sydney time
- Stores each scan as a timestamped snapshot
- Serves a dashboard showing current week + historical weeks by month
- Shows booking velocity (how fast slots are filling up between scans)

## Practitioners tracked

**Galston Health and Chiropractic**
- Dr Craig Hurter — Chiropractor (Mon–Fri)
- Dr Ayden Kahveci — Chiropractor (Thu only)
- Mrs Elizabeth Sherrington — Massage Therapist (Mon/Tue/Fri)

**Back on Track Chiropractic**
- Dr Kirsty Reynolds — Chiropractor (Tue/Wed/Fri)

---

## Deploy to Render (free, runs 24/7)

1. **Create a GitHub repo** and push this folder to it
   ```
   git init
   git add .
   git commit -m "Initial clinic tracker"
   git remote add origin https://github.com/YOUR_USERNAME/clinic-tracker.git
   git push -u origin main
   ```

2. **Sign up at [render.com](https://render.com)** (free)

3. **New → Web Service** → connect your GitHub repo

4. Render will detect `render.yaml` automatically. Click **Deploy**.

5. Your dashboard will be live at:
   `https://clinic-tracker.onrender.com`

6. **Persistent data**: Render free tier has ephemeral storage (data resets on redeploy).
   To persist data across deploys, add a free **Render Disk** (500MB, $0/month on free tier):
   - In your Render service → **Disks** → Add Disk
   - Mount path: `/data`
   - Then change `DATA_FILE` in `scanner.js` to `/data/scans.json`

---

## Run locally

```bash
npm install
npm start
# Dashboard: http://localhost:3000
# Scan now:  curl -X POST http://localhost:3000/api/scan
```

## API endpoints

| Endpoint | Description |
|---|---|
| `GET /api/status` | Health check + info |
| `GET /api/scans` | All scan history |
| `GET /api/scans?week=2026-5-4` | Scans for a specific week |
| `GET /api/scans?limit=10` | Last N scans |
| `GET /api/latest` | Most recent scan |
| `GET /api/weeks` | List of weeks scanned |
| `POST /api/scan` | Trigger a manual scan |

## Scan frequency

Default: every 2 hours Mon–Fri between 7am–8pm Sydney time.

To change frequency, edit the cron expression in `server.js`:
```js
// Every hour Mon–Fri 7am–7pm AEST:
cron.schedule('0 21,22,23,0,1,2,3,4,5,6,7,8,9 * * 1-5', ...)
```
