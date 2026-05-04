// scanner.js — Galston Area Clinic Occupancy Scanner
// - Mon–Sun (Sunday included, shows dash if no one works)
// - Current week + next 4 weeks
// - Runs 24/7 every 30 minutes via cron

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── CLINIC CONFIG ────────────────────────────────────────────────────────────
// cap: max bookable slots per day-of-week (0=Sun,1=Mon,...,6=Sat)
// Only define days the practitioner actually works — others auto-show as day off

const CLINICS = [
  {
    key:  'galston',
    name: 'Galston Health and Chiropractic',
    host: 'chiros-on-call.cliniko.com',
    biz:  '35543',
    pracs: [
      {
        id:    '52687',
        apptId:'146507',
        name:  'Dr Craig Hurter',
        short: 'Craig',
        role:  'Chiropractor',
        cap:   { 1:29, 2:29, 3:10, 4:31, 5:31, 6:18 }
        // Mon=29, Tue=29, Wed=10, Thu=31, Fri=31, Sat=18, Sun=off
      },
      {
        id:    '1923718951779436232',
        apptId:'146507',
        name:  'Dr Ayden Kahveci',
        short: 'Ayden',
        role:  'Chiropractor',
        cap:   { 4:26 }
        // Thu=26 only
      },
      {
        id:    '1210445304252335205',
        apptId:'1216972388525147145',
        name:  'Mrs Elizabeth Sherrington',
        short: 'Elizabeth',
        role:  'Massage Therapist',
        cap:   { 1:10, 2:10, 5:10 }
        // Mon=10, Tue=10, Fri=10
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
        id:    '53734',
        apptId:'150025',
        name:  'Dr Kirsty Reynolds',
        short: 'Kirsty',
        role:  'Chiropractor',
        cap:   { 2:14, 3:14, 5:14, 6:8 }
        // Tue=14, Wed=14, Fri=14, Sat=8
      }
    ]
  }
];

const DATA_FILE = path.join(__dirname, 'data', 'scans.json');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function fetchJson(host, urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        path:     urlPath,
        method:   'GET',
        headers:  { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      },
      res => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => {
          try { resolve(JSON.parse(b)); }
          catch(e) { reject(new Error('JSON parse error: ' + e.message)); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout: ' + host)); });
    req.end();
  });
}

const getDow = ds => {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d).getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
};

// Returns Mon–Sun (7 days) for a given week offset
// offset 0 = current week, 1 = next week, etc.
function getWeekDays(offsetWeeks) {
  const now    = new Date();
  // Approximate Sydney time (AEST UTC+10)
  const sydney = new Date(now.getTime() + (10 * 60 - now.getTimezoneOffset()) * 60000);
  const dow    = sydney.getDay(); // 0=Sun
  const mon    = new Date(sydney);
  mon.setDate(sydney.getDate() - (dow === 0 ? 6 : dow - 1) + (offsetWeeks * 7));
  mon.setHours(0, 0, 0, 0);
  // 7 days: Mon(0) through Sun(6)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  });
}

const fmtDay = ds => {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-AU', { weekday:'short', day:'numeric', month:'short' });
};
const fmtWeek = days => `${fmtDay(days[0])} \u2013 ${fmtDay(days[6])}`;

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE))
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) { console.error('loadData error:', e.message); }
  return { scans: [] };
}

function saveData(d) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

// ─── MAIN SCAN ───────────────────────────────────────────────────────────────

async function runScan() {
  const ts = new Date().toISOString();

  // Build 5 weeks of Mon-Sun date arrays
  const weeks = Array.from({ length: 5 }, (_, i) => {
    const days = getWeekDays(i);
    return {
      days,
      weekStart:  days[0],  // Monday
      weekEnd:    days[6],  // Sunday
      weekLabel:  fmtWeek(days),
      dayLabels:  days.map(fmtDay),
      isCurrent:  i === 0,
      weekOffset: i
    };
  });

  console.log(`\n[${ts}] Scanning 5 weeks (Mon-Sun):`);
  console.log(`  Week 0 (current): ${weeks[0].weekLabel}`);
  console.log(`  Week 4 (ahead):   ${weeks[4].weekLabel}`);

  // Build ALL fetch tasks across all 5 weeks in one flat list
  const allTasks = [];
  for (const week of weeks) {
    for (const clinic of CLINICS) {
      for (const prac of clinic.pracs) {
        for (const day of week.days) {
          const cap = prac.cap[getDow(day)] || 0;
          if (cap > 0) {
            allTasks.push({ week, clinic, prac, day, cap });
          }
          // Days with cap=0 (day off / Sunday) are skipped — shown as dashes
        }
      }
    }
  }

  console.log(`  Firing ${allTasks.length} requests in parallel...`);

  // Fire ALL requests simultaneously
  const settled = await Promise.allSettled(
    allTasks.map(({ clinic, prac, day, cap }) => {
      const [y, m, d] = day.split('-').map(Number);
      const qs = [
        `appointment_type_id=${prac.apptId}`,
        `business_id=${clinic.biz}`,
        `date=${y}-${m}-${d}`,
        `facebook_page_id=`,
        `practitioner_ids=${prac.id}`,
        `reservation_key=`,
        `time_zone=Sydney`
      ].join('&');
      return fetchJson(clinic.host, `/bookings/time_slots?${qs}`)
        .then(slots => ({
          clinicKey: clinic.key,
          pracId:    prac.id,
          day,
          cap,
          free: Array.isArray(slots) ? slots.length : null
        }));
    })
  );

  // Index results by "clinicKey|pracId|day"
  const idx = {};
  settled.forEach((r, i) => {
    const t   = allTasks[i];
    const key = `${t.clinic.key}|${t.prac.id}|${t.day}`;
    idx[key]  = r.status === 'fulfilled'
      ? r.value
      : { cap: t.cap, free: null, error: r.reason?.message };
  });

  // Assemble per-week snapshots
  const weekSnapshots = weeks.map(week => {
    const snap = {
      weekStart:  week.weekStart,
      weekEnd:    week.weekEnd,
      weekLabel:  week.weekLabel,
      dayLabels:  week.dayLabels,
      isCurrent:  week.isCurrent,
      weekOffset: week.weekOffset,
      clinics:    {}
    };

    for (const clinic of CLINICS) {
      snap.clinics[clinic.key] = { name: clinic.name, pracs: {} };

      for (const prac of clinic.pracs) {
        const dayData = {};
        let wCap = 0, wBooked = 0, wFree = 0;

        for (const day of week.days) {
          const cap = prac.cap[getDow(day)] || 0;

          if (!cap) {
            // Day off (including Sunday) — dash in dashboard
            dayData[day] = { cap: 0, free: null, booked: null, occ: null, off: true };
            continue;
          }

          const r = idx[`${clinic.key}|${prac.id}|${day}`];
          if (!r || r.free === null) {
            // Fetch failed
            dayData[day] = { cap, free: null, booked: null, occ: null, error: true };
            continue;
          }

          const booked = Math.max(0, cap - r.free);
          const occ    = Math.round((booked / cap) * 100);
          dayData[day] = { cap, free: r.free, booked, occ };
          wCap   += cap;
          wFree  += r.free;
          wBooked += booked;
        }

        const wOcc = wCap > 0 ? Math.round((wBooked / wCap) * 100) : 0;
        snap.clinics[clinic.key].pracs[prac.id] = {
          name:  prac.name,
          short: prac.short,
          role:  prac.role,
          days:  dayData,
          weekTotal: { cap: wCap, free: wFree, booked: wBooked, occ: wOcc }
        };
      }
    }

    // Log summary line per week
    const label = week.isCurrent ? '(current)' : `(+${week.weekOffset}w)`;
    for (const [ck, clinic] of Object.entries(snap.clinics)) {
      for (const prac of Object.values(clinic.pracs)) {
        if (prac.weekTotal.cap > 0) {
          process.stdout.write(`  ${label} ${prac.short}: ${prac.weekTotal.booked}/${prac.weekTotal.cap} = ${prac.weekTotal.occ}%\n`);
        }
      }
    }

    return snap;
  });

  // Save scan entry
  const scanEntry = {
    ts,
    currentWeekStart: weeks[0].weekStart,
    weeks: weekSnapshots
  };

  const data = loadData();
  data.scans.push(scanEntry);
  // Keep last 2000 scans (~6 weeks of 30-min scans)
  if (data.scans.length > 2000) data.scans = data.scans.slice(-2000);
  saveData(data);

  console.log(`  ✓ Saved. Total scans stored: ${data.scans.length}`);
  return scanEntry;
}

module.exports = { runScan, loadData, CLINICS };
if (require.main === module) runScan().catch(console.error);
