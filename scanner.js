// scanner.js — Galston Area Clinic Occupancy Scanner
//
// APPROACH:
// 1. BASELINE: Once per day at midnight Sydney time, scan each day that is
//    exactly 8 weeks (56 days) away. All slots will be free = true capacity.
//    Stored in data/baselines.json keyed by date.
//
// 2. REGULAR 5-MIN SCANS: For future days, booked = baseline_free - current_free.
//    Accurate because slots only vanish from future days when genuinely booked.
//
// 3. TODAY'S ELAPSED SLOTS: Slots whose time has passed are removed from the
//    API whether booked or not. Fix: compare each slot against Sydney time.
//    If slot time <= now it elapsed (record as open). If slot time > now but
//    missing it was booked.

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CLINICS = [
  {
    key:  'galston',
    name: 'Galston Health and Chiropractic',
    host: 'chiros-on-call.cliniko.com',
    biz:  '35543',
    pracs: [
      { id:'52687',               apptId:'146507',              name:'Dr Craig Hurter',         short:'Craig',     role:'Chiropractor',      cap:{ 1:29, 2:29, 3:10, 4:31, 5:31, 6:18 } },
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
      { id:'53734', apptId:'150025', name:'Dr Kirsty Reynolds', short:'Kirsty', role:'Chiropractor', cap:{ 2:14, 3:14, 5:14, 6:8 } }
    ]
  }
];

const DATA_FILE     = path.join(__dirname, 'data', 'scans.json');
const BASELINE_FILE = path.join(__dirname, 'data', 'baselines.json');

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

const getDow = ds => { const[y,m,d]=ds.split('-').map(Number); return new Date(y,m-1,d).getDay(); };

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

async function runBaselineScan() {
  const targetDate = getSydneyDateStr(56);
  const ts         = new Date().toISOString();
  console.log(`\n[BASELINE ${ts}] Scanning ${targetDate} (56 days out)`);

  const baselines = loadBaselines();
  if (!baselines[targetDate]) baselines[targetDate] = {};

  const tasks = [];
  for (const clinic of CLINICS)
    for (const prac of clinic.pracs)
      if ((prac.cap[getDow(targetDate)]||0) > 0)
        tasks.push({clinic, prac, day:targetDate});

  const settled = await Promise.allSettled(tasks.map(({clinic,prac,day}) => {
    const[y,m,d]=day.split('-').map(Number);
    const qs=`appointment_type_id=${prac.apptId}&business_id=${clinic.biz}&date=${y}-${m}-${d}&facebook_page_id=&practitioner_ids=${prac.id}&reservation_key=&time_zone=Sydney`;
    return fetchJson(clinic.host, `/bookings/time_slots?${qs}`)
      .then(slots => ({clinicKey:clinic.key, pracId:prac.id, slots:Array.isArray(slots)?slots:[], free:Array.isArray(slots)?slots.length:0}));
  }));

  settled.forEach((r,i) => {
    if (r.status!=='fulfilled' || r.value.free===0) return;
    const {clinicKey,pracId,free,slots} = r.value;
    if (!baselines[targetDate][clinicKey]) baselines[targetDate][clinicKey]={};
    baselines[targetDate][clinicKey][pracId] = {
      free,
      slots: slots.map(s=>({hour:s.hour, minute:s.minute})),
      ts
    };
    console.log(`  ${clinicKey}/${pracId}: ${free} slots = baseline for ${targetDate}`);
  });

  saveBaselines(baselines);
  console.log(`  Baseline saved for ${targetDate}`);
  return baselines;
}

async function runScan() {
  const ts        = new Date().toISOString();
  const baselines = loadBaselines();
  const sydney    = getSydney();
  const nowMins   = sydney.getHours()*60 + sydney.getMinutes();

  const weeks = Array.from({length:5}, (_,i) => {
    const days=getWeekDays(i);
    return {days, weekStart:days[0], weekEnd:days[6], weekLabel:fmtWeek(days), dayLabels:days.map(fmtDay), isCurrent:i===0, weekOffset:i};
  });

  console.log(`\n[SCAN ${ts}] ${weeks[0].weekLabel} -> ${weeks[4].weekLabel}`);

  const allTasks = [];
  for (const week of weeks)
    for (const clinic of CLINICS)
      for (const prac of clinic.pracs)
        for (const day of week.days)
          if ((prac.cap[getDow(day)]||0)>0 && !isPast(day))
            allTasks.push({week,clinic,prac,day});

  console.log(`  Firing ${allTasks.length} requests...`);

  const settled = await Promise.allSettled(allTasks.map(({clinic,prac,day}) => {
    const[y,m,d]=day.split('-').map(Number);
    const qs=`appointment_type_id=${prac.apptId}&business_id=${clinic.biz}&date=${y}-${m}-${d}&facebook_page_id=&practitioner_ids=${prac.id}&reservation_key=&time_zone=Sydney`;
    return fetchJson(clinic.host, `/bookings/time_slots?${qs}`)
      .then(slots => ({clinicKey:clinic.key, pracId:prac.id, day, slots:Array.isArray(slots)?slots:[], free:Array.isArray(slots)?slots.length:null}));
  }));

  const idx={};
  settled.forEach((r,i) => {
    const t=allTasks[i];
    idx[`${t.clinic.key}|${t.prac.id}|${t.day}`] = r.status==='fulfilled' ? r.value : {free:null,slots:[],error:r.reason?.message};
  });

  const data     = loadData();
  const prevScan = data.scans[data.scans.length-1]||null;

  const weekSnapshots = weeks.map(week => {
    const snap={weekStart:week.weekStart, weekEnd:week.weekEnd, weekLabel:week.weekLabel, dayLabels:week.dayLabels, isCurrent:week.isCurrent, weekOffset:week.weekOffset, clinics:{}};

    for (const clinic of CLINICS) {
      snap.clinics[clinic.key]={name:clinic.name, pracs:{}};

      for (const prac of clinic.pracs) {
        const dayData={};
        let wCap=0, wBooked=0;

        for (const day of week.days) {
          const cap = prac.cap[getDow(day)]||0;
          if (!cap) { dayData[day]={cap:0,free:null,booked:null,occ:null,off:true}; continue; }

          if (isPast(day)) {
            const prev = getPrevDayData(prevScan, clinic.key, prac.id, day);
            if (prev && prev.booked!==null) {
              dayData[day]={...prev, frozen:true};
              wCap+=prev.cap||cap; wBooked+=prev.booked;
            } else {
              dayData[day]={cap,free:null,booked:null,occ:null,frozen:true,noData:true};
            }
            continue;
          }

          const r        = idx[`${clinic.key}|${prac.id}|${day}`];
          const baseline = baselines[day]?.[clinic.key]?.[prac.id];

          if (!r||r.free===null) { dayData[day]={cap,free:null,booked:null,occ:null,error:true}; continue; }

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
              const occ      = totalCap>0 ? Math.round((booked/totalCap)*100) : 0;
              dayData[day]   = {cap:totalCap, free:r.free, booked, elapsedOpen, occ, today:true};
              wCap+=totalCap; wBooked+=booked;
            } else {
              dayData[day]={cap, free:r.free, booked:null, occ:null, today:true, noBaseline:true};
            }
            continue;
          }

          if (baseline && baseline.free>0) {
            const booked = Math.max(0, baseline.free - r.free);
            const occ    = Math.round((booked/baseline.free)*100);
            dayData[day] = {cap:baseline.free, free:r.free, booked, occ};
            wCap+=baseline.free; wBooked+=booked;
          } else {
            const booked = Math.max(0, cap-r.free);
            const occ    = Math.round((booked/cap)*100);
            dayData[day] = {cap, free:r.free, booked, occ, noBaseline:true};
            wCap+=cap; wBooked+=booked;
          }
        }

        const wOcc=wCap>0?Math.round((wBooked/wCap)*100):0;
        snap.clinics[clinic.key].pracs[prac.id]={
          name:prac.name, short:prac.short, role:prac.role,
          days:dayData,
          weekTotal:{cap:wCap, booked:wBooked, occ:wOcc}
        };
        if(wCap>0) process.stdout.write(`  ${week.isCurrent?'(now)':'(+'+week.weekOffset+'w)'} ${prac.short}: ${wBooked}/${wCap} = ${wOcc}%\n`);
      }
    }
    return snap;
  });

  const scanEntry={ts, currentWeekStart:weeks[0].weekStart, weeks:weekSnapshots};
  data.scans.push(scanEntry);
  if(data.scans.length>10000) data.scans=data.scans.slice(-10000);
  saveData(data);
  console.log(`  Saved. Total scans: ${data.scans.length}`);
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

module.exports = {runScan, runBaselineScan, loadData, loadBaselines, saveBaselines, CLINICS};
if (require.main===module) {
  const arg=process.argv[2];
  if(arg==='baseline') runBaselineScan().catch(console.error);
  else runScan().catch(console.error);
}
