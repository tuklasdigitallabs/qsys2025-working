/* OG QSys - Guest Registration App
 * Features: Priority Group P + Timestamps + Debug Logs
 * Firestore:
 *   queues/{branchCode}/{yyyy-mm-dd}/{group}/items/{queueId}
 *   counters at: queues/{branchCode}/{date}/{group}/meta/counter
 *
 * Admin Aggregates (single Firebase project):
 *   adminDailyStats/{YYYY-MM-DD__BRANCHCODE}
 *     - totals.reserved / seated / skipped
 *     - waitingNow {P,A,B,C}
 *     - events subcollection for idempotency
 */

console.log("🚨 server.js executing!");
console.log("  • __filename:", __filename);
console.log("  • process.cwd():", process.cwd());

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const admin = require('firebase-admin');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

// --- ensure fetch exists on Node < 18 (cPanel often uses 16) ---
let _fetch = global.fetch;
if (!_fetch) {
  _fetch = (...args) => import('node-fetch').then(m => m.default(...args));
}
const fetch = (...args) => _fetch(...args);

const firebaseClientConfig = {
  apiKey: process.env.FIREBASE_WEB_API_KEY || process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  appId: process.env.FIREBASE_APP_ID || undefined
};

// ---- Env config (from cPanel Node.js Environment Variables) ----
const DEFAULT_TZ = process.env.QUEUE_TIMEZONE || 'Asia/Manila';
const DEFAULT_BRANCH_CODE = (process.env.DEFAULT_BRANCH_CODE || 'YL-MOA').toUpperCase();
const NUMBER_WIDTH = parseInt(process.env.QUEUE_NUMBER_WIDTH || '2', 10);
const STAFF_BASE_URL = process.env.STAFF_BASE_URL || 'https://staff.onegourmetph.com';

// ---- ETA / wait-time config ----
// Fallback per-ticket averages (minutes) when we don't have enough historical data yet.
const DEFAULT_AVG_MIN_PER_TICKET = {
  P: 10,
  A: 15,
  B: 20,
  C: 25
};

// How many samples we want in a bucket before trusting its EMA
const MIN_SAMPLES_FOR_BUCKET = 10;

/**
 * Map a Manila timestamp (ms) to a time-of-day bucket.
 * lunch     → 10:00–14:00
 * afternoon → 14:00–17:00
 * dinner    → 17:00–21:00
 * late      → 21:00–closing
 *
 * Anything before 10:00 we treat as "lunch".
 */
function getTimeBucketForMillis(ms) {
  const d = dayjs(ms).tz(DEFAULT_TZ);
  const totalMin = d.hour() * 60 + d.minute();

  // 10:00 = 600, 14:00 = 840, 17:00 = 1020, 21:00 = 1260
  if (totalMin < 600) return 'lunch';        // before 10:00
  if (totalMin < 840) return 'lunch';        // 10:00–13:59
  if (totalMin < 1020) return 'afternoon';   // 14:00–16:59
  if (totalMin < 1260) return 'dinner';      // 17:00–20:59
  return 'late';                             // 21:00+
}

/**
 * Try to get the registration timestamp (ms) from a ticket document.
 * Uses Firestore Timestamp in `timestamp` if present, otherwise parses `createdAt`.
 */
function getTicketCreatedMs(ticket) {
  if (!ticket) return null;

  if (ticket.timestamp && typeof ticket.timestamp.toMillis === 'function') {
    return ticket.timestamp.toMillis();
  }

  if (ticket.createdAt) {
    // Expect "YYYY-MM-DD HH:mm:ss" in DEFAULT_TZ (e.g. Asia/Manila)
    const parsed = new Date(String(ticket.createdAt).replace(' ', 'T') + '+08:00');
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.getTime();
    }
  }

  return null;
}

/**
 * Get the *per-ticket* average wait (minutes) for this branch+group+time-bucket,
 * using the EMA maintained by the staff app. Falls back to DEFAULT_AVG_MIN_PER_TICKET.
 */
async function getAvgWaitMinutes(branchCode, group, ticket) {
  const fallback = DEFAULT_AVG_MIN_PER_TICKET[group] || 15;

  const createdMs = getTicketCreatedMs(ticket);
  if (!createdMs) {
    console.warn('[ETA] no createdMs for ticket, using fallback avg');
    return fallback;
  }

  const bucketId = getTimeBucketForMillis(createdMs);
  const statsRef = db.doc(
    `queueStats/${branchCode}/groups/${group}/buckets/${bucketId}`
  );

  try {
    const snap = await statsRef.get();

    console.log(
      '[ETA DEBUG] bucketDoc =',
      snap.exists ? snap.data() : 'NO DOC',
      '| path =',
      statsRef.path
    );

    if (!snap.exists) {
      console.log('[ETA] no stats doc yet for bucket', { branchCode, group, bucketId });
      return fallback;
    }

    const data  = snap.data() || {};
    const ema   = typeof data.emaWaitMin === 'number' ? data.emaWaitMin : null;
    const count = typeof data.sampleCount === 'number' ? data.sampleCount : 0;

    if (ema == null || count < MIN_SAMPLES_FOR_BUCKET) {
      console.log('[ETA] insufficient stats, using fallback', { ema, count, fallback });
      return fallback;
    }

    console.log('[ETA] using EMA from stats', { branchCode, group, bucketId, ema, count });
    return ema;
  } catch (e) {
    console.warn('[ETA] error reading stats doc:', e.message);
    return fallback;
  }
}

// ---- Express app ----
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(morgan('dev'));

// Extra request logger so we see every hit
app.use((req, _res, next) => { console.log(`[REQ] ${req.method} ${req.originalUrl}`); next(); });

// Static & views
app.use('/public', express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---- Firebase Admin init (ENV-only, cPanel-safe) ----
let INIT_ERROR = null;
function resolvePrivateKey() {
  // Prefer Base64 for safety in cPanel
  if (process.env.FIREBASE_ADMIN_PRIVATE_KEY_B64) {
    return Buffer.from(process.env.FIREBASE_ADMIN_PRIVATE_KEY_B64, 'base64').toString('utf8');
  }
  // Or one-line key with \n escapes
  if (process.env.FIREBASE_ADMIN_PRIVATE_KEY) {
    return process.env.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, '\n');
  }
  return null;
}

function initFirebaseAdmin() {
  if (admin.apps.length) return;
  const privateKey = resolvePrivateKey();
  const clientEmail =
    process.env.FIREBASE_ADMIN_CLIENT_EMAIL || process.env.FIREBASE_CLIENT_EMAIL;
  const projectId =
    process.env.FIREBASE_PROJECT_ID || process.env.GUEST_FIREBASE_PROJECT_ID;

  if (!privateKey || !clientEmail || !projectId) {
    throw new Error(
      'Missing Firebase Admin ENV. Need FIREBASE_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL, and ' +
      'either FIREBASE_ADMIN_PRIVATE_KEY (with \\n) or FIREBASE_ADMIN_PRIVATE_KEY_B64.'
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey })
  });
  console.log('[Firebase] Admin initialized for project:', projectId);
}

try { initFirebaseAdmin(); } catch (e) { INIT_ERROR = e.message; console.error('[Firebase] init error:', e.message); }

let db = null;
try { db = admin.firestore(); } catch (e) { INIT_ERROR = INIT_ERROR || e.message; }

// If Firebase failed to init, short-circuit requests with a clear message
app.use((req, res, next) => {
  if (!db) return res.status(500).send('Server initialization error: ' + (INIT_ERROR || 'Unknown'));
  next();
});

// --- Config helpers ---
function formatQueueCode(group, n) {
  const padded = n.toString().padStart(NUMBER_WIDTH, '0');
  return `${group}${padded}`;
}
function pathRefs(branchCode, group, dateStr) {
  const date = dateStr || dayjs().tz(DEFAULT_TZ).format('YYYY-MM-DD');
  const base = db.collection('queues').doc(branchCode).collection(date).doc(group);
  const meta = base.collection('meta').doc('counter');
  const items = base.collection('items');
  return { base, meta, items, date };
}

// ---------- Branch helpers (canonicalize code + fetch name) ----------
function normalizeBranchFromSnap(snap) {
  const d = snap.data() || {};
  return {
    code: d.branchCode || d.code || snap.id,              // canonical code
    name: d.branchName || d.name || (d.code || snap.id),  // human name
    slug: (d.slug || (d.code || snap.id).toLowerCase())
  };
}

/**
 * Resolve any incoming param (slug like "moa" OR code like "YL-MOA")
 * to the canonical branchCode + branchName from Firestore.
 */
async function resolveBranch(param) {
  const pRaw = String(param || '').trim();
  const pSlug = pRaw.toLowerCase();
  const pCode = pRaw.toUpperCase();

  // 1) Exact doc id (raw then upper)
  let snap = await db.doc(`branches/${pRaw}`).get();
  if (snap.exists) return normalizeBranchFromSnap(snap);

  if (pCode !== pRaw) {
    snap = await db.doc(`branches/${pCode}`).get();
    if (snap.exists) return normalizeBranchFromSnap(snap);
  }

  // 2) slug field
  let q = await db.collection('branches').where('slug', '==', pSlug).limit(1).get();
  if (!q.empty) return normalizeBranchFromSnap(q.docs[0]);

  // 3) branchCode/code fields
  q = await db.collection('branches').where('branchCode', '==', pCode).limit(1).get();
  if (!q.empty) return normalizeBranchFromSnap(q.docs[0]);

  q = await db.collection('branches').where('code', '==', pCode).limit(1).get();
  if (!q.empty) return normalizeBranchFromSnap(q.docs[0]);

  // 4) Fallback to default
  const fbSnap = await db.doc(`branches/${DEFAULT_BRANCH_CODE}`).get();
  if (fbSnap.exists) return normalizeBranchFromSnap(fbSnap);

  throw new Error(`Unknown branch "${param}"`);
}

// ---------- Queue helpers ----------
function groupFromPax(pax, priority) {
  console.log(`[DEBUG] groupFromPax(): pax=${pax}, priority=${priority}`);
  // ✅ Priority guests always go to group P
  if (priority === 'senior' || priority === 'pwd') {
    console.log('[DEBUG] → Priority detected → group P');
    return 'P';
  }
  if (pax <= 2) return 'A';
  if (pax <= 4) return 'B';
  return 'C';
}

// ============================================================
// ADMIN DAILY AGGREGATES (single Firebase project)
// - adminDailyStats/{YYYY-MM-DD__BRANCHCODE}
// - idempotent increments via subcollection events/{action}__{ticketId}
// ============================================================

function adminStatsDocId(dateKey, branchCode) {
  return `${dateKey}__${branchCode}`;
}

async function computeWaitingNow(branchCode, dateKey) {
  const GROUPS = ['P', 'A', 'B', 'C'];
  const waitingNow = { P: 0, A: 0, B: 0, C: 0 };

  for (const g of GROUPS) {
    const col = db.collection(`queues/${branchCode}/${dateKey}/${g}/items`);
    const q = col.where('status', 'in', ['waiting', 'called']);

    // Prefer aggregation count() if supported; fallback to fetching docs
    try {
      const agg = await q.count().get();
      waitingNow[g] = Number(agg.data().count || 0);
    } catch {
      const snap = await q.get();
      waitingNow[g] = snap.size;
    }
  }
  return waitingNow;
}

async function recordAdminStatEvent({ branchCode, dateKey, action, ticketId, branchName }) {
  try {
    const statsId = adminStatsDocId(dateKey, branchCode);
    const statsRef = db.collection('adminDailyStats').doc(statsId);
    const eventRef = statsRef.collection('events').doc(`${action}__${ticketId}`);

    const inc = admin.firestore.FieldValue.increment;
    const incPayload =
      action === 'reserved' ? { 'totals.reserved': inc(1) } :
      action === 'seated' ? { 'totals.seated': inc(1) } :
      action === 'skipped' ? { 'totals.skipped': inc(1) } :
      null;

    await db.runTransaction(async (tx) => {
      const ev = await tx.get(eventRef);
      if (ev.exists) return; // already counted

      tx.set(eventRef, {
        action,
        ticketId,
        branchCode,
        dateKey,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      tx.set(statsRef, {
        dateKey,
        branchCode,
        branchName: branchName || branchCode,
        totals: { reserved: 0, seated: 0, skipped: 0 },
        waitingNow: { P: 0, A: 0, B: 0, C: 0 },
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      if (incPayload) tx.set(statsRef, incPayload, { merge: true });
      tx.set(statsRef, { updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
  } catch (e) {
    console.warn('[adminStats] recordAdminStatEvent error:', e.message);
  }
}

async function updateAdminWaitingNowSnapshot(branchCode, dateKey, branchName) {
  try {
    const waitingNow = await computeWaitingNow(branchCode, dateKey);
    const statsId = adminStatsDocId(dateKey, branchCode);

    await db.collection('adminDailyStats').doc(statsId).set({
      dateKey,
      branchCode,
      branchName: branchName || branchCode,
      waitingNow,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) {
    console.warn('[adminStats] updateAdminWaitingNowSnapshot error:', e.message);
  }
}

// ---------- Quick debug endpoints ----------
app.get('/__whoami', (req, res) => {
  res.json({ ok: true, filename: __filename, cwd: process.cwd(), tz: DEFAULT_TZ, initError: INIT_ERROR || null });
});
app.all('/__echo', (req, res) => res.json({ method: req.method, headers: req.headers, query: req.query, body: req.body }));

// ---------- Routes ----------
app.get(['/', '/register/:branchParam?'], async (req, res) => {
  try {
    const incoming = req.params.branchParam || DEFAULT_BRANCH_CODE;
    const branch = await resolveBranch(incoming);
    res.render('register', { branch, form: {}, error: null });
  } catch (e) {
    console.error('[GET /register] resolve error:', e.message);
    res.status(404).send('Unknown branch.');
  }
});

app.post('/register/:branchParam', async (req, res) => {
  try {
    console.log('[DEBUG] Incoming body:', req.body);

    const branch = await resolveBranch(req.params.branchParam); // canonicalize first!
    let { name, pax, phone, priority } = req.body;

    // Normalize priority safely
    priority = (priority || 'none').toLowerCase().trim();
    console.log('[DEBUG] Normalized priority =', `"${priority}"`);

    // Validation
    if (!name || !pax) {
      console.log('[DEBUG] Missing required fields → name/pax');
      return res
        .status(400)
        .render('register', { branch, error: 'Please fill in all required fields.', form: { name, pax, phone, priority } });
    }
    const paxNum = parseInt(pax, 10);
    console.log('[DEBUG] Parsed paxNum =', paxNum);
    if (isNaN(paxNum) || paxNum < 1) {
      console.log('[DEBUG] Invalid pax number');
      return res
        .status(400)
        .render('register', { branch, error: 'Number of guests must be a positive number.', form: { name, pax, phone, priority } });
    }

    // ✅ Priority overrides pax logic
    const group = groupFromPax(paxNum, priority);
    console.log('[DEBUG] Computed group =', group);

    const { meta, items, date } = pathRefs(branch.code, group);
    console.log(`[DEBUG] Firestore path → queues/${branch.code}/${date}/${group}/items/...`);

    let queueNumber, ticketId;

    await db.runTransaction(async (tx) => {
      const metaSnap = await tx.get(meta);
      const current = metaSnap.exists ? metaSnap.get('current') || 0 : 0;
      const next = current + 1;
      const code = formatQueueCode(group, next);
      console.log('[DEBUG] Next queue code =', code);

      tx.set(
        meta,
        {
          current: next,
          branchCode: branch.code,
          group,
          date,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      const now = dayjs().tz(DEFAULT_TZ);
      const newDocRef = items.doc();

      tx.set(newDocRef, {
        code,
        branchCode: branch.code,     // canonical
        branchName: branch.name,     // human readable
        group,
        number: next,
        name: name.trim(),
        pax: paxNum,
        phone: (phone || '').trim(),
        priority,                    // "none" | "senior" | "pwd"
        status: 'waiting',
        timestamp: admin.firestore.FieldValue.serverTimestamp(), // server time
        createdAt: now.format('YYYY-MM-DD HH:mm:ss'),            // local readable time
        date
      });

      queueNumber = next;
      ticketId = newDocRef.id;
    });

    // --- Admin aggregates: reserved + waitingNow snapshot (fire-and-forget) ---
    recordAdminStatEvent({
      branchCode: branch.code,
      dateKey: date,
      action: 'reserved',
      ticketId,
      branchName: branch.name
    }).catch(e => console.warn('[adminStats] reserved error:', e.message));

    updateAdminWaitingNowSnapshot(branch.code, date, branch.name)
      .catch(e => console.warn('[adminStats] waitingNow post-register error:', e.message));

    console.log(`[DEBUG] Redirect → /ticket/${branch.code}/${date}/${group}/${ticketId}`);
    res.redirect(`/ticket/${branch.code}/${date}/${group}/${ticketId}`);
  } catch (err) {
    console.error('[POST /register] error:', err);
    res.status(500).send('Something went wrong. Please try again.');
  }
});

// ---------- ETA based on queueStats (from staff seating data) ----------
const DEFAULT_AVG_WAIT_MIN = parseFloat(process.env.DEFAULT_AVG_WAIT_MIN || '15');
const MIN_STATS_SAMPLE = parseInt(process.env.MIN_STATS_SAMPLE || '5', 10);

// Use current Manila time to decide bucket
function getTimeBucketForNow() {
  const d = dayjs().tz(DEFAULT_TZ);
  const totalMin = d.hour() * 60 + d.minute();

  // 10:00 = 600, 14:00 = 840, 17:00 = 1020, 21:00 = 1260
  if (totalMin < 600) return 'lunch';        // before 10:00, treat as lunch
  if (totalMin < 840) return 'lunch';        // 10:00–13:59
  if (totalMin < 1020) return 'afternoon';   // 14:00–16:59
  if (totalMin < 1260) return 'dinner';      // 17:00–20:59
  return 'late';                             // 21:00+
}

/**
 * Compute ETA minutes for this ticket position, using:
 *   queueStats/{branchCode}/groups/{group}/buckets/{bucketId}
 * If no good stats yet → fallback to DEFAULT_AVG_WAIT_MIN.
 */
async function getEtaMinutes(branchCode, group, positionInGroup) {
  let perGuest = DEFAULT_AVG_WAIT_MIN;

  try {
    const bucketId = getTimeBucketForNow();
    const statsRef = db.doc(
      `queueStats/${branchCode}/groups/${group}/buckets/${bucketId}`
    );
    const snap = await statsRef.get();

    if (snap.exists) {
      const d = snap.data() || {};
      if (
        typeof d.emaWaitMin === 'number' &&
        typeof d.sampleCount === 'number' &&
        d.sampleCount >= MIN_STATS_SAMPLE
      ) {
        perGuest = d.emaWaitMin;
      }
    }
  } catch (e) {
    console.warn('[ETA] getEtaMinutes fallback, using default:', e.message);
  }

  const n = Math.max(1, positionInGroup || 1);
  const eta = Math.round(perGuest * n);
  console.log('[ETA] branch/group/pos =', branchCode, group, positionInGroup, '→', eta, 'min');
  return eta;
}

async function computeTicketStatus(branchCode, date, group, id) {
  const { items } = pathRefs(branchCode, group, date);

  // 1) Load THIS ticket
  const snap = await items.doc(id).get();
  if (!snap.exists) {
    throw new Error('TICKET_NOT_FOUND');
  }
  const ticket = snap.data();

  // 2) Compute position + total from this group's items
  const groupListSnap = await items.orderBy('number', 'asc').get();

  let pos = 0;
  let total = 0;

  groupListSnap.forEach(doc => {
    const d = doc.data() || {};
    const statusRaw = d.status || d.state || d.queueStatus || '';
    const status    = String(statusRaw).toLowerCase();

    console.log('[computeTicketStatus] row', {
      id: doc.id,
      code: d.code,
      statusRaw,
      status,
    });

    const isFinished =
      status === 'done' ||
      status === 'finished' ||
      status === 'complete' ||
      status === 'completed' ||
      status === 'skipped' ||
      status === 'cancelled' ||
      status === 'canceled';

    const isActive = !isFinished;

    if (isActive) {
      total++;
      if (doc.id === id) {
        pos = total;
      }
    }
  });

  if (!pos) pos = total || 1;

  // 3) Ask the staff app what is currently being served (cache-busted)
  let nowServingCode = null;
  try {
    const baseUrl =
      process.env.STAFF_DISPLAY_JSON_URL ||
      `https://staff.onegourmetph.com/display/${branchCode}/json`;

    // Add timestamp to bust any proxy / CDN cache
    const staffUrl = `${baseUrl}?t=${Date.now()}`;

    console.log('[computeTicketStatus] fetching display JSON from', staffUrl);

    const resp = await fetch(staffUrl, {
      // extra paranoia: disable HTTP-level caching
      headers: { 'Cache-Control': 'no-cache' }
    });

    if (resp.ok) {
      const json = await resp.json();
      const groupSlice = json[group] || null;

      console.log('[computeTicketStatus] display group slice:', group, groupSlice);

      if (
        groupSlice &&
        groupSlice.called &&
        groupSlice.called.code
      ) {
        nowServingCode = groupSlice.called.code;
      }
    } else {
      console.warn('[computeTicketStatus] display fetch status', resp.status);
    }
  } catch (e) {
    console.warn('[computeTicketStatus] display fetch error:', e.message);
  }

  // 4) ETA calculation using historical EMA per bucket + group
  const avgPerTicket = await getAvgWaitMinutes(branchCode, group, ticket);
  const etaMinutes   = pos * avgPerTicket;

  console.log(
    '[computeTicketStatus] branch/date/group/id =',
    branchCode, date, group, id
  );
  console.log(
    '[computeTicketStatus] pos/total =',
    pos, total
  );
  console.log(
    '[computeTicketStatus] avgPerTicket/etaMinutes =',
    avgPerTicket, etaMinutes
  );
  console.log(
    '[computeTicketStatus] nowServingCode =',
    nowServingCode
  );

  return {
    ticket,
    positionInGroup: pos,
    totalInGroup: total,
    etaMinutes,
    nowServingCode,
  };
}

app.get('/ticket/:branchCode/:date/:group/:id', async (req, res) => {
  const { branchCode, date, group, id } = req.params;
  try {
    const { items } = pathRefs(branchCode, group, date);
    const snap = await items.doc(id).get();
    if (!snap.exists) return res.status(404).send('Ticket not found.');
    const data = snap.data();
    console.log('[DEBUG] Ticket data loaded:', data);

    res.render('ticket', {
      ticket: data,
      ticketMeta: { branchCode, date, group, id },
      firebaseClientConfig   // ← now actually defined
    });

  } catch (e) {
    console.error('[GET /ticket] error:', e);
    res.status(500).send('Error retrieving ticket.');
  }
});

app.get('/api/ticket-status/:branchCode/:date/:group/:id', async (req, res) => {
  const { branchCode, date, group, id } = req.params;

  try {
    const status = await computeTicketStatus(branchCode, date, group, id);
    return res.json({
      ok: true,
      positionInGroup: status.positionInGroup,
      totalInGroup: status.totalInGroup,
      etaMinutes: status.etaMinutes,
      nowServingCode: status.nowServingCode
    });
  } catch (e) {
    console.error('[GET /api/ticket-status] error:', e);
    if (e.message === 'TICKET_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'Ticket not found' });
    }
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true, initError: INIT_ERROR || null }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Guest app listening on http://localhost:${PORT}`);
});
