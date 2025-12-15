// seed-wait-stats.js
// One-off script to seed EMA wait-time stats for all branches.

// OPTIONAL: load .env when running locally
try {
  require('dotenv').config();
} catch (_) {}

// ---------- Shared libs ----------
const admin = require('firebase-admin');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

// ---------- ENV + Firebase Admin (copied from staff server.js) ----------
let ENV = {
  PROJECT_ID:
    process.env.STAFF_FIREBASE_PROJECT_ID ||
    process.env.FIREBASE_PROJECT_ID,

  CLIENT_EMAIL:
    process.env.STAFF_FIREBASE_ADMIN_EMAIL ||
    process.env.FIREBASE_ADMIN_CLIENT_EMAIL ||
    process.env.FIREBASE_CLIENT_EMAIL,

  PRIVATE_KEY:
    process.env.STAFF_FIREBASE_ADMIN_KEY ||
    process.env.FIREBASE_ADMIN_PRIVATE_KEY ||
    process.env.FIREBASE_PRIVATE_KEY ||
    '',

  PRIVATE_KEY_B64:
    process.env.STAFF_FIREBASE_ADMIN_KEY_B64 ||
    process.env.FIREBASE_ADMIN_PRIVATE_KEY_B64 ||
    '',
};

for (const k of Object.keys(ENV)) {
  if (typeof ENV[k] === 'string') ENV[k] = ENV[k].trim();
}

function resolvePrivateKey() {
  if (ENV.PRIVATE_KEY_B64) {
    const decoded = Buffer.from(ENV.PRIVATE_KEY_B64, 'base64').toString('utf8');
    return decoded.trim();
  }
  if (ENV.PRIVATE_KEY) {
    let k = ENV.PRIVATE_KEY;
    if (
      (k.startsWith('"') && k.endsWith('"')) ||
      (k.startsWith("'") && k.endsWith("'"))
    ) {
      k = k.slice(1, -1);
    }
    k = k.replace(/\\n/g, '\n');
    return k.trim();
  }
  return '';
}

function initFirebase() {
  if (admin.apps.length) return;

  const pk = resolvePrivateKey();
  if (!ENV.PROJECT_ID || !ENV.CLIENT_EMAIL || !pk) {
    throw new Error('Missing Firebase Admin env values.');
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: ENV.PROJECT_ID,
      clientEmail: ENV.CLIENT_EMAIL,
      privateKey: pk,
    }),
  });

  console.log('[seed] Firebase connected to project:', ENV.PROJECT_ID);
}
initFirebase();

const db = admin.firestore();

// ---------- Same constants as staff-app stats logic ----------
const WAIT_TIME_MIN_CLAMP_MIN = 3;
const WAIT_TIME_MIN_CLAMP_MAX = 90;
const WAIT_TIME_EMA_ALPHA = 0.2;

const GROUPS = ['P', 'A', 'B', 'C'];
const BUCKETS = ['lunch', 'afternoon', 'dinner', 'late'];

// pax + traffic assumptions
const DAYS_BACK = 7;
const MIN_PAX_PER_DAY = 150;
const MAX_PAX_PER_DAY = 500;
const AVG_PAX_PER_TICKET = 2.5; // pax per ticket (approx)

// group distribution (rough, you can tweak)
const GROUP_WEIGHTS = {
  P: 0.06,
  A: 0.5,
  B: 0.32,
  C: 0.12,
};

// bucket distribution (rough, you can tweak)
const BUCKET_WEIGHTS = {
  lunch: 0.35,
  afternoon: 0.15,
  dinner: 0.4,
  late: 0.1,
};

// wait-time ranges per bucket (minutes) – moderate load
const BUCKET_WAIT_RANGES = {
  lunch: [8, 18],
  afternoon: [5, 12],
  dinner: [20, 35],
  late: [10, 20],
};

// ---------- Helpers ----------
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function weightedPick(weightMap) {
  const entries = Object.entries(weightMap);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  const r = Math.random() * total;
  let acc = 0;
  for (const [key, w] of entries) {
    acc += w;
    if (r <= acc) return key;
  }
  return entries[entries.length - 1][0]; // fallback
}

// ---------- Core EMA simulation ----------
async function seedBranch(branchId) {
  console.log('\n[seed] Branch:', branchId);

  // Load current stats for all group+bucket combos
  /** stats[g][b] = { emaWaitMin, sampleCount } */
  const stats = {};
  for (const g of GROUPS) {
    stats[g] = {};
    for (const b of BUCKETS) {
      const ref = db.doc(
        `queueStats/${branchId}/groups/${g}/buckets/${b}`,
      );
      const snap = await ref.get();
      if (snap.exists) {
        const d = snap.data() || {};
        const ema =
          typeof d.emaWaitMin === 'number' ? d.emaWaitMin : null;
        const count =
          typeof d.sampleCount === 'number' ? d.sampleCount : 0;
        stats[g][b] = {
          emaWaitMin: ema,
          sampleCount: count,
        };
      } else {
        stats[g][b] = {
          emaWaitMin: null,
          sampleCount: 0,
        };
      }
    }
  }

  let totalTickets = 0;

  // Simulate DAYS_BACK worth of days
  for (let d = 0; d < DAYS_BACK; d++) {
    const paxToday = randInt(MIN_PAX_PER_DAY, MAX_PAX_PER_DAY);
    const ticketsToday = Math.max(
      1,
      Math.round(paxToday / AVG_PAX_PER_TICKET),
    );
    totalTickets += ticketsToday;

    for (let i = 0; i < ticketsToday; i++) {
      const g = weightedPick(GROUP_WEIGHTS);
      const bucketId = weightedPick(BUCKET_WEIGHTS);
      const [minW, maxW] = BUCKET_WAIT_RANGES[bucketId];

      let waitMin = randFloat(minW, maxW);

      // clamp similar to staff logic
      waitMin = Math.max(
        WAIT_TIME_MIN_CLAMP_MIN,
        Math.min(WAIT_TIME_MIN_CLAMP_MAX, waitMin),
      );

      const stat = stats[g][bucketId];

      if (stat.sampleCount <= 0 || stat.emaWaitMin == null) {
        stat.emaWaitMin = waitMin;
      } else {
        stat.emaWaitMin =
          WAIT_TIME_EMA_ALPHA * waitMin +
          (1 - WAIT_TIME_EMA_ALPHA) * stat.emaWaitMin;
      }
      stat.sampleCount += 1;
    }
  }

  // Persist updated stats back to Firestore
  const batch = db.batch();
  for (const g of GROUPS) {
    for (const bucketId of BUCKETS) {
      const stat = stats[g][bucketId];
      const ref = db.doc(
        `queueStats/${branchId}/groups/${g}/buckets/${bucketId}`,
      );
      batch.set(
        ref,
        {
          branchCode: branchId,
          group: g,
          bucketId,
          emaWaitMin: stat.emaWaitMin,
          sampleCount: stat.sampleCount,
          updatedAt: admin.firestore.Timestamp.now(),
        },
        { merge: true },
      );
    }
  }

  await batch.commit();
  console.log(
    `[seed] Branch ${branchId}: simulated ~${totalTickets} tickets over ${DAYS_BACK} days.`,
  );
}

async function main() {
  try {
    console.log('[seed] Starting seeding for all branches…');

    const branchesSnap = await db.collection('branches').get();
    if (branchesSnap.empty) {
      console.error('[seed] No branches found in `branches` collection.');
      process.exit(1);
    }

    const branchIds = branchesSnap.docs.map((d) => d.id);
    console.log('[seed] Found branches:', branchIds.join(', '));

    for (const branchId of branchIds) {
      await seedBranch(branchId);
    }

    console.log('\n[seed] Done. You can now test guest ETA with richer stats.');
    process.exit(0);
  } catch (err) {
    console.error('[seed] ERROR:', err);
    process.exit(1);
  }
}

main();
