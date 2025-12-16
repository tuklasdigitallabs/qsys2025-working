// QSys Staff-App (Standalone, JS version)
// Express + EJS + Firebase Admin (ENV-only, cPanel-ready)
// FINAL VERSION — PART 1 OF 4

const express = require('express');
const path = require('path');
const session = require('express-session');
const fs = require('fs');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

// --- ensure fetch exists (cPanel often uses Node <= 16) ---
let _fetch = global.fetch;
if (!_fetch) {
  _fetch = (...args) => import('node-fetch').then(m => m.default(...args));
}
const fetch = (...args) => _fetch(...args);

// ---------------- ENV + Firebase Admin ----------------
const admin = require('firebase-admin');

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

  WEB_API_KEY:
    process.env.STAFF_FIREBASE_API_KEY ||
    process.env.FIREBASE_WEB_API_KEY ||
    process.env.FIREBASE_API_KEY,

  AUTH_DOMAIN:
    process.env.STAFF_FIREBASE_AUTH_DOMAIN ||
    process.env.FIREBASE_AUTH_DOMAIN,

  APP_ID:
    process.env.STAFF_FIREBASE_APP_ID ||
    process.env.FIREBASE_APP_ID,

  SESSION_SECRET: process.env.SESSION_SECRET || 'change_me',
  QUEUE_NUMBER_WIDTH: process.env.QUEUE_NUMBER_WIDTH || '2',
  BRANCH_NAME_MAP: process.env.BRANCH_NAME_MAP || '{}',
};

// Sanitize
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
    if ((k.startsWith('"') && k.endsWith('"')) ||
        (k.startsWith("'") && k.endsWith("'"))) {
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
      privateKey: pk
    })
  });

  console.log('[Firebase] Staff connected to project:', ENV.PROJECT_ID);
}
initFirebase();

const db = admin.firestore();

// ---------------- Express App ----------------
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use('/public_css', express.static(path.join(__dirname, 'public_css')));
app.use('/public_js',
  express.static(path.join(__dirname, 'public_js'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
  })
);
app.use('/public_media', express.static(path.join(__dirname, 'public_media')));
// Alias /media/* → same folder as /public_media/*
app.use('/media', express.static(path.join(__dirname, 'public_media')));

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Force HTTPS option
if (process.env.FORCE_HTTPS === '1') {
  app.use((req, res, next) => {
    const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (proto && proto !== 'https') {
      return res.redirect(307, 'https://' + req.headers.host + req.originalUrl);
    }
    next();
  });
}

// ---------------- Session Handling ----------------
app.set('trust proxy', 1);
const isProd = process.env.NODE_ENV === 'production';
const cookieDomain = process.env.SESSION_COOKIE_DOMAIN || undefined;

app.use(session({
  name: 'staff.sid',
  secret: ENV.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: 'auto',
    sameSite: 'lax',
    domain: cookieDomain
  }
}));

// localhost session override
if (!isProd) {
  app.use((req, _res, next) => {
    req.session.cookie.secure = false;
    req.session.cookie.domain = undefined;
    next();
  });
}

// Remove legacy cookies
app.use((req, res, next) => {
  if ((req.headers.cookie || '').includes('connect.sid=')) {
    res.clearCookie('connect.sid', { path: '/' });
    res.clearCookie('connect.sid', { path: '/', domain: '.onegourmetph.com' });
  }

  if (!req.session.__primed) {
    req.session.__primed = true;
    return req.session.save(() => next());
  }
  next();
});

app.get('/__clear-cookies', (req, res) => {
  res.clearCookie('connect.sid', { path: '/' });
  res.clearCookie('connect.sid', { path: '/', domain: '.onegourmetph.com' });
  res.clearCookie('staff.sid', { path: '/' });
  res.send('cleared');
});

// ---------------- Utility ----------------
function manilaDayKey() {
  return dayjs().tz('Asia/Manila').format('YYYY-MM-DD');
}

const BRANCH_NAME_MAP = (() => {
  try { return JSON.parse(ENV.BRANCH_NAME_MAP); }
  catch { return {}; }
})();

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
      action === 'seated' ? { 'totals.seated': inc(1) } :
      action === 'skipped' ? { 'totals.skipped': inc(1) } :
      action === 'reserved' ? { 'totals.reserved': inc(1) } :
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

// -------- Wait-time ETA config (staff app) --------
const WAIT_TIME_MIN_CLAMP_MIN = 3;   // minimum minutes considered (to kill tiny noise)
const WAIT_TIME_MIN_CLAMP_MAX = 90;  // maximum minutes considered (kill crazy outliers)
const WAIT_TIME_EMA_ALPHA     = 0.2; // 0.2 ≈ gives more weight to last ~5 samples

/**
 * Map a Manila timestamp (ms) to a time-of-day bucket.
 * lunch     → 10:00–14:00
 * afternoon → 14:00–17:00
 * dinner    → 17:00–21:00
 * late      → 21:00–closing
 *
 * Anything before 10:00 we treat as "lunch" for simplicity.
 */
function getTimeBucketForMillis(ms) {
  const d = dayjs(ms).tz('Asia/Manila');
  const totalMin = d.hour() * 60 + d.minute();

  // 10:00 = 600, 14:00 = 840, 17:00 = 1020, 21:00 = 1260
  if (totalMin < 600) return 'lunch';        // before 10:00, treat as lunch
  if (totalMin < 840) return 'lunch';        // 10:00–13:59
  if (totalMin < 1020) return 'afternoon';   // 14:00–16:59
  if (totalMin < 1260) return 'dinner';      // 17:00–20:59
  return 'late';                             // 21:00+
}

/**
 * Add wait-time stats based on SEATED time.
 * Wait time = seatedAt - registeredAt (ticket.timestamp or createdAt).
 *
 * Aggregated per:
 *   queueStats/{branchCode}/groups/{group}/buckets/{bucketId}
 *
 * Each bucket doc stores an EMA:
 *   emaWaitMin   – exponential moving average of wait (minutes)
 *   sampleCount  – number of samples used
 *   updatedAt    – last update timestamp
 */
async function addSeatWaitStat(branchCode, group, ticketData, seatedAtTs) {
  try {
    const createdTs = ticketData.timestamp;
    let createdMs = null;

    if (createdTs && typeof createdTs.toMillis === 'function') {
      createdMs = createdTs.toMillis();
    } else if (ticketData.createdAt) {
      // Fallback parse "YYYY-MM-DD HH:mm:ss" as Manila time
      const parsed = new Date(ticketData.createdAt.replace(' ', 'T') + '+08:00');
      if (!Number.isNaN(parsed.getTime())) {
        createdMs = parsed.getTime();
      }
    }

    if (!createdMs) {
      console.warn('[stats] missing created timestamp for seat wait calc');
      return;
    }

    const seatedMs = seatedAtTs.toMillis();
    if (!Number.isFinite(seatedMs) || seatedMs <= createdMs) {
      console.warn('[stats] invalid seated/created timestamps', { createdMs, seatedMs });
      return;
    }

    // Raw wait in minutes
    let waitMin = (seatedMs - createdMs) / 60000;

    // Clamp to kill insane outliers and tiny noise
    if (!Number.isFinite(waitMin)) {
      console.warn('[stats] non-finite waitMin, skipping');
      return;
    }
    waitMin = Math.max(
      WAIT_TIME_MIN_CLAMP_MIN,
      Math.min(WAIT_TIME_MIN_CLAMP_MAX, waitMin)
    );

    // Determine time-of-day bucket from registration time
    const bucketId = getTimeBucketForMillis(createdMs);

    const statsRef = db.doc(
      `queueStats/${branchCode}/groups/${group}/buckets/${bucketId}`
    );

    const snap = await statsRef.get();
    const prev = snap.exists ? (snap.data() || {}) : {};

    const prevEma   = typeof prev.emaWaitMin === 'number' ? prev.emaWaitMin : null;
    const prevCount = typeof prev.sampleCount === 'number' ? prev.sampleCount : 0;

    let newEma;
    if (prevEma == null || prevCount <= 0) {
      // First sample: EMA = this wait time
      newEma = waitMin;
    } else {
      // EMA_new = α * x + (1 - α) * EMA_old
      newEma = (WAIT_TIME_EMA_ALPHA * waitMin) +
               ((1 - WAIT_TIME_EMA_ALPHA) * prevEma);
    }

    const newCount = prevCount + 1;

    await statsRef.set(
      {
        branchCode,
        group,
        bucketId,
        emaWaitMin: newEma,
        sampleCount: newCount,
        updatedAt: admin.firestore.Timestamp.now()
      },
      { merge: true }
    );
  } catch (e) {
    console.warn('[stats] addSeatWaitStat error:', e.message);
  }
}

// ============================================================
// STAFF LOGIN ROUTES
// ============================================================

// Redirect root → /display
app.get('/', (_req, res) => res.redirect('/display'));
app.get('/login', (_req, res) => res.redirect('/staff/login'));

app.get('/staff/login', (req, res) => {
  if (!req.session.__seenLogin) {
    req.session.__seenLogin = Date.now();
    return req.session.save(() => res.render('login', { error: null }));
  }
  res.render('login', { error: null });
});

// Login using Firebase REST Auth + Firestore user profile
app.post('/staff/login', async (req, res) => {
  let lastStep = 'start';
  const step = (s) => { lastStep = s; console.log('[login] step:', s); };

  try {
    step('parse');
    const rawEmail = (req.body.email || req.body.username || '').trim();
    const password = String(req.body.password ?? '');

    if (!rawEmail || !password) {
      return res.render('login', { error: 'Invalid credentials.' });
    }

    const API_KEY = ENV.WEB_API_KEY;
    if (!API_KEY) {
      return res.render('login', { error: 'Auth not configured. Contact admin.' });
    }

    // Firebase REST API login
    step('REST signin');
    let authResp, bodyText = '';
    try {
      authResp = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: rawEmail,
            password,
            returnSecureToken: true
          })
        }
      );
    } catch (e) {
      console.error('[login] fetch failed:', e);
      return res.render('login', { error: 'Server network error.' });
    }

    if (!authResp.ok) {
      try { bodyText = await authResp.text(); } catch {}
      let fbMsg = 'Invalid credentials.';
      try { fbMsg = JSON.parse(bodyText)?.error?.message || fbMsg; } catch {}
      return res.render('login', { error: fbMsg });
    }

    step('parse auth json');
    const authJson = await authResp.json();
    const emailFromAuth = authJson.email || rawEmail;
    const uid = authJson.localId;

    // Firestore user lookup
    step('lookup user doc');
    let snap = await db.collection('users').where('email', '==', emailFromAuth).limit(1).get();
    if (snap.empty)
      snap = await db.collection('users').where('emailLower', '==', emailFromAuth.toLowerCase()).limit(1).get();
    if (snap.empty) {
      return res.render('login', { error: 'Unauthorized (no user profile).' });
    }

    const doc = snap.docs[0];
    const user = doc.data();

    if (!['staff', 'manager', 'admin'].includes(user.role)) {
      return res.render('login', { error: 'Unauthorized (role).' });
    }

    step('session payload');
    const branchCodes = Array.isArray(user.branchCodes)
      ? user.branchCodes
      : (user.branchCode ? [user.branchCode] : []);

    const branchCode = branchCodes[0] || 'YL-MOA';

    req.session.user = {
      uid,
      email: emailFromAuth,
      name: user.name || emailFromAuth,
      role: user.role,
      branchCodes,
      idToken: authJson.idToken
    };

    // Custom claims token
    if (process.env.DISABLE_CUSTOM_TOKEN === '1') {
      console.warn('[login] custom token disabled');
    } else {
      step('mint custom token');
      try {
        req.session.user.customToken =
          await admin.auth().createCustomToken(uid, {
            role: user.role || 'staff',
            branchCodes
          });
      } catch (e) {
        console.error('[login] customToken failed:', e);
        req.session.user.customToken = null;
      }
    }

    // Backfill emailLower
    step('backfill emailLower');
    if (!user.emailLower) {
      try {
        await db.collection('users')
          .doc(doc.id)
          .set({ emailLower: emailFromAuth.toLowerCase() }, { merge: true });
      } catch (e) {
        console.warn('[login] backfill failed:', e.message);
      }
    }

    console.log('[login] ✔', emailFromAuth, '| branch:', branchCode);

    req.session.save(err => {
      if (err) return res.render('login', { error: 'Session error.' });
      res.redirect(`/staff/${branchCode}`);
    });

  } catch (err) {
    console.error('[login] unexpected at', lastStep, ':', err);
    return res.render('login', {
      error: `Unexpected error at ${lastStep}: ${err.message || err}`
    });
  }
});

// Logout
app.post('/staff/logout', (req, res) =>
  req.session.destroy(() => res.redirect('/staff/login'))
);

// Auth guard
function requireAuth(req, res, next) {
  if (req.path.startsWith('/display')) return next(); // public display
  if (req.session?.user) return next();
  return res.redirect('/staff/login');
}

// ============================================================
// STAFF PANEL
// ============================================================

app.get('/staff/:branchCode', requireAuth, async (req, res) => {
  const { branchCode } = req.params;
  const dateKey = manilaDayKey();
  let branchName = BRANCH_NAME_MAP[branchCode] || branchCode;

  // Branch metadata lookup
  try {
    const bDoc = await db.doc(`branches/${branchCode}`).get();
    if (bDoc.exists) {
      const d = bDoc.data() || {};
      branchName =
        d.name || d.displayName || d.branch || d.branchName || branchName;
    }
  } catch (e) {
    console.warn('[panel] branch lookup failed:', e.message);
  }

  const GROUPS = ['P', 'A', 'B', 'C'];
  const tickets = { P: [], A: [], B: [], C: [] };

  // Load queue items
  for (const g of GROUPS) {
    const colRef = db.collection(`queues/${branchCode}/${dateKey}/${g}/items`);
    const snap = await colRef.orderBy('timestamp', 'asc').get();

    snap.forEach(doc => {
      const t = doc.data() || {};
      const ts = t.timestamp?.toMillis?.()
        || t.createdAt?.toMillis?.()
        || Date.now();

      const item = {
        id: doc.id,
        code: t.code || t.queueNum || null,
        name: t.name || 'Guest',
        pax: t.pax || 1,
        status: t.status || 'waiting',
        waitStartMs: Number(ts),
        group: g
      };

      if (['waiting', 'called'].includes(item.status)) {
        tickets[g].push(item);
      }
    });
  }

  const firebaseWebConfig = {
    apiKey: ENV.WEB_API_KEY,
    authDomain: ENV.AUTH_DOMAIN,
    projectId: ENV.PROJECT_ID,
    appId: ENV.APP_ID
  };

  const nowDoc = await db.doc(`queues/${branchCode}/nowServing/current`).get();

  res.render('staff', {
    user: req.session.user,
    authCustomToken: req.session.user.customToken || null,
    branchCode,
    branchName,
    dayKey: dateKey,
    nowServing: nowDoc.exists ? nowDoc.data() : { ticketId: null },
    tickets,
    queueNumberWidth: parseInt(ENV.QUEUE_NUMBER_WIDTH, 10),
    firebaseWebConfig
  });
});

// ============================================================
// QUEUE ACTIONS (CALL, SEAT, SKIP, TOGGLE) — FULLY SAFE
// ============================================================

// -----------------------
// CALL (Standard Button)
// -----------------------
app.post('/staff/:branchCode/call/:group/:ticketId', requireAuth, async (req, res) => {
  const { branchCode, group, ticketId } = req.params;
  const dateKey = manilaDayKey();

  try {
    await db.runTransaction(async (tx) => {
      const tRef    = db.doc(`queues/${branchCode}/${dateKey}/${group}/items/${ticketId}`);
      const gRef    = db.doc(`queues/${branchCode}/nowServing/${group}`);
      const currRef = db.doc(`queues/${branchCode}/nowServing/current`);

      const tSnap = await tx.get(tRef);
      if (!tSnap.exists) throw new Error('Ticket not found.');

      const t = tSnap.data() || {};
      const code = t.code || t.queueNum || null;

      const calledAt = admin.firestore.Timestamp.now();

      const payload = {
        ticketId,
        group,
        code,
        number: code,
        name: t.name || 'Guest',
        pax: t.pax || 1,
        updatedAt: calledAt
      };

      // Update ticket → status: called
      tx.set(
        tRef,
        { status: 'called', calledAt },
        { merge: true }
      );

      // Update group nowServing
      tx.set(gRef, payload, { merge: false });

      // Update global nowServing
      tx.set(currRef, payload, { merge: true });
    });

    // Update waiting snapshot (called still counts as waitingNow; snapshot still useful)
    const branchNameForStats = BRANCH_NAME_MAP[branchCode] || branchCode;
    updateAdminWaitingNowSnapshot(branchCode, dateKey, branchNameForStats)
      .catch(e => console.warn('[adminStats] waitingNow post-call error:', e.message));

    res.json({ ok: true });

  } catch (e) {
    console.error('[call] error:', e);
    res.status(409).json({ ok: false, error: e.message });
  }
});

// -----------------------
// SEAT
// -----------------------
app.post('/staff/:branchCode/seat/:group/:ticketId', requireAuth, async (req, res) => {
  const { branchCode, group, ticketId } = req.params;
  const dateKey = manilaDayKey();

  try {
    // We'll capture data needed for stats OUTSIDE the transaction
    let ticketDataForStats = null;
    let seatedAtForStats   = null;

    await db.runTransaction(async (tx) => {
      const tRef    = db.doc(`queues/${branchCode}/${dateKey}/${group}/items/${ticketId}`);
      const gRef    = db.doc(`queues/${branchCode}/nowServing/${group}`);
      const currRef = db.doc(`queues/${branchCode}/nowServing/current`);

      const [tSnap, gSnap, cSnap] = await Promise.all([
        tx.get(tRef),
        tx.get(gRef),
        tx.get(currRef)
      ]);

      if (tSnap.exists) {
        const t = tSnap.data() || {};
        const seatedAt = admin.firestore.Timestamp.now();

        // capture for analytics AFTER transaction
        ticketDataForStats = t;
        seatedAtForStats   = seatedAt;

        // mark as seated then remove from active queue
        tx.set(
          tRef,
          { status: 'seated', seatedAt },
          { merge: true }
        );

        tx.delete(tRef);
      }

      // Clear group nowServing if it was this ticket
      if (gSnap.exists && gSnap.data()?.ticketId === ticketId) {
        tx.delete(gRef);
      }

      // Clear global nowServing if it was this ticket
      if (cSnap.exists && cSnap.data()?.ticketId === ticketId) {
        tx.set(
          currRef,
          {
            ticketId: null,
            group: null,
            number: null,
            name: null,
            pax: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      }
    });

    // Fire-and-forget wait-time stat update (doesn't block response, not in transaction)
    if (ticketDataForStats && seatedAtForStats) {
      addSeatWaitStat(branchCode, group, ticketDataForStats, seatedAtForStats)
        .catch(e => console.warn('[stats] post-seat error:', e.message));
    }

    // Fire-and-forget admin daily aggregates (idempotent)
    const branchNameForStats = BRANCH_NAME_MAP[branchCode] || branchCode;

    recordAdminStatEvent({
      branchCode,
      dateKey,
      action: 'seated',
      ticketId,
      branchName: branchNameForStats
    }).catch(e => console.warn('[adminStats] seated error:', e.message));

    updateAdminWaitingNowSnapshot(branchCode, dateKey, branchNameForStats)
      .catch(e => console.warn('[adminStats] waitingNow post-seat error:', e.message));

    res.json({ ok: true });

  } catch (e) {
    console.error('[seat] error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -----------------------
// SKIP
// -----------------------
app.post('/staff/:branchCode/skip/:group/:ticketId', requireAuth, async (req, res) => {
  const { branchCode, group, ticketId } = req.params;
  const dateKey = manilaDayKey();

  try {
    const tRef    = db.doc(`queues/${branchCode}/${dateKey}/${group}/items/${ticketId}`);
    const gRef    = db.doc(`queues/${branchCode}/nowServing/${group}`);
    const currRef = db.doc(`queues/${branchCode}/nowServing/current`);

    // Mark skipped
    await tRef.set({ status: 'skipped' }, { merge: true });

    const [gSnap, cSnap] = await Promise.all([
      gRef.get(), currRef.get()
    ]);

    if (gSnap.exists && gSnap.data()?.ticketId === ticketId) {
      await gRef.delete();
    }

    if (cSnap.exists && cSnap.data()?.ticketId === ticketId) {
      await currRef.set({
        ticketId: null, group: null,
        number: null, name: null, pax: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    // Fire-and-forget admin daily aggregates (idempotent)
    const branchNameForStats = BRANCH_NAME_MAP[branchCode] || branchCode;

    recordAdminStatEvent({
      branchCode,
      dateKey,
      action: 'skipped',
      ticketId,
      branchName: branchNameForStats
    }).catch(e => console.warn('[adminStats] skipped error:', e.message));

    updateAdminWaitingNowSnapshot(branchCode, dateKey, branchNameForStats)
      .catch(e => console.warn('[adminStats] waitingNow post-skip error:', e.message));

    res.json({ ok: true });

  } catch (e) {
    console.error('[skip] error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -----------------------
// TOGGLE CALL (API)
// -----------------------
app.post('/api/call', async (req, res) => {
  try {
    const { branch, group, id, toggle } = req.body || {};
    console.log('[API /api/call] INCOMING', { branch, group, id, toggle });
    if (!branch || !group || !id) {
      return res.status(400).json({ ok: false, error: 'Missing branch/group/id' });
    }

    const dateKey = manilaDayKey();

    const itemsCol = db.collection(`queues/${branch}/${dateKey}/${group}/items`);
    const targetRef = itemsCol.doc(id);
    const gRef = db.doc(`queues/${branch}/nowServing/${group}`);
    const currRef = db.doc(`queues/${branch}/nowServing/current`);

    await db.runTransaction(async (tx) => {
      // Fetch data
      const [
        targetSnap,
        calledQSnap,
        gSnap,
        cSnap
      ] = await Promise.all([
        tx.get(targetRef),
        tx.get(itemsCol.where('status', '==', 'called')),
        tx.get(gRef),
        tx.get(currRef)
      ]);

      if (!targetSnap.exists) throw new Error('Ticket not found');

      const t = targetSnap.data() || {};
      const code = t.code || t.queueNum || null;

      const calledAt = admin.firestore.Timestamp.now();

      const payload = {
        ticketId: id,
        group,
        code,
        number: code,
        name: t.name || 'Guest',
        pax: t.pax || 1,
        updatedAt: calledAt
      };

      // -----------------------------
      // UNCALL
      // -----------------------------
      if (toggle && t.status === 'called') {
        tx.set(targetRef,
          { status: 'waiting', calledAt: admin.firestore.FieldValue.delete() },
          { merge: true }
        );

        // clear group nowServing
        if (gSnap.exists && gSnap.data()?.ticketId === id) {
          tx.delete(gRef);
        }

        // clear global nowServing
        if (cSnap.exists && cSnap.data()?.ticketId === id) {
          tx.set(currRef, {
            ticketId: null, group: null,
            number: null, name: null, pax: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }

        return;
      }

      // -----------------------------
      // CALL (toggle ON)
      // uncall other items
      // -----------------------------
      calledQSnap.forEach((d) => {
        if (d.id !== id) {
          tx.set(d.ref,
            { status: 'waiting', calledAt: admin.firestore.FieldValue.delete() },
            { merge: true }
          );
        }
      });

      tx.set(targetRef,
        { status: 'called', calledAt },
        { merge: true }
      );

      tx.set(gRef, payload, { merge: false });
      tx.set(currRef, payload, { merge: true });
    });

    // Update waiting snapshot after call/uncall
    const branchNameForStats = BRANCH_NAME_MAP[branch] || branch;
    updateAdminWaitingNowSnapshot(branch, dateKey, branchNameForStats)
      .catch(e => console.warn('[adminStats] waitingNow post-api-call error:', e.message));

    res.json({ ok: true });

  } catch (err) {
    console.error('[API /api/call] error:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ============================================================================
// PUBLIC DISPLAY ROUTES (NO AUTH REQUIRED)
// ============================================================================

// Quick redirect to default branch
app.get('/display', (_req, res) => {
  return res.redirect('/display/YL-MOA');
});

// Render display screen
app.get('/display/:branchCode', async (req, res) => {
  const { branchCode } = req.params;
  let branchName = BRANCH_NAME_MAP[branchCode] || branchCode;

  // Load branch metadata
  try {
    const bDoc = await db.doc(`branches/${branchCode}`).get();
    if (bDoc.exists) {
      const d = bDoc.data() || {};
      branchName =
        d.name ||
        d.displayName ||
        d.branch ||
        d.branchName ||
        branchName;
    }
  } catch (e) {
    console.warn('[display] branch lookup failed:', e.message);
  }

  // No caching
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  res.render('display', { branchCode, branchName });
});

// ============================================================================
// DISPLAY JSON DATA FORMAT
// { P:{called,waiting}, A:{...}, B:{...}, C:{...} }
// ============================================================================
app.get('/display/:branchCode/json', async (req, res) => {
  const { branchCode } = req.params;
  const dateKey = manilaDayKey();

  const GROUPS = ['P', 'A', 'B', 'C'];
  const result = { P:null, A:null, B:null, C:null };

  try {
    for (const g of GROUPS) {
      const colRef = db.collection(`queues/${branchCode}/${dateKey}/${g}/items`);
      const snap = await colRef.orderBy('timestamp', 'asc').get();

      let called = null;
      const waiting = [];

      snap.forEach(doc => {
        const t = doc.data() || {};
        const status = (t.status || '').toLowerCase();

        if (!['waiting', 'called'].includes(status)) return;

        const code = t.code || t.queueNum || null;

        const ts = t.timestamp?.toMillis?.()
          || t.createdAt?.toMillis?.()
          || Date.now();

        const entry = {
          id: doc.id,
          code,
          name: t.name || 'Guest',
          pax: t.pax || 1,
          timestamp: ts
        };

        if (status === 'called') {
          called = {
            code,
            name: entry.name,
            pax: entry.pax,
            updatedAt: t.calledAt?.toMillis?.() || ts
          };
        } else {
          waiting.push(entry);
        }
      });

      waiting.sort((a, b) => a.timestamp - b.timestamp);

      result[g] = {
        called: called || null,
        waiting
      };
    }
  } catch (e) {
    console.warn('[display-json] error:', e.message);
  }

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  res.json(result);
});

// ============================================================================
// BRANCH-SPECIFIC VIDEO LIST
// ============================================================================
app.get('/display/:branchCode/videos.json', (req, res) => {
  const { branchCode } = req.params;

  const baseA = path.join(__dirname, 'public_media', 'display', branchCode);
  const baseB = path.join(__dirname, 'public_media', 'display');
  const base = fs.existsSync(baseA) ? baseA : baseB;

  let list = [];
  try {
    list = fs.readdirSync(base)
      .filter(f => /\.(mp4|webm|ogg|mov|m4v)$/i.test(f))
      .map(f => `/public_media/display${fs.existsSync(baseA) ? `/${branchCode}` : ''}/${encodeURIComponent(f)}`);
  } catch {}

  res.json(list);
});

// ============================================================================
// GLOBAL VIDEO PLAYLIST (Ordered + Versioned)
// ============================================================================
app.get('/api/media/display/playlist', async (req, res) => {
  const dir = path.join(__dirname, 'public_media', 'display');

  try {
    const names = await fs.promises.readdir(dir);
    const videoNames = names.filter(n =>
      /\.(mp4|webm|mov|m4v|ogg)$/i.test(n)
    );

    videoNames.sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true })
    );

    const stats = await Promise.all(
      videoNames.map(async n => {
        const st = await fs.promises.stat(path.join(dir, n));
        return `${n}:${st.mtimeMs}`;
      })
    );

    const items = videoNames.map(n =>
      `/media/display/${encodeURIComponent(n)}`
    );

    res.setHeader('Cache-Control', 'no-store');
    res.json({ version: stats.join('|'), items });

  } catch {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ version: '0', items: [] });
  }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, project: ENV.PROJECT_ID });
});

// ============================================================================
// START SERVER
// ============================================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[staff-app] listening on ${PORT}`);
});
