// scanner.js — Galston Area Clinic Occupancy Scanner
// Tracks: Galston Health & Chiropractic + Back on Track Chiropractic
// Mon–Fri only. Stores timestamped snapshots for velocity/trend tracking.

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CLINICS = [
  {
    key:  'galston',
    name: 'Galston Health and Chiropractic',
    host: 'chiros-on-call.cliniko.com',
    biz:  '35543',
    pracs: [
      { id:'52687',               apptId:'146507',              name:'Dr Craig Hurter',         short:'Craig',     role:'Chiropractor',      cap:{ 1:29, 2:29, 3:10, 4:31, 5:31 } },
      { id:'1923718951779436232', apptId:'146507',              name:'Dr Ayden Kahveci',         short:'Ayden',     role:'Chiropractor',      cap:{ 4:26 } },
      { id:'1210445304252335205', apptId:'1216972388525147145', name:'Mrs Elizabeth Sherrington',short:'Elizabeth', role:'Massage Therapist', cap:{ 1:10, 2:10, 5:10 } }
    ]
  },
  {
    key:  'bot',
    name: 'Back on Track Chiropractic',
    host: 'backontrackchiropractic.cliniko.com',
    biz:  '36244',
    pracs: [
      { id:'53734', apptId:'150025', name:'Dr Kirsty Reynolds', short:'Kirsty', role:'Chiropractor', cap:{ 2:14, 3:14, 5:14 } }
    ]
  }
];

const DATA_FILE = path.join(__dirname, 'data', 'scans.json');

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fetchJson(host, urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: host, path: urlPath, method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { reject(e); } }); }
    );
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error(`Timeout ${host}`)); });
    req.end();
  });
}

const getDow = ds => { const[y,m,d]=ds.split('-').map(Number); return new Date(y,m-1,d).getDay(); };

function getCurrentWeekDays() {
  const now    = new Date();
  const sydney = new Date(now.getTime() + (10*60 - now.getTimezoneOffset())*60000);
  const dow    = sydney.getDay();
  const mon    = new Date(sydney);
  mon.setDate(sydney.getDate() - (dow===0 ? 6 : dow-1));
  mon.setHours(0,0,0,0);
  return Array.from({length:5}, (_,i) => {
    const d = new Date(mon); d.setDate(mon.getDate()+i);
    return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
  });
}

const fmtDay  = ds => { const[y,m,d]=ds.split('-').map(Number); return new Date(y,m-1,d).toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'}); };
const fmtWeek = days => { const a=fmtDay(days[0]),b=fmtDay(days[4]); return `${a} – ${b}`; };

function loadData() {
  try { if(fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }
  catch(e) { console.error('loadData:',e.message); }
  return { scans:[] };
}
function saveData(d) {
  const dir=path.dirname(DATA_FILE);
  if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2));
}

// ─── SCAN ─────────────────────────────────────────────────────────────────────

async function runScan() {
  const days = getCurrentWeekDays();
  const ts   = new Date().toISOString();
  console.log(`\n[${ts}] Scanning ${fmtWeek(days)}`);

  const snap = {
    ts,
    weekStart: days[0],
    weekEnd:   days[4],
    weekLabel: fmtWeek(days),
    dayLabels: days.map(fmtDay),
    clinics: {}
  };

  for (const clinic of CLINICS) {
    console.log(`  → ${clinic.name}`);
    snap.clinics[clinic.key] = { name: clinic.name, pracs: {} };

    // Build tasks
    const tasks = [];
    for (const p of clinic.pracs)
      for (const day of days)
        if ((p.cap[getDow(day)]||0) > 0) tasks.push({p, day, cap: p.cap[getDow(day)]});

    // Fire all in parallel
    const settled = await Promise.allSettled(tasks.map(({p,day,cap}) => {
      const[y,m,d]=day.split('-').map(Number);
      const qs=`appointment_type_id=${p.apptId}&business_id=${clinic.biz}&date=${y}-${m}-${d}&facebook_page_id=&practitioner_ids=${p.id}&reservation_key=&time_zone=Sydney`;
      return fetchJson(clinic.host, `/bookings/time_slots?${qs}`)
        .then(slots => ({pracId:p.id, day, cap, free: Array.isArray(slots)?slots.length:null}));
    }));

    // Index
    const idx = {};
    settled.forEach((r,i) => {
      const key = `${tasks[i].p.id}|${tasks[i].day}`;
      idx[key] = r.status==='fulfilled' ? r.value : {cap:tasks[i].cap, free:null, error:r.reason?.message};
    });

    // Per-prac summary
    for (const p of clinic.pracs) {
      const dayData = {};
      let wCap=0, wBooked=0;
      for (const day of days) {
        const cap = p.cap[getDow(day)]||0;
        if (!cap) { dayData[day]={cap:0,free:null,booked:null,occ:null,off:true}; continue; }
        const r = idx[`${p.id}|${day}`];
        if (!r||r.free===null) { dayData[day]={cap,free:null,booked:null,occ:null,error:true}; continue; }
        const booked=Math.max(0,cap-r.free), occ=Math.round((booked/cap)*100);
        dayData[day]={cap,free:r.free,booked,occ};
        wCap+=cap; wBooked+=booked;
      }
      const wOcc = wCap>0 ? Math.round((wBooked/wCap)*100) : 0;
      snap.clinics[clinic.key].pracs[p.id] = {
        name:p.name, short:p.short, role:p.role,
        days:dayData,
        weekTotal:{cap:wCap,booked:wBooked,occ:wOcc}
      };
      console.log(`     ${p.short}: ${wBooked}/${wCap} = ${wOcc}%`);
    }
  }

  const data = loadData();
  data.scans.push(snap);
  if (data.scans.length > 1000) data.scans = data.scans.slice(-1000);
  saveData(data);
  console.log(`  ✓ Done. Total scans: ${data.scans.length}`);
  return snap;
}

module.exports = { runScan, loadData, CLINICS };
if (require.main===module) runScan().catch(console.error);
