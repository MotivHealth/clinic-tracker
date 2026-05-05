// scanner.js — Galston Area Clinic Occupancy Scanner
//
// KEY FIX: Baselines captured less than 7 days before the target date
// are ignored (they may already have bookings in them).
// Only baselines captured 7+ days before the target date are used.
// For near-term days without valid baselines, falls back to hardcoded cap.

const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const CLINICS = [
  {
    key:  'galston',
    name: 'Galston Health and Chiropractic',
    host: 'chiros-on-call.cliniko.com',
    biz:  '35543',
    pracs: [
      { id:'52687',               apptId:'146507',              name:'Dr Craig Hurter',         short:'Craig',     role:'Chiropractor',      fallbackCap:{ 1:29,2:29,3:10,4:31,5:31,6:18 }, slotDuration:20, initialApptSlots:3, initialApptPrice:120, standardApptPrice:82 },
      { id:'1923718951779436232', apptId:'146507',              name:'Dr Ayden Kahveci',         short:'Ayden',     role:'Chiropractor',      fallbackCap:{ 4:26 },                          slotDuration:20, initialApptSlots:3, initialApptPrice:120, standardApptPrice:82 },
      { id:'1210445304252335205', apptId:'1216972388525147145', name:'Mrs Elizabeth Sherrington',short:'Elizabeth', role:'Massage Therapist', fallbackCap:{ 1:10,2:10,5:10 },                slotDuration:60, initialApptSlots:null }
    ]
  },
  {
    key:  'bot',
    name: 'Back on Track Chiropractic',
    host: 'backontrackchiropractic.cliniko.com',
    biz:  '36244',
    pracs: [
      { id:'53734', apptId:'150025', name:'Dr Kirsty Reynolds', short:'Kirsty', role:'Chiropractor', fallbackCap:{ 2:14,3:14,5:14,6:8 }, slotDuration:30, initialApptSlots:2, initialApptPrice:120, standardApptPrice:82 }
    ]
  }
];

const DATA_FILE      = path.join(__dirname, 'data', 'scans.json');
const BASELINE_FILE  = path.join(__dirname, 'data', 'baselines.json');
const CONSULTS_FILE  = path.join(__dirname, 'data', 'consults.json');
const PREV_SCAN_FILE = path.join(__dirname, 'data', 'prev_scan.json');

function fetchJson(host, urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname:host, path:urlPath, method:'GET', headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0'} },
      res => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>{ try{resolve(JSON.parse(b));}catch(e){reject(e);} }); }
    );
    req.on('error', reject);
    req.setTimeout(12000, ()=>{ req.destroy(); reject(new Error('Timeout '+host)); });
    req.end();
  });
}

function getSydney() { const now=new Date(); return new Date(now.getTime()+(10*60-now.getTimezoneOffset())*60000); }
function getSydneyDateStr(o=0) { const s=getSydney(); s.setDate(s.getDate()+o); return `${s.getFullYear()}-${s.getMonth()+1}-${s.getDate()}`; }
function dateNum(ds) { const[y,m,d]=ds.split('-').map(Number); return y*10000+m*100+d; }
const todayStr = () => getSydneyDateStr(0);
const isToday  = ds => ds === todayStr();
const isPast   = ds => dateNum(ds) < dateNum(todayStr());
const getDow   = ds => { const[y,m,d]=ds.split('-').map(Number); return new Date(y,m-1,d).getDay(); };

function getWeekDays(offsetWeeks) {
  const sydney=getSydney(), dow=sydney.getDay(), mon=new Date(sydney);
  mon.setDate(sydney.getDate()-(dow===0?6:dow-1)+(offsetWeeks*7));
  mon.setHours(0,0,0,0);
  return Array.from({length:7},(_,i)=>{ const d=new Date(mon); d.setDate(mon.getDate()+i); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; });
}

const fmtDay  = ds => { const[y,m,d]=ds.split('-').map(Number); return new Date(y,m-1,d).toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'}); };
const fmtWeek = days => `${fmtDay(days[0])} \u2013 ${fmtDay(days[6])}`;

function ensureDir(f) { const d=path.dirname(f); if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); }
function loadJSON(f,def={}) { try { if(fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,'utf8')); } catch(e){} return def; }
function saveJSON(f,d) { ensureDir(f); fs.writeFileSync(f,JSON.stringify(d,null,2)); }
function loadData()      { return loadJSON(DATA_FILE,{scans:[]}); }
function saveData(d)     { saveJSON(DATA_FILE,d); }
function loadBaselines() { return loadJSON(BASELINE_FILE,{}); }
function saveBaselines(b){ saveJSON(BASELINE_FILE,b); }
function loadConsults()  { return loadJSON(CONSULTS_FILE,{}); }
function saveConsults(c) { saveJSON(CONSULTS_FILE,c); }
function loadPrevScan()  { return loadJSON(PREV_SCAN_FILE,null); }
function savePrevScan(s) { saveJSON(PREV_SCAN_FILE,s); }

function pruneScans(scans) {
  const cutoff = Date.now()-(48*60*60*1000);
  return scans.filter(s=>new Date(s.ts).getTime()>cutoff);
}

// KEY: Only use a baseline if it was captured at least 7 days before the target date
// This ensures baselines were captured when the day was fully open (no bookings yet)
function getValidBaseline(baselines, day, clinicKey, pracId) {
  const b = baselines[day]?.[clinicKey]?.[pracId];
  if (!b) return null;
  // Check when the baseline was captured vs the target day
  const baselineTs   = new Date(b.ts).getTime();
  const[y,m,d2]      = day.split('-').map(Number);
  const targetDate   = new Date(y,m-1,d2).getTime();
  const daysInAdvance = (targetDate - baselineTs) / (1000*60*60*24);
  // Only use if captured 7+ days before the target date
  return daysInAdvance >= 7 ? b : null;
}

async function getWorkingDays(clinic, prac, year, month) {
  try {
    const qs=`appointment_type_id=${prac.apptId}&business_id=${clinic.biz}&month=${month}&practitioner_ids=${prac.id}&time_zone=Sydney&year=${year}`;
    const data=await fetchJson(clinic.host,`/bookings/days?${qs}`);
    if(!Array.isArray(data)) return [];
    return data.map(item=>`${year}-${month}-${item.day}`);
  } catch(e) { return []; }
}

async function discoverWorkingDays(clinic, prac, allDates) {
  const monthGroups={};
  allDates.forEach(ds=>{ const[y,m]=ds.split('-').map(Number); monthGroups[`${y}-${m}`]={year:y,month:m}; });
  const results=await Promise.allSettled(Object.values(monthGroups).map(({year,month})=>getWorkingDays(clinic,prac,year,month)));
  const workingSet=new Set();
  results.forEach(r=>{ if(r.status==='fulfilled') r.value.forEach(d=>workingSet.add(d)); });
  return allDates.filter(d=>workingSet.has(d));
}

function detectNewPatientConsults(prevSlots, currSlots, prac) {
  if(!prac.initialApptSlots||!prevSlots||!currSlots) return {newPatients:0};
  const currSet=new Set(currSlots.map(s=>`${s.hour}:${s.minute}`));
  const missing=prevSlots.filter(s=>!currSet.has(`${s.hour}:${s.minute}`)).sort((a,b)=>(a.hour*60+a.minute)-(b.hour*60+b.minute));
  if(!missing.length) return {newPatients:0};
  const blocks=[];
  let block=[missing[0]];
  for(let i=1;i<missing.length;i++){
    const pm=missing[i-1], cm=missing[i];
    if((cm.hour*60+cm.minute)-(pm.hour*60+pm.minute)===prac.slotDuration) block.push(cm);
    else { blocks.push(block); block=[cm]; }
  }
  blocks.push(block);
  let newPatients=0;
  blocks.forEach(b=>{ if(b.length===prac.initialApptSlots) newPatients++; });
  return {newPatients};
}

function recordConsults(ts, clinicKey, pracId, day, newPatients) {
  if(!newPatients) return;
  const consults=loadConsults();
  const ws=getWeekDays(0)[0];
  if(!consults[ws]) consults[ws]={};
  if(!consults[ws][clinicKey]) consults[ws][clinicKey]={};
  if(!consults[ws][clinicKey][pracId]) consults[ws][clinicKey][pracId]={};
  if(!consults[ws][clinicKey][pracId][day]) consults[ws][clinicKey][pracId][day]=0;
  consults[ws][clinicKey][pracId][day]+=newPatients;
  saveConsults(consults);
  console.log(`  New patient consult: ${clinicKey}/${pracId} on ${day} (+${newPatients})`);
}

async function runBaselineScan() {
  const targetDate=getSydneyDateStr(56);
  const[ty,tm]=targetDate.split('-').map(Number);
  const ts=new Date().toISOString();
  console.log(`\n[BASELINE ${ts}] ${targetDate}`);
  const baselines=loadBaselines();
  if(!baselines[targetDate]) baselines[targetDate]={};
  const tasks=[];
  for(const clinic of CLINICS)
    for(const prac of clinic.pracs) {
      const wd=await getWorkingDays(clinic,prac,ty,tm);
      if(wd.includes(targetDate)) tasks.push({clinic,prac});
    }
  const settled=await Promise.allSettled(tasks.map(({clinic,prac})=>{
    const[y,m,d]=targetDate.split('-').map(Number);
    const qs=`appointment_type_id=${prac.apptId}&business_id=${clinic.biz}&date=${y}-${m}-${d}&facebook_page_id=&practitioner_ids=${prac.id}&reservation_key=&time_zone=Sydney`;
    return fetchJson(clinic.host,`/bookings/time_slots?${qs}`).then(slots=>({clinicKey:clinic.key,pracId:prac.id,slots:Array.isArray(slots)?slots:[],free:Array.isArray(slots)?slots.length:0}));
  }));
  settled.forEach((r,i)=>{
    if(r.status!=='fulfilled'||r.value.free===0) return;
    const{clinicKey,pracId,free,slots}=r.value;
    if(!baselines[targetDate][clinicKey]) baselines[targetDate][clinicKey]={};
    baselines[targetDate][clinicKey][pracId]={free,slots:slots.map(s=>({hour:s.hour,minute:s.minute})),ts};
    console.log(`  ${clinicKey}/${tasks[i].prac.short}: ${free} slots`);
  });
  saveBaselines(baselines);
  return baselines;
}

async function runScan() {
  const ts=new Date().toISOString();
  const baselines=loadBaselines();
  const sydney=getSydney();
  const nowMins=sydney.getHours()*60+sydney.getMinutes();
  const prevScan=loadPrevScan();
  const weeks=Array.from({length:5},(_,i)=>{ const days=getWeekDays(i); return{days,weekStart:days[0],weekEnd:days[6],weekLabel:fmtWeek(days),dayLabels:days.map(fmtDay),isCurrent:i===0,weekOffset:i}; });
  const allFutureDates=[...new Set(weeks.flatMap(w=>w.days).filter(d=>!isPast(d)))];
  const workingDayCache={};
  for(const clinic of CLINICS)
    for(const prac of clinic.pracs) {
      const wd=await discoverWorkingDays(clinic,prac,allFutureDates);
      workingDayCache[`${clinic.key}|${prac.id}`]=new Set(wd);
    }
  const allTasks=[];
  for(const week of weeks)
    for(const clinic of CLINICS)
      for(const prac of clinic.pracs) {
        const wd=workingDayCache[`${clinic.key}|${prac.id}`];
        for(const day of week.days)
          if(!isPast(day)&&wd&&wd.has(day)) allTasks.push({week,clinic,prac,day});
      }
  console.log(`\n[SCAN ${ts}] ${weeks[0].weekLabel} — ${allTasks.length} tasks`);
  const settled=await Promise.allSettled(allTasks.map(({clinic,prac,day})=>{
    const[y,m,d]=day.split('-').map(Number);
    const qs=`appointment_type_id=${prac.apptId}&business_id=${clinic.biz}&date=${y}-${m}-${d}&facebook_page_id=&practitioner_ids=${prac.id}&reservation_key=&time_zone=Sydney`;
    return fetchJson(clinic.host,`/bookings/time_slots?${qs}`).then(slots=>({clinicKey:clinic.key,pracId:prac.id,day,slots:Array.isArray(slots)?slots:[],free:Array.isArray(slots)?slots.length:null}));
  }));
  const idx={};
  settled.forEach((r,i)=>{ const t=allTasks[i]; idx[`${t.clinic.key}|${t.prac.id}|${t.day}`]=r.status==='fulfilled'?r.value:{free:null,slots:[],error:r.reason?.message}; });

  // New patient detection on today's dates
  if(prevScan) {
    for(const clinic of CLINICS)
      for(const prac of clinic.pracs) {
        if(!prac.initialApptSlots) continue;
        const today=todayStr();
        const curr=idx[`${clinic.key}|${prac.id}|${today}`];
        if(!curr||curr.free===null) continue;
        let prevSlots=null;
        if(prevScan.weeks) for(const w of prevScan.weeks) { const p=w.clinics?.[clinic.key]?.pracs?.[prac.id]; if(p?.days?.[today]?.slots){prevSlots=p.days[today].slots;break;} }
        if(prevSlots&&curr.slots) { const{newPatients}=detectNewPatientConsults(prevSlots,curr.slots,prac); if(newPatients>0) recordConsults(ts,clinic.key,prac.id,today,newPatients); }
      }
  }

  const weekSnapshots=weeks.map(week=>{
    const snap={weekStart:week.weekStart,weekEnd:week.weekEnd,weekLabel:week.weekLabel,dayLabels:week.dayLabels,isCurrent:week.isCurrent,weekOffset:week.weekOffset,clinics:{}};
    for(const clinic of CLINICS) {
      snap.clinics[clinic.key]={name:clinic.name,pracs:{}};
      for(const prac of clinic.pracs) {
        const wd=workingDayCache[`${clinic.key}|${prac.id}`];
        const dayData={};
        let wCap=0,wBooked=0;
        for(const day of week.days) {
          if(!isPast(day)&&(!wd||!wd.has(day))) { dayData[day]={cap:0,free:null,booked:null,occ:null,off:true}; continue; }
          if(isPast(day)) {
            const prev=getPrevDayData(prevScan,clinic.key,prac.id,day);
            if(prev&&prev.booked!==null) { dayData[day]={...prev,frozen:true}; wCap+=prev.cap||0; wBooked+=prev.booked; }
            else { dayData[day]={cap:0,free:null,booked:null,occ:null,frozen:true,off:true}; }
            continue;
          }
          const r=idx[`${clinic.key}|${prac.id}|${day}`];
          // Use baseline only if captured 7+ days before target date
          const baseline=getValidBaseline(baselines,day,clinic.key,prac.id);
          // Fallback cap from hardcoded schedule
          const fallback=prac.fallbackCap[getDow(day)]||0;
          if(!r||r.free===null) { dayData[day]={cap:fallback,free:null,booked:null,occ:null,error:true}; continue; }
          if(isToday(day)) {
            if(baseline&&baseline.slots&&baseline.slots.length>0) {
              const currSet=new Set(r.slots.map(s=>`${s.hour}:${s.minute}`));
              let booked=0,elapsedOpen=0;
              baseline.slots.forEach(s=>{ const sm=s.hour*60+s.minute; if(!currSet.has(`${s.hour}:${s.minute}`)){if(sm<=nowMins)elapsedOpen++;else booked++;} });
              const cap=baseline.slots.length;
              dayData[day]={cap,free:r.free,booked,elapsedOpen,occ:cap>0?Math.round((booked/cap)*100):0,today:true,slots:r.slots};
              wCap+=cap; wBooked+=booked;
            } else {
              const cap=fallback||r.free;
              const booked=Math.max(0,cap-r.free);
              dayData[day]={cap,free:r.free,booked,occ:cap>0?Math.round((booked/cap)*100):0,today:true,noBaseline:true,slots:r.slots};
              wCap+=cap; wBooked+=booked;
            }
            continue;
          }
          // Future day
          if(baseline&&baseline.free>0) {
            const booked=Math.max(0,baseline.free-r.free);
            dayData[day]={cap:baseline.free,free:r.free,booked,occ:Math.round((booked/baseline.free)*100)};
            wCap+=baseline.free; wBooked+=booked;
          } else {
            // No valid baseline — use fallback cap
            const cap=fallback||r.free||0;
            const booked=cap>0?Math.max(0,cap-r.free):0;
            dayData[day]={cap,free:r.free,booked,occ:cap>0?Math.round((booked/cap)*100):0,noBaseline:true};
            wCap+=cap; wBooked+=booked;
          }
        }
        const wOcc=wCap>0?Math.round((wBooked/wCap)*100):0;
        snap.clinics[clinic.key].pracs[prac.id]={name:prac.name,short:prac.short,role:prac.role,days:dayData,weekTotal:{cap:wCap,booked:wBooked,occ:wOcc}};
        if(wCap>0) process.stdout.write(`  ${week.isCurrent?'(now)':'(+'+week.weekOffset+'w)'} ${prac.short}: ${wBooked}/${wCap} = ${wOcc}%\n`);
      }
    }
    return snap;
  });

  const scanEntry={ts,currentWeekStart:weeks[0].weekStart,weeks:weekSnapshots};
  const data=loadData();
  data.scans.push(scanEntry);
  data.scans=pruneScans(data.scans);
  saveData(data);
  savePrevScan(scanEntry);
  console.log(`  Saved. Scans: ${data.scans.length}`);
  return scanEntry;
}

function getPrevDayData(prevScan,clinicKey,pracId,day) {
  if(!prevScan||!prevScan.weeks) return null;
  for(const week of prevScan.weeks) { const prac=week.clinics?.[clinicKey]?.pracs?.[pracId]; if(prac&&prac.days?.[day]) return prac.days[day]; }
  return null;
}

module.exports={runScan,runBaselineScan,loadData,loadBaselines,loadConsults,saveBaselines,CLINICS};
if(require.main===module){ const arg=process.argv[2]; if(arg==='baseline') runBaselineScan().catch(console.error); else runScan().catch(console.error); }
