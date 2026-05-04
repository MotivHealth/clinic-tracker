// server.js — Clinic Tracker API Server
// Serves scan data as JSON and triggers scheduled scans

const express = require('express');
const cron    = require('node-cron');
const path    = require('path');
const { runScan, loadData, CLINICS } = require('./scanner');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use((req,res,next) => { res.setHeader('Access-Control-Allow-Origin','*'); next(); });
app.use(express.static(path.join(__dirname,'public')));

// ─── API ──────────────────────────────────────────────────────────────────────

// Health check
app.get('/api/status', (req,res) => {
  const data   = loadData();
  const latest = data.scans[data.scans.length-1];
  res.json({
    status:     'ok',
    totalScans: data.scans.length,
    latestScan: latest?.ts || null,
    latestWeek: latest?.weekLabel || null,
    nextScan:   'Every 2 hours Mon–Fri 7am–8pm Sydney time',
    clinics:    CLINICS.map(c=>({ key:c.key, name:c.name, pracCount:c.pracs.length }))
  });
});

// All scans (optionally filtered by weekStart query param)
app.get('/api/scans', (req,res) => {
  const data = loadData();
  let scans = data.scans;
  if (req.query.week)  scans = scans.filter(s => s.weekStart === req.query.week);
  if (req.query.limit) scans = scans.slice(-parseInt(req.query.limit));
  res.json(scans);
});

// Latest scan only
app.get('/api/latest', (req,res) => {
  const data = loadData();
  res.json(data.scans[data.scans.length-1] || null);
});

// All distinct weeks scanned
app.get('/api/weeks', (req,res) => {
  const data  = loadData();
  const weeks = {};
  data.scans.forEach(s => {
    if (!weeks[s.weekStart]) weeks[s.weekStart] = { weekStart:s.weekStart, weekLabel:s.weekLabel, scanCount:0, lastScan:s.ts };
    weeks[s.weekStart].scanCount++;
    weeks[s.weekStart].lastScan = s.ts;
  });
  res.json(Object.values(weeks).sort((a,b) => b.weekStart.localeCompare(a.weekStart)));
});

// Trigger manual scan
app.post('/api/scan', async (req,res) => {
  try {
    console.log('Manual scan triggered via API');
    const result = await runScan();
    res.json({ success:true, ts:result.ts, weekLabel:result.weekLabel });
  } catch(e) {
    console.error('Manual scan error:', e.message);
    res.status(500).json({ success:false, error:e.message });
  }
});

// ─── SCHEDULE ─────────────────────────────────────────────────────────────────
// Every 2 hours, Mon–Fri, between 7am–8pm Sydney time (AEST = UTC+10)
// Cron runs at minute 0 of hours: 21,23,01,03,05,07,09 UTC ≈ 7am–7pm AEST
cron.schedule('0 21,23,1,3,5,7,9 * * 1-5', async () => {
  console.log(`Scheduled scan triggered at ${new Date().toISOString()}`);
  try { await runScan(); }
  catch(e) { console.error('Scheduled scan failed:', e.message); }
}, { timezone: 'UTC' });

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\nClinic tracker running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`API:       http://localhost:${PORT}/api/status\n`);
  // Run an initial scan on startup
  try { await runScan(); }
  catch(e) { console.error('Startup scan failed:', e.message); }
});
