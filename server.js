// server.js — Clinic Tracker
// Regular scans: every 5 minutes, 24/7
// Baseline scan: once per day at midnight Sydney time (2pm UTC)

const express = require('express');
const cron    = require('node-cron');
const path    = require('path');
const { runScan, runBaselineScan, loadData, loadBaselines, CLINICS } = require('./scanner');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use((req,res,next) => { res.setHeader('Access-Control-Allow-Origin','*'); next(); });
app.use(express.static(path.join(__dirname,'public')));

// ─── API ─────────────────────────────────────────────────────────────────────

app.get('/api/status', (req,res) => {
  const data      = loadData();
  const baselines = loadBaselines();
  const latest    = data.scans[data.scans.length-1];
  res.json({
    status:        'ok',
    totalScans:    data.scans.length,
    latestScan:    latest?.ts || null,
    latestWeek:    latest?.weeks?.[0]?.weekLabel || null,
    baselineDates: Object.keys(baselines).sort(),
    schedule:      'Scans every 5 min 24/7 · Baseline daily at midnight Sydney',
    clinics:       CLINICS.map(c=>({key:c.key, name:c.name, pracs:c.pracs.length}))
  });
});

app.get('/api/scans', (req,res) => {
  const data  = loadData();
  let scans   = data.scans;
  if(req.query.limit) scans = scans.slice(-parseInt(req.query.limit));
  res.json(scans);
});

app.get('/api/latest', (req,res) => {
  const data = loadData();
  res.json(data.scans[data.scans.length-1]||null);
});

app.get('/api/baselines', (req,res) => {
  res.json(loadBaselines());
});

app.post('/api/scan', async (req,res) => {
  try {
    const result = await runScan();
    res.json({success:true, ts:result.ts, weeks:result.weeks.length});
  } catch(e) {
    res.status(500).json({success:false, error:e.message});
  }
});

app.post('/api/baseline', async (req,res) => {
  try {
    await runBaselineScan();
    res.json({success:true});
  } catch(e) {
    res.status(500).json({success:false, error:e.message});
  }
});

// ─── SCHEDULE ────────────────────────────────────────────────────────────────

// Regular scan: every 5 minutes, 24/7
cron.schedule('*/5 * * * *', async () => {
  console.log(`[CRON] Regular scan at ${new Date().toISOString()}`);
  try { await runScan(); } catch(e) { console.error('Scan failed:', e.message); }
});

// Baseline scan: once per day at midnight Sydney time = 14:00 UTC
cron.schedule('0 14 * * *', async () => {
  console.log(`[CRON] Baseline scan at ${new Date().toISOString()}`);
  try { await runBaselineScan(); } catch(e) { console.error('Baseline failed:', e.message); }
}, { timezone: 'UTC' });

// ─── START ───────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\nClinic tracker running on port ${PORT}`);
  console.log(`Regular scans: every 5 minutes 24/7`);
  console.log(`Baseline scan: daily at midnight Sydney (14:00 UTC)\n`);

  // On startup: run baseline first (captures today+56 days), then regular scan
  try { await runBaselineScan(); } catch(e) { console.error('Startup baseline failed:', e.message); }
  try { await runScan(); }         catch(e) { console.error('Startup scan failed:', e.message); }
});
