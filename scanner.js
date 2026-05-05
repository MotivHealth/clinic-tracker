// scanner.js — Galston Area Clinic Occupancy Scanner
//
// NEW: New patient consultation detection via consecutive slot analysis
// Scans every 30 seconds using setInterval (not cron — sub-minute precision)
// Smart storage: full scans kept for 48 hours, daily summaries kept indefinitely
//
// HOW NEW PATIENT DETECTION WORKS:
// Between consecutive scans, if slots disappear in a consecutive block
// matching the duration of an initial/new patient appointment, we record it.
// Craig/Ayden: 20-min slots, Initial = 60 min = 3 consecutive slots missing
// Kirsty: 30-min slots, Initial = 60 min = 2 consecutive slots missing
// Elizabeth: not tracked (all appointments are massage, same duration)
//
// Uses /bookings/days to discover working days automatically (no hardcoded schedule)

const https   = require('https');
const fs      = require('fs');
const path    = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CLINICS = [
  {
    key:  'galston',
    name: 'Galston Health and Chiropractic',
    host: 'chiros-on-call.cliniko.com',
    biz:  '35543',
    pracs: [
      {
        id:'52687', apptId:'146507', name:'Dr Craig Hurter', short:'Craig', role:'Chiropractor',
        fallbackCap: 29,
        slotDuration: 20,        // minutes per slot
        initialApptSlots: 3,     // consecutive slots = 60-min Initial consultation
        initialApptPrice: 120,
        standardApptPrice: 82
      },
      {
        id:'1923718951779436232', apptId:'146507', name:'Dr Ayden Kahveci', short:'Ayden', role:'Chiropractor',
        fallbackCap: 26,
        slotDuration: 20,
        initialApptSlots: 3,
        initialApptPrice: 120,
        standardApptPrice: 82
      },
      {
        id:'1210445304252335205', apptId:'1216972388525147145', name:'Mrs Elizabeth Sherrington', short:'Elizabeth', role:'Massage Therapist',
        fallbackCap: 10,
        slotDuration: 60,
        initialApptSlots: null,  // null = don't track new patient consults
        standardApptPrice: 100
      }
    ]
  },
  {
    key:  'bot',
    name: 'Back on Track Chiropractic',
    host: 'backontrackchiropractic.cliniko.com',
    biz:  '36244',
    pracs: [
      {
        id:'53734', apptId:'150025', name:'Dr Kirsty Reynolds', short:'Kirsty', role:'Chiropractor',
        fallbackCap: 14,
        slotDuration: 30,
        initialApptSlots: 2,     // consecutive slots = 60-min Initial consultation
        initialApptPrice: 120,
        standardApptPrice: 82
      }
    ]
  }
];

const DATA_FILE      = path.join(__dirname, 'data', 'scans.json');
const BASELINE_FILE  = path.join(__dirname, 'data', 'baselines.json');
const CONSULTS_FILE  = path.join(__dirname, 'data', 'consults.json');
const PREV_SCAN_FILE = path.join(__dirname, 'data', 'prev_scan.json');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function fetchJson(host, urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname:host, path:urlPath, method:'GET',
        headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0'} },
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
  const s=getSydney(); s.setDate(s.getDate()+offsetDays);
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

// ─── PERSISTENCE ─────────────────────────────────────────────────────────────

function ensureDir(f) { const d=path.dirname(f); if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); }
function loadJSON(f, def={}) { try { if(fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,'utf8')); } catch(e){} return def; }
function saveJSON(f, d) { ensureDir(f); fs.writeFileSync(f, JSON.stringify(d,null,2)); }

function loadData()      { return loadJSON(DATA_FILE, {scans:[]}); }
function saveData(d)     { saveJSON(DATA_FILE, d); }
function loadBaselines() { return loadJSON(BASELINE_FILE, {}); }
function saveBaselines(b){ saveJSON(BASELINE_FILE, b); }
function loadConsults()  { return loadJSON(CONSULTS_FILE, {}); }
function saveConsults(c) { saveJSON(CONSULTS_FILE, c); }
function loadPrevScan()  { return loadJSON(PREV_SCAN_FILE, null); }
function savePrevScan(s) { saveJSON(PREV_SCAN_FILE, s); }

// Smart storage: keep full scans for 48 hours, prune older ones
function pruneScans(scans) {
  const cutoff = Date.now() - (48 * 60 * 60 * 1000);
  return scans.filter(s => new Date(s.ts).getTime() > cutoff);
}

// ─── DISCOVER WORKING DAYS ────────────────────────────────────────────────────

async function getWorkingDays(clinic, prac, year, month) {
  try {
    const qs=`appointment_type_id=${prac.apptId}&business_id=${clinic.biz}&month=${month}&practitioner_ids=${prac.id}&time_zone=Sydney&year=${year}`;
    const data = await fetchJson(clinic.host, `/bookings/days?${qs}`);
    if (!Array.isArray(data)) return [];
    return data.map(item => `${year}-${month}-${item.day}`);
  } catch(e) { return []; }
}

async function discoverWorkingDays(clinic, prac, allDates) {
  const monthGroups = {};
  allDates.forEach(ds => {
    const[y,m]=ds.split('-').map(Number);
    monthGroups[`${y}-${m}`]={year:y,month:m};
  });
  const results = await Promise.allSettled(
    Object.values(monthGroups).map(({year,month}) => getWorkingDays(clinic,prac,year,month))
  );
  const workingSet = new Set();
  results.forEach(r => { if(r.status==='fulfilled') r.value.forEach(d=>workingSet.add(d)); });
  return allDates.filter(d => workingSet.has(d));
}

// ─── NEW PATIENT CONSULT DETECTION ───────────────────────────────────────────
// Compare two slot arrays (prev and current) for a single practitioner on a single day.
// Returns {newPatients: N} by detecting consecutive missing slot blocks.

function detectNewPatientConsults(prevSlots, currSlots, prac) {
  if (!prac.initialApptSlots || !prevSlots || !currSlots) return { newPatients:0 };

  const currSet = new Set(currSlots.map(s=>`${s.hour}:${s.minute}`));
  
  // Find which slots disappeared
  const missing = prevSlots
    .filter(s => !currSet.has(`${s.hour}:${s.minute}`))
    .sort((a,b) => (a.hour*60+a.minute) - (b.hour*60+b.minute));

  if (missing.length === 0) return { newPatients:0 };

  // Group missing slots into consecutive blocks
  // A block is consecutive if each slot is exactly slotDuration minutes after the previous
  const blocks = [];
  let currentBlock = [missing[0]];

  for (let i=1; i<missing.length; i++) {
    const prev = missing[i-1];
    const curr = missing[i];
    const prevMins = prev.hour*60 + prev.minute;
    const currMins = curr.hour*60 + curr.minute;
    
    if (currMins - prevMins === prac.slotDuration) {
      // Consecutive — add to current block
      currentBlock.push(curr);
    } else {
      // Gap — start new block
      blocks.push(currentBlock);
      currentBlock = [curr];
    }
  }
  blocks.push(currentBlock);

  // Count blocks that match initialApptSlots length = new patient consult
  let newPatients = 0;
  blocks.forEach(block => {
    if (block.length === prac.initialApptSlots) {
      newPatients++;
    }
    // Blocks shorter than initialApptSlots = standard appointment(s)
    // Blocks longer = unusual (e.g. multiple consecutive standards) — don't count as initial
  });

  return { newPatients };
}

// Record detected new patient consults to persistent storage
function recordConsults(ts, clinicKey, pracId, day, newPatients) {
  if (newPatients === 0) return;
  const consults = loadConsults();
  const weekStart = getWeekDays(0)[0]; // current week Monday

  if (!consults[weekStart]) consults[weekStart] = {};
  if (!consults[weekStart][clinicKey]) consults[weekStart][clinicKey] = {};
  if (!consults[weekStart][clinicKey][pracId]) consults[weekStart][clinicKey][pracId] = {};
  if (!consults[weekStart][clinicKey][pracId][day]) consults[weekStart][clinicKey][pracId][day] = 0;

  consults[weekStart][clinicKey][pracId][day] += newPatients;
  saveConsults(consults);
  console.log(`  🔔 New patient consult detected: ${clinicKey}/${pracId} on ${day} (+${newPatients})`);
}

// ─── BASELINE SCAN ───────────────────────────────────────────────────────────

async function runBaselineScan() {
  const targetDate = getSydneyDateStr(56);
  const [ty,tm]    = targetDate.split('-').map(Number);
  const ts         = new Date().toISOString();
  console.log(`\n[BASELINE ${ts}] ${targetDate} (56 days out)`);

  const baselines = loadBaselines();
  if (!baselines[targetDate]) baselines[targetDate] = {};

  const tasks = [];
  for (const clinic of CLINICS)
    for (const prac of clinic.pracs) {
      const wd = await getWorkingDays(clinic, prac, ty, tm);
      if (wd.includes(targetDate)) tasks.push({clinic, prac});
    }

  const settled = await Promise.allSettled(tasks.map(({clinic,prac}) => {
    const[y,m,d]=targetDate.split('-').map(Number);
    const qs=`appointment_type_id=${prac.apptId}&business_id=${clinic.biz}&date=${y}-${m}-${d}&facebook_page_id=&practitioner_ids=${prac.id}&reservation_key=&time_zone=Sydney`;
    return fetchJson(clinic.host, `/bookings/time_slots?${qs}`)
      .then(slots=>({clinicKey:clinic.key, pracId:prac.id, slots:Array.isArray(slots)?slots:[], free:Array.isArray(slots)?slots.length:0}));
  }));

  settled.forEach((r,i) => {
    if (r.status!=='fulfilled'||r.value.free===0) return;
    const {clinicKey,pracId,free,slots} = r.value;
    if (!baselines[targetDate][clinicKey]) baselines[targetDate][clinicKey]={};
    baselines[targetDate][clinicKey][pracId] = {
      free, slots:slots.map(s=>({hour:s.hour,minute:s.minute})), ts
    };
    console.log(`  ${clinicKey}/${tasks[i].prac.short}: ${free} slots baseline`);
  });

  saveBaselines(baselines);
  return baselines;
}

// ─── REGULAR SCAN ────────────────────────────────────────────────────────────

async function runScan() {
  const ts        = new Date().toISOString();
  const baselines = loadBaselines();
  const sydney    = getSydney();
  const nowMins   = sydney.getHours()*60 + sydney.getMinutes();
  const prevScan  = loadPrevScan();

  const weeks = Array.from({length:5}, (_,i) => {
    const days=getWeekDays(i);
    return {days, weekStart:days[0], weekEnd:days[6], weekLabel:fmtWeek(days), dayLabels:days.map(fmtDay), isCurrent:i===0, weekOffset:i};
  });

  // Discover working days
  const allFutureDates = [...new Set(weeks.flatMap(w=>w.days).filter(d=>!isPast(d)))];
  const workingDayCache = {};
  for (const clinic of CLINICS)
    for (const prac of clinic.pracs) {
      const wd = await discoverWorkingDays(clinic, prac, allFutureDates);
      workingDayCache[`${clinic.key}|${prac.id}`] = new Set(wd);
    }

  // Build and fire all fetch tasks
  const allTasks = [];
  for (const week of weeks)
    for (const clinic of CLINICS)
      for (const prac of clinic.pracs) {
        const wd = workingDayCache[`${clinic.key}|${prac.id}`];
        for (const day of week.days)
          if (!isPast(day) && wd && wd.has(day))
            allTasks.push({week, clinic, prac, day});
      }

  const settled = await Promise.allSettled(allTasks.map(({clinic,prac,day}) => {
    const[y,m,d]=day.split('-').map(Number);
    const qs=`appointment_type_id=${prac.apptId}&business_id=${clinic.biz}&date=${y}-${m}-${d}&facebook_page_id=&practitioner_ids=${prac.id}&reservation_key=&time_zone=Sydney`;
    return fetchJson(clinic.host, `/bookings/time_slots?${qs}`)
      .then(slots=>({clinicKey:clinic.key, pracId:prac.id, day, slots:Array.isArray(slots)?slots:[], free:Array.isArray(slots)?slots.length:null}));
  }));

  const idx = {};
  settled.forEach((r,i) => {
    const t=allTasks[i];
    idx[`${t.clinic.key}|${t.prac.id}|${t.day}`] = r.status==='fulfilled' ? r.value : {free:null,slots:[],error:r.reason?.message};
  });

  // ── NEW PATIENT DETECTION ──
  // Compare current slots against previous scan's slots for today's dates
  // Only run on today's dates — future dates: any disappearing slot is a booking but
  // we don't have time-level data to distinguish consecutive blocks
  if (prevScan) {
    for (const clinic of CLINICS) {
      for (const prac of clinic.pracs) {
        if (!prac.initialApptSlots) continue; // skip Elizabeth
        const today = todayStr();
        const curr = idx[`${clinic.key}|${prac.id}|${today}`];
        if (!curr || curr.free === null) continue;

        // Get prev scan's slots for today
        let prevSlots = null;
        if (prevScan.weeks) {
          for (const w of prevScan.weeks) {
            const p = w.clinics?.[clinic.key]?.pracs?.[prac.id];
            if (p?.days?.[today]?.slots) { prevSlots = p.days[today].slots; break; }
          }
        }

        if (prevSlots && curr.slots) {
          const {newPatients} = detectNewPatientConsults(prevSlots, curr.slots, prac);
          if (newPatients > 0) recordConsults(ts, clinic.key, prac.id, today, newPatients);
        }
      }
    }
  }

  // Build week snapshots
  const weekSnapshots = weeks.map(week => {
    const snap={weekStart:week.weekStart, weekEnd:week.weekEnd, weekLabel:week.weekLabel, dayLabels:week.dayLabels, isCurrent:week.isCurrent, weekOffset:week.weekOffset, clinics:{}};

    for (const clinic of CLINICS) {
      snap.clinics[clinic.key]={name:clinic.name, pracs:{}};
      for (const prac of clinic.pracs) {
        const wd = workingDayCache[`${clinic.key}|${prac.id}`];
        const dayData={};
        let wCap=0, wBooked=0;

        for (const day of week.days) {
          if (!isPast(day) && (!wd || !wd.has(day))) {
            dayData[day]={cap:0,free:null,booked:null,occ:null,off:true};
            continue;
          }
          if (isPast(day)) {
            const prev = getPrevDayData(prevScan, clinic.key, prac.id, day);
            if (prev && prev.booked!==null) {
              dayData[day]={...prev, frozen:true};
              wCap+=prev.cap||0; wBooked+=prev.booked;
            } else {
              dayData[day]={cap:0,free:null,booked:null,occ:null,frozen:true,off:true};
            }
            continue;
          }

          const r        = idx[`${clinic.key}|${prac.id}|${day}`];
          const baseline = baselines[day]?.[clinic.key]?.[prac.id];
          if (!r||r.free===null) { dayData[day]={cap:0,free:null,booked:null,occ:null,error:true}; continue; }

          if (isToday(day)) {
            if (baseline && baseline.slots && baseline.slots.length>0) {
              const currSet = new Set(r.slots.map(s=>`${s.hour}:${s.minute}`));
              let booked=0, elapsedOpen=0;
              baseline.slots.forEach(s => {
                const slotMins = s.hour*60+s.minute;
                if (!currSet.has(`${s.hour}:${s.minute}`)) {
                  if (slotMins <= nowMins) elapsedOpen++;
                  else booked++;
                }
              });
              const cap=baseline.slots.length;
              dayData[day]={cap, free:r.free, booked, elapsedOpen, occ:cap>0?Math.round((booked/cap)*100):0, today:true, slots:r.slots};
              wCap+=cap; wBooked+=booked;
            } else {
              const cap=baseline?.free||prac.fallbackCap;
              const booked=Math.max(0,cap-r.free);
              dayData[day]={cap, free:r.free, booked, occ:Math.round((booked/cap)*100), today:true, noBaseline:true, slots:r.slots};
              wCap+=cap; wBooked+=booked;
            }
            continue;
          }

          if (baseline && baseline.free>0) {
            const booked=Math.max(0,baseline.free-r.free);
            dayData[day]={cap:baseline.free, free:r.free, booked, occ:Math.round((booked/baseline.free)*100)};
            wCap+=baseline.free; wBooked+=booked;
          } else {
            dayData[day]={cap:r.free||prac.fallbackCap, free:r.free, booked:0, occ:0, noBaseline:true};
            wCap+=r.free||prac.fallbackCap;
          }
        }

        const wOcc=wCap>0?Math.round((wBooked/wCap)*100):0;
        snap.clinics[clinic.key].pracs[prac.id]={
          name:prac.name, short:prac.short, role:prac.role,
          days:dayData, weekTotal:{cap:wCap,booked:wBooked,occ:wOcc}
        };
      }
    }
    return snap;
  });

  const scanEntry={ts, currentWeekStart:weeks[0].weekStart, weeks:weekSnapshots};

  // Save with smart pruning
  const data = loadData();
  data.scans.push(scanEntry);
  data.scans = pruneScans(data.scans);
  saveData(data);

  // Save as prev scan for next comparison (slot-level data for new patient detection)
  savePrevScan(scanEntry);

  console.log(`  Saved. Scans in 48h window: ${data.scans.length}`);
  return scanEntry;
}

function getPrevDayData(prevScan, clinicKey, pracId, day) {
  if (!prevScan||!prevScan.weeks) return null;
  for (const week of prevScan.weeks) {
    const prac=week.clinics?.[clinicKey]?.pracs?.[pracId];
    if (prac&&prac.days?.[day]) return prac.days[day];
  }
  return null;
}

module.exports = {runScan, runBaselineScan, loadData, loadBaselines, loadConsults, saveBaselines, CLINICS};
if (require.main===module) {
  const arg=process.argv[2];
  if(arg==='baseline') runBaselineScan().catch(console.error);
  else runScan().catch(console.error);
}
