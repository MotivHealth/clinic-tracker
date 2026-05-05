// server.js — Clinic Tracker
// Regular scans: every 5 minutes, 24/7
// Baseline scan: once per day at midnight Sydney time (2pm UTC)
// Bulk baseline: POST /api/baseline/bulk — pre-populates all 56 days at once

const express = require('express');
const cron    = require('node-cron');
const https   = require('https');
const path    = require('path');
const fs      = require('fs');
const { runScan, runBaselineScan, loadData, loadBaselines, saveBaselines, CLINICS } = require('./scanner');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use((req,res,next) => { res.setHeader('Access-Control-Allow-Origin','*'); next(); });
app.use(express.static(path.join(__dirname,'public')));

function fetchJson(host, urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: host, path: urlPath, method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { reject(e); } }); }
    );
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout ' + host)); });
    req.end();
  });
}

function getSydney() {
  const now = new Date();
  return new Date(now.getTime() + (10*60 - now.getTimezoneOffset())*60000);
}
function getSydneyDateStr(offsetDays=0) {
  const s = getSydney(); s.setDate(s.getDate()+offsetDays);
  return `${s.getFullYear()}-${s.getMonth()+1}-${s.getDate()}`;
}
const getDow = ds => { const[y,m,d]=ds.split('-').map(Number); return new Date(y,m-1,d).getDay(); };

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
    baselineCount: Object.keys(baselines).length,
    schedule:      'Scans every 5 min 24/7 · Baseline daily at midnight Sydney',
    clinics:       CLINICS.map(c=>({key:c.key, name:c.name, pracs:c.pracs.length}))
  });
});

app.get('/api/scans', (req,res) => {
  const data = loadData();
  let scans  = data.scans;
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

app.post('/api/baseline/bulk', async (req,res) => {
  console.log('[BULK BASELINE] Starting pre-population for days 0-56...');
  res.json({success:true, message:'Bulk baseline started. Takes 2-3 minutes. Check /api/status for baselineCount.'});

  setImmediate(async () => {
    const baselines = loadBaselines();
    let saved = 0, skipped = 0;

    const allTasks = [];
    for(let offset = 0; offset <= 56; offset++) {
      const day = getSydneyDateStr(offset);
      for(const clinic of CLINICS) {
        for(const prac of clinic.pracs) {
          const cap = prac.cap[getDow(day)] || 0;
          if(cap > 0) {
            if(baselines[day]?.[clinic.key]?.[prac.id]) { skipped++; continue; }
            allTasks.push({day, clinic, prac});
          }
        }
      }
    }

    console.log(`[BULK BASELINE] ${allTasks.length} tasks (${skipped} already exist)`);

    const BATCH = 20;
    for(let i = 0; i < allTasks.length; i += BATCH) {
      const batch = allTasks.slice(i, i + BATCH);
      const settled = await Promise.allSettled(batch.map(({clinic,prac,day}) => {
        const[y,m,d]=day.split('-').map(Number);
        const qs=`appointment_type_id=${prac.apptId}&business_id=${clinic.biz}&date=${y}-${m}-${d}&facebook_page_id=&practitioner_ids=${prac.id}&reservation_key=&time_zone=Sydney`;
        return fetchJson(clinic.host, `/bookings/time_slots?${qs}`)
          .then(slots => ({clinicKey:clinic.key, pracId:prac.id, day, slots:Array.isArray(slots)?slots:[], free:Array.isArray(slots)?slots.length:0}));
      }));

      settled.forEach((r) => {
        if(r.status!=='fulfilled'||r.value.free===0) return;
        const {clinicKey,pracId,free,slots,day} = r.value;
        if(!baselines[day]) baselines[day]={};
        if(!baselines[day][clinicKey]) baselines[day][clinicKey]={};
        baselines[day][clinicKey][pracId] = {
          free,
          slots: slots.map(s=>({hour:s.hour,minute:s.minute})),
          ts: new Date().toISOString()
        };
        saved++;
      });

      saveBaselines(baselines);
      console.log(`[BULK BASELINE] Batch ${Math.floor(i/BATCH)+1}/${Math.ceil(allTasks.length/BATCH)} done. Saved: ${saved}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`[BULK BASELINE] Complete. ${saved} saved, ${skipped} skipped.`);
  });
});

cron.schedule('*/5 * * * *', async () => {
  console.log(`[CRON] Scan at ${new Date().toISOString()}`);
  try { await runScan(); } catch(e) { console.error('Scan failed:', e.message); }
});

cron.schedule('0 14 * * *', async () => {
  console.log(`[CRON] Baseline at ${new Date().toISOString()}`);
  try { await runBaselineScan(); } catch(e) { console.error('Baseline failed:', e.message); }
}, { timezone: 'UTC' });

app.listen(PORT, async () => {
  console.log(`\nClinic tracker on port ${PORT}`);
  console.log(`Scans: every 5 min 24/7`);
  console.log(`Baseline: daily midnight Sydney\n`);
  try { await runBaselineScan(); } catch(e) { console.error('Startup baseline failed:', e.message); }
  try { await runScan(); }         catch(e) { console.error('Startup scan failed:', e.message); }
});
