// scanner.js — Galston Area Clinic Occupancy Scanner
//
// KEY CHANGE: Uses /bookings/days endpoint to discover which days each
// practitioner actually works — no more hardcoded cap per day-of-week.
// Schedule changes (new days, removed days, extra Saturdays, Sundays)
// are picked up automatically.
//
// APPROACH:
// 1. DISCOVER: For each practitioner, call /bookings/days for each month
//    we need to scan — returns exactly which days have availability
// 2. BASELINE: Once per day at midnight Sydney, scan the day 56 days out.
//    Free slots = true capacity for that day. Stored in baselines.json.
// 3. REGULAR SCANS every 5 min: booked = baseline_free - current_free
// 4. TODAY: Use slot-level comparison to distinguish elapsed vs booked

const https   = require('https');
const fs      = require('fs');
const path    = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// cap is now FALLBACK ONLY — used when no baseline exists yet
// The scanner no longer uses cap to decide WHICH days to fetch
// (that comes from /bookings/days instead)

const CLINICS = [
  {
    key:  'galston',
    name: 'Galston Health and Chiropractic',
    host: 'chiros-on-call.cliniko.com',
    biz:  '35543',
    pracs: [
      { id:'52687',               apptId:'146507',              name:'Dr Craig Hurter',         short:'Craig',     role:'Chiropractor',      fallbackCap:29 },
      { id:'1923718951779436232', apptId:'146507',              name:'Dr Ayden Kahveci',         short:'Ayden',     role:'Chiropractor',      fallbackCap:26 },
      { id:'1210445304252335205', apptId:'1216972388525147145', name:'Mrs Elizabeth Sherrington',short:'Elizabeth', role:'Massage Therapist', fallbackCap:10 }
    ]
  },
  {
    key:  'bot',
    name: 'Back on Track Chiropractic',
    host: 'backontrackchiropractic.cliniko.com',
    biz:  '36244',
    pracs: [
      { id:'53734', apptId:'150025', name:'Dr Kirsty Reynolds', short:'Kirsty', role:'Chiropractor', fallbackCap:14 }
    ]
  }
];

const DATA_FILE     = path.join(__dirname, 'data', 'scans.json');
const BASELINE_FILE = path.join(__dirname, 'data', 'baselines.json');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function fetchJson(host, urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: host, path: urlPath, method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } },
      res => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>{ try{resolve(JSON.parse(b));}catch(e){reject(e);} }); }
    );
    req.on('error', reject);
    req.setTimeout(12000, ()=>{ req.destroy(); reject(new Error('Timeout '+host)); });
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
function dateNum(ds) { const[y,m,d]=ds.split('-').map(Number); return y*10000+m*100+d; }
const todayStr = () => getSydneyDateStr(0);
const isToday  = ds => ds === todayStr();
const isPast   = ds => dateNum(ds) < dateNum(todayStr());

function getWeekDays(offsetWeeks) {
  const sydney = getSydney();
  const dow    = sydney.getDay();
  const mon    = new Date(sydney);
  mon.setDate(sydney.getDate() - (dow===0?6:dow-1) + (offsetWeeks*7));
  mon.setHours(0,0,0,0);
  return Array.from({length:7}, (_,i) => {
    const d=new Date(mon); d.setDate(mon.getDate()+i);
    return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
  });
}

const fmtDay  = ds => { const[y,m,d]=ds.split('-').map(Number); return new Date(y,m-1,d).toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'}); };
const fmtWeek = days => `${fmtDay(days[0])} \u2013 ${fmtDay(days[6])}`;

function loadData() {
  try { if(fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }
  catch(e) { console.error('loadData:', e.message); }
  return { scans:[] };
}
function saveData(d) {
  if(!fs.existsSync(path.dirname(DATA_FILE))) fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});
  fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2));
}
function loadBaselines() {
  try { if(fs.existsSync(BASELINE_FILE)) return JSON.parse(fs.readFileSync(BASELINE_FILE,'utf8')); }
  catch(e) { console.error('loadBaselines:', e.message); }
  return {};
}
function saveBaselines(b) {
  if(!fs.existsSync(path.dirname(BASELINE_FILE))) fs.mkdirSync(path.dirname(BASELINE_FILE),{recursive:true});
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(b,null,2));
}

// ─── DISCOVER WORKING DAYS ────────────────────────────────────────────────────
// Calls /bookings/days for a given month to find which days a practitioner works.
// Returns array of date strings like ['2026-5-6', '2026-5-7', ...]
// This replaces hardcoded cap — any schedule change is picked up automatically.

async function getWorkingDays(clinic, prac, year, month) {
  try {
    const qs = `appointment_type_id=${prac.apptId}&business_id=${clinic.biz}&month=${month}&practitioner_ids=${prac.id}&time_zone=Sydney&year=${year}`;
    const data = await fetchJson(clinic.host, `/bookings/days?${qs}`);
    if (!Array.isArray(data)) return [];
    // Each item is {day: N, day_parts: [...]}
    // day is the day-of-month number
    return data.map(item => `${year}-${month}-${item.day}`);
  } catch(e) {
    console.error(`  getWorkingDays error ${clinic.key}/${prac.short}:`, e.message);
    return [];
  }
}

// Get all working days for a practitioner across a set of date strings
// Groups dates by year-month, makes one /bookings/days call per month
async function discoverWorkingDays(clinic, prac, allDates) {
  // Group dates by year-month
  const monthGroups = {};
  allDates.forEach(ds => {
    const [y,m] = ds.split('-').map(Number);
    const key = `${y}-${m}`;
    if (!monthGroups[key]) monthGroups[key] = {year:y, month:m};
  });

  // Fetch working days for each month in parallel
  const results = await Promise.allSettled(
    Object.values(monthGroups).map(({year,month}) =>
      getWorkingDays(clinic, prac, year, month)
    )
  );

  // Merge all working days into a set for fast lookup
  const workingDaySet = new Set();
  results.forEach(r => {
    if (r.status === 'fulfilled') r.value.forEach(d => workingDaySet.add(d));
  });

  // Filter allDates to only those that are working days
  return allDates.filter(d => workingDaySet.has(d));
}

// ─── BASELINE SCAN ───────────────────────────────────────────────────────────

async function runBaselineScan() {
  const targetDate = getSydneyDateStr(56);
  const [ty, tm]   = targetDate.split('-').map(Number);
  const ts         = new Date().toISOString();
  console.log(`\n[BASELINE ${ts}] Scanning ${targetDate} (56 days out)`);

  const baselines = loadBaselines();
  if (!baselines[targetDate]) baselines[targetDate] = {};

  const tasks = [];
  for (const clinic of CLINICS) {
    for (const prac of clinic.pracs) {
      // Use /bookings/days to check if this prac works on targetDate
      const workingDays = await getWorkingDays(clinic, prac, ty, tm);
      if (workingDays.includes(targetDate)) {
        tasks.push({clinic, prac});
      }
    }
  }

  if (tasks.length === 0) {
    console.log(`  No practitioners working on ${targetDate}`);
    return baselines;
  }

  const settled = await Promise.allSettled(tasks.map(({clinic,prac}) => {
    const[y,m,d]=targetDate.split('-').map(Number);
    const qs=`appointment_type_id=${prac.apptId}&business_id=${clinic.biz}&date=${y}-${m}-${d}&facebook_page_id=&practitioner_ids=${prac.id}&reservation_key=&time_zone=Sydney`;
    return fetchJson(clinic.host, `/bookings/time_slots?${qs}`)
      .then(slots=>({clinicKey:clinic.key, pracId:prac.id, slots:Array.isArray(slots)?slots:[], free:Array.isArray(slots)?slots.length:0}));
  }));

  settled.forEach((r,i)=>{
    if (r.status!=='fulfilled'||r.value.free===0) return;
    const {clinicKey,pracId,free,slots} = r.value;
    if (!baselines[targetDate][clinicKey]) baselines[targetDate][clinicKey]={};
    baselines[targetDate][clinicKey][pracId] = {
      free,
      slots: slots.map(s=>({hour:s.hour,minute:s.minute})),
      ts
    };
    console.log(`  ${clinicKey}/${tasks[i].prac.short}: ${free} slots = baseline for ${targetDate}`);
  });

  saveBaselines(baselines);
  console.log(`  Baseline saved for ${targetDate}`);
  return baselines;
}

// ─── REGULAR SCAN ────────────────────────────────────────────────────────────

async function runScan() {
  const ts        = new Date().toISOString();
  const baselines = loadBaselines();
  const sydney    = getSydney();
  const nowMins   = sydney.getHours()*60 + sydney.getMinutes();

  // 5 weeks: current + 4 ahead (Mon–Sun each)
  const weeks = Array.from({length:5}, (_,i) => {
    const days = getWeekDays(i);
    return {days, weekStart:days[0], weekEnd:days[6], weekLabel:fmtWeek(days), dayLabels:days.map(fmtDay), isCurrent:i===0, weekOffset:i};
  });

  console.log(`\n[SCAN ${ts}] ${weeks[0].weekLabel} -> ${weeks[4].weekLabel}`);

  // Collect all future/today dates across all weeks
  const allFutureDates = [...new Set(
    weeks.flatMap(w => w.days).filter(d => !isPast(d))
  )];

  // Discover working days per practitioner using /bookings/days
  // Group by month to minimise API calls
  console.log(`  Discovering working days...`);
  const workingDayCache = {}; // key: clinicKey|pracId -> Set of date strings

  for (const clinic of CLINICS) {
    for (const prac of clinic.pracs) {
      const cacheKey = `${clinic.key}|${prac.id}`;
      const workingDays = await discoverWorkingDays(clinic, prac, allFutureDates);
      workingDayCache[cacheKey] = new Set(workingDays);
    }
  }

  // Build fetch tasks — only for days where practitioner actually works
  const allTasks = [];
  for (const week of weeks) {
    for (const clinic of CLINICS) {
      for (const prac of clinic.pracs) {
        const cacheKey = `${clinic.key}|${prac.id}`;
        const workingDays = workingDayCache[cacheKey];
        for (const day of week.days) {
          if (!isPast(day) && workingDays && workingDays.has(day)) {
            allTasks.push({week, clinic, prac, day});
          }
        }
      }
    }
  }

  console.log(`  Firing ${allTasks.length} time_slots requests...`);

  const settled = await Promise.allSettled(allTasks.map(({clinic,prac,day}) => {
    const[y,m,d]=day.split('-').map(Number);
    const qs=`appointment_type_id=${prac.apptId}&business_id=${clinic.biz}&date=${y}-${m}-${d}&facebook_page_id=&practitioner_ids=${prac.id}&reservation_key=&time_zone=Sydney`;
    return fetchJson(clinic.host, `/bookings/time_slots?${qs}`)
      .then(slots=>({clinicKey:clinic.key, pracId:prac.id, day, slots:Array.isArray(slots)?slots:[], free:Array.isArray(slots)?slots.length:null}));
  }));

  const idx = {};
  settled.forEach((r,i) => {
    const t = allTasks[i];
    idx[`${t.clinic.key}|${t.prac.id}|${t.day}`] = r.status==='fulfilled' ? r.value : {free:null,slots:[],error:r.reason?.message};
  });

  const data     = loadData();
  const prevScan = data.scans[data.scans.length-1]||null;

  const weekSnapshots = weeks.map(week => {
    const snap = {weekStart:week.weekStart, weekEnd:week.weekEnd, weekLabel:week.weekLabel, dayLabels:week.dayLabels, isCurrent:week.isCurrent, weekOffset:week.weekOffset, clinics:{}};

    for (const clinic of CLINICS) {
      snap.clinics[clinic.key] = {name:clinic.name, pracs:{}};

      for (const prac of clinic.pracs) {
        const cacheKey  = `${clinic.key}|${prac.id}`;
        const workingDays = workingDayCache[cacheKey];
        const dayData   = {};
        let wCap=0, wBooked=0;

        for (const day of week.days) {
          // Day off — practitioner doesn't work this day according to /bookings/days
          if (!workingDays || (!workingDays.has(day) && !isPast(day))) {
            // For past days, fall through to frozen data check
            if (!isPast(day)) {
              dayData[day] = {cap:0, free:null, booked:null, occ:null, off:true};
              continue;
            }
          }

          // ── PAST: carry forward frozen data ──
          if (isPast(day)) {
            const prev = getPrevDayData(prevScan, clinic.key, prac.id, day);
            if (prev && prev.booked!==null) {
              dayData[day] = {...prev, frozen:true};
              wCap += prev.cap||0; wBooked += prev.booked;
            } else {
              dayData[day] = {cap:0, free:null, booked:null, occ:null, frozen:true, off:true};
            }
            continue;
          }

          const r        = idx[`${clinic.key}|${prac.id}|${day}`];
          const baseline = baselines[day]?.[clinic.key]?.[prac.id];

          if (!r||r.free===null) { dayData[day]={cap:0,free:null,booked:null,occ:null,error:true}; continue; }

          if (isToday(day)) {
            if (baseline && baseline.slots && baseline.slots.length>0) {
              const currentSlotKeys = new Set(r.slots.map(s=>`${s.hour}:${s.minute}`));
              let booked=0, elapsedOpen=0;
              baseline.slots.forEach(s => {
                const slotKey  = `${s.hour}:${s.minute}`;
                const slotMins = s.hour*60+s.minute;
                if (!currentSlotKeys.has(slotKey)) {
                  if (slotMins <= nowMins) elapsedOpen++;
                  else booked++;
                }
              });
              const totalCap = baseline.slots.length;
              const occ      = totalCap>0?Math.round((booked/totalCap)*100):0;
              dayData[day]   = {cap:totalCap, free:r.free, booked, elapsedOpen, occ, today:true};
              wCap+=totalCap; wBooked+=booked;
            } else {
              // No baseline — use free count as fallback cap
              const cap      = baseline?.free || prac.fallbackCap;
              const booked   = Math.max(0, cap-r.free);
              const occ      = Math.round((booked/cap)*100);
              dayData[day]   = {cap, free:r.free, booked, occ, today:true, noBaseline:true};
              wCap+=cap; wBooked+=booked;
            }
            continue;
          }

          // ── FUTURE: baseline comparison ──
          if (baseline && baseline.free>0) {
            const booked = Math.max(0, baseline.free - r.free);
            const occ    = Math.round((booked/baseline.free)*100);
            dayData[day] = {cap:baseline.free, free:r.free, booked, occ};
            wCap+=baseline.free; wBooked+=booked;
          } else {
            // No baseline yet — use free count returned as cap fallback
            const cap    = r.free + (r.free===0 ? prac.fallbackCap : 0) || prac.fallbackCap;
            const booked = 0; // can't know booked without baseline
            dayData[day] = {cap:r.free||prac.fallbackCap, free:r.free, booked:0, occ:0, noBaseline:true};
            wCap += r.free||prac.fallbackCap;
          }
        }

        const wOcc = wCap>0?Math.round((wBooked/wCap)*100):0;
        snap.clinics[clinic.key].pracs[prac.id] = {
          name:prac.name, short:prac.short, role:prac.role,
          days:dayData,
          weekTotal:{cap:wCap, booked:wBooked, occ:wOcc}
        };
        if(wCap>0) process.stdout.write(`  ${week.isCurrent?'(now)':'(+'+week.weekOffset+'w)'} ${prac.short}: ${wBooked}/${wCap} = ${wOcc}%\n`);
      }
    }
    return snap;
  });

  const scanEntry = {ts, currentWeekStart:weeks[0].weekStart, weeks:weekSnapshots};
  data.scans.push(scanEntry);
  if(data.scans.length>10000) data.scans=data.scans.slice(-10000);
  saveData(data);
  console.log(`  Saved. Total scans: ${data.scans.length}`);
  return scanEntry;
}

function getPrevDayData(prevScan, clinicKey, pracId, day) {
  if (!prevScan||!prevScan.weeks) return null;
  for (const week of prevScan.weeks) {
    const prac = week.clinics?.[clinicKey]?.pracs?.[pracId];
    if (prac&&prac.days?.[day]) return prac.days[day];
  }
  return null;
}

module.exports = {runScan, runBaselineScan, loadData, loadBaselines, saveBaselines, CLINICS};
if (require.main===module) {
  const arg = process.argv[2];
  if(arg==='baseline') runBaselineScan().catch(console.error);
  else runScan().catch(console.error);
}
