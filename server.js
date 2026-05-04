// server.js — Clinic Tracker API + Dashboard
// Scans every 30 minutes, 24/7

const express = require('express');
const cron    = require('node-cron');
const path    = require('path');
const { runScan, loadData, CLINICS } = require('./scanner');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
app.use(express.static(path.join(__dirname, 'public')));

// ─── API ─────────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const data   = loadData();
  const latest = data.scans[data.scans.length - 1];
  res.json({
    status:     'ok',
    totalScans: data.scans.length,
    latestScan: latest?.ts || null,
    latestWeek: latest?.weeks?.[0]?.weekLabel || null,
    schedule:   'Every 30 minutes, 24/7',
    clinics:    CLINICS.map(c => ({ key: c.key, name: c.name, pracs: c.pracs.length }))
  });
});

app.get('/api/scans', (req, res) => {
  const data  = loadData();
  let scans   = data.scans;
  if (req.query.limit) scans = scans.slice(-parseInt(req.query.limit));
  res.json(scans);
});

app.get('/api/latest', (req, res) => {
  const data = loadData();
  res.json(data.scans[data.scans.length - 1] || null);
});

app.post('/api/scan', async (req, res) => {
  try {
    console.log('Manual scan triggered');
    const result = await runScan();
    res.json({ success: true, ts: result.ts, weeks: result.weeks.length });
  } catch(e) {
    console.error('Scan error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── SCHEDULE: every 30 minutes, 24/7 ───────────────────────────────────────
cron.schedule('*/30 * * * *', async () => {
  console.log(`Scheduled scan at ${new Date().toISOString()}`);
  try { await runScan(); }
  catch(e) { console.error('Scheduled scan failed:', e.message); }
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\nClinic tracker running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`Schedule:  Every 30 minutes, 24/7\n`);
  try { await runScan(); }
  catch(e) { console.error('Startup scan failed:', e.message); }
});
