// QSys Admin-App (Standalone, JS version)
// Express + EJS + Firebase Admin (ENV-only, cPanel-ready)

const express = require('express');
const path = require('path');
const session = require('express-session');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

// --- ensure fetch exists on Node < 18 (cPanel often uses 16) ---
let _fetch = global.fetch;
if (!_fetch) {
  _fetch = (...args) => import('node-fetch').then(m => m.default(...args));
}
const fetch = (...args) => _fetch(...args);

// ---------------- ENV + Firebase Admin ----------------
const admin = require('firebase-admin');

const ENV = {
  PROJECT_ID:
    process.env.ADMIN_FIREBASE_PROJECT_ID ||
    process.env.FIREBASE_PROJECT_ID,

  CLIENT_EMAIL:
    process.env.ADMIN_FIREBASE_ADMIN_EMAIL ||
    process.env.FIREBASE_ADMIN_CLIENT_EMAIL ||
    process.env.FIREBASE_CLIENT_EMAIL,

  PRIVATE_KEY:
    process.env.ADMIN_FIREBASE_ADMIN_KEY ||
    process.env.FIREBASE_ADMIN_PRIVATE_KEY ||
    process.env.FIREBASE_PRIVATE_KEY ||
    '',

  PRIVATE_KEY_B64:
    process.env.ADMIN_FIREBASE_ADMIN_KEY_B64 ||
    process.env.FIREBASE_ADMIN_PRIVATE_KEY_B64 ||
    '',

  WEB_API_KEY:
    process.env.ADMIN_FIREBASE_API_KEY ||
    process.env.FIREBASE_WEB_API_KEY ||
    process.env.FIREBASE_API_KEY,

  AUTH_DOMAIN:
    process.env.ADMIN_FIREBASE_AUTH_DOMAIN ||
    process.env.FIREBASE_AUTH_DOMAIN,

  APP_ID:
    process.env.ADMIN_FIREBASE_APP_ID ||
    process.env.FIREBASE_APP_ID,

  SESSION_SECRET: process.env.SESSION_SECRET || 'change_me',
  SESSION_COOKIE_DOMAIN: process.env.SESSION_COOKIE_DOMAIN || '', // optional: .onegourmetph.com
  FORCE_HTTPS: process.env.FORCE_HTTPS || '0'
};

// Sanitize
for (const k of Object.keys(ENV)) {
  if (typeof ENV[k] === 'string') ENV[k] = ENV[k].trim();
}

function resolvePrivateKey() {
  if (ENV.PRIVATE_KEY_B64) {
    return Buffer.from(ENV.PRIVATE_KEY_B64, 'base64').toString('utf8').trim();
  }
  if (ENV.PRIVATE_KEY) {
    let k = ENV.PRIVATE_KEY;
    if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
      k = k.slice(1, -1);
    }
    return k.replace(/\\n/g, '\n').trim();
  }
  return '';
}

function initFirebase() {
  if (admin.apps.length) return;

  const pk = resolvePrivateKey();
  if (!ENV.PROJECT_ID || !ENV.CLIENT_EMAIL || !pk) {
    throw new Error('Missing Firebase Admin env values (projectId/clientEmail/privateKey).');
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: ENV.PROJECT_ID,
      clientEmail: ENV.CLIENT_EMAIL,
      privateKey: pk
    })
  });

  console.log('[Firebase] Admin-App connected to project:', ENV.PROJECT_ID);
}

initFirebase();
const db = admin.firestore();

// ---------------- Express App ----------------
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use('/public', express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
}));

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Force HTTPS (optional)
if (ENV.FORCE_HTTPS === '1') {
  app.use((req, res, next) => {
    const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (proto && proto !== 'https') {
      return res.redirect(307, 'https://' + req.headers.host + req.originalUrl);
    }
    next();
  });
}

// ---------------- Session ----------------
app.set('trust proxy', 1);

const cookieDomain = ENV.SESSION_COOKIE_DOMAIN || undefined;
const isProd = process.env.NODE_ENV === 'production';

app.use(session({
  name: 'admin.sid',
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

// local override
if (!isProd) {
  app.use((req, _res, next) => {
    req.session.cookie.secure = false;
    req.session.cookie.domain = undefined;
    next();
  });
}

// Remove legacy cookies (if any)
app.use((req, res, next) => {
  if ((req.headers.cookie || '').includes('connect.sid=')) {
    res.clearCookie('connect.sid', { path: '/' });
    res.clearCookie('connect.sid', { path: '/', domain: '.onegourmetph.com' });
  }
  next();
});

// ---------------- Helpers ----------------
function manilaDayKey(d) {
  return (d ? dayjs(d) : dayjs()).tz('Asia/Manila').format('YYYY-MM-DD');
}

function requireAdminPage(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  return res.redirect('/login');
}

// IMPORTANT: API guard must NEVER redirect (JSON only)
function requireAdminApi(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
}

function normalizeUserDoc(docSnap) {
  const u = docSnap.data() || {};
  return {
    id: docSnap.id,
    email: u.email || '',
    emailLower: u.emailLower || (u.email ? String(u.email).toLowerCase() : ''),
    name: u.name || u.displayName || u.email || 'Admin',
    role: u.role || 'staff'
  };
}

// ---------------- Admin Daily Stats Helpers ----------------
function adminStatsDocId(dateKey, branchCode) {
  return `${dateKey}__${branchCode}`;
}

async function countWaitingNow(branchCode, dateKey) {
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

async function getBranchesList() {
  const branchesSnap = await db.collection('branches').get();
  return branchesSnap.docs.map(d => {
    const data = d.data() || {};
    return {
      code: data.branchCode || data.code || d.id,
      name: data.name || data.branchName || data.displayName || (data.branchCode || data.code || d.id)
    };
  });
}

// ---------------- Auth Routes ----------------
app.get('/', (_req, res) => res.redirect('/dashboard'));

app.get('/login', (req, res) => {
  if (req.session?.user?.role === 'admin') return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  let lastStep = 'start';
  const step = (s) => { lastStep = s; console.log('[admin login] step:', s); };

  try {
    step('parse');
    const rawEmail = (req.body.email || req.body.username || '').trim();
    const password = String(req.body.password ?? '');

    if (!rawEmail || !password) {
      return res.render('login', { error: 'Invalid credentials.' });
    }

    if (!ENV.WEB_API_KEY) {
      return res.render('login', { error: 'Auth not configured. Contact admin.' });
    }

    // Firebase REST login
    step('REST signin');
    const authResp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${ENV.WEB_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: rawEmail, password, returnSecureToken: true })
      }
    );

    if (!authResp.ok) {
      let bodyText = '';
      try { bodyText = await authResp.text(); } catch {}
      let msg = 'Invalid credentials.';
      try { msg = JSON.parse(bodyText)?.error?.message || msg; } catch {}
      return res.render('login', { error: msg });
    }

    step('auth json');
    const authJson = await authResp.json();
    const emailFromAuth = authJson.email || rawEmail;
    const uid = authJson.localId;

    // Find Firestore user profile
    step('lookup user doc');
    let snap = await db.collection('users').where('email', '==', emailFromAuth).limit(1).get();
    if (snap.empty) {
      snap = await db.collection('users').where('emailLower', '==', emailFromAuth.toLowerCase()).limit(1).get();
    }
    if (snap.empty) {
      return res.render('login', { error: 'Unauthorized (no user profile).' });
    }

    const user = normalizeUserDoc(snap.docs[0]);
    if (user.role !== 'admin') {
      return res.render('login', { error: 'Unauthorized (role).' });
    }

    // Backfill emailLower (optional)
    if (!user.emailLower && user.email) {
      try {
        await db.collection('users').doc(user.id).set({ emailLower: user.email.toLowerCase() }, { merge: true });
      } catch (e) {
        console.warn('[admin login] backfill emailLower failed:', e.message);
      }
    }

    req.session.user = {
      uid,
      email: emailFromAuth,
      name: user.name,
      role: 'admin',
      idToken: authJson.idToken
    };

    console.log('[admin login] ✔', emailFromAuth);

    req.session.save(err => {
      if (err) return res.render('login', { error: 'Session error.' });
      res.redirect('/dashboard');
    });

  } catch (e) {
    console.error('[admin login] unexpected at', lastStep, e);
    res.render('login', { error: `Unexpected error at ${lastStep}` });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------------- Pages ----------------
app.get('/dashboard', requireAdminPage, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.render('dashboard', {
    user: req.session.user,
    today: manilaDayKey()
  });
});

// placeholders so nav doesn’t 404
app.get('/branches', requireAdminPage, (_req, res) => res.send('Branches page placeholder'));
app.get('/users', requireAdminPage, (_req, res) => res.send('Users page placeholder'));
app.get('/reports', requireAdminPage, (_req, res) => res.send('Reports page placeholder'));
app.get('/qrcodes', requireAdminPage, (_req, res) => res.send('QR Codes page placeholder'));

// ---------------- API: Daily Stats ----------------
// Reads: adminDailyStats/{YYYY-MM-DD__BRANCHCODE}
app.get('/api/admin/daily-stats', requireAdminApi, async (req, res) => {
  try {
    const dateKey = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      return res.status(400).json({ ok: false, error: 'Invalid date (YYYY-MM-DD)' });
    }

    const snap = await db.collection('adminDailyStats')
      .where('dateKey', '==', dateKey)
      .get();

    const byBranch = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const totals = {
      reserved: 0,
      seated: 0,
      skipped: 0,
      waitingNow: { P: 0, A: 0, B: 0, C: 0 }
    };

    for (const b of byBranch) {
      const t = b.totals || {};
      totals.reserved += Number(t.reserved || 0);
      totals.seated   += Number(t.seated || 0);
      totals.skipped  += Number(t.skipped || 0);

      const w = b.waitingNow || {};
      totals.waitingNow.P += Number(w.P || 0);
      totals.waitingNow.A += Number(w.A || 0);
      totals.waitingNow.B += Number(w.B || 0);
      totals.waitingNow.C += Number(w.C || 0);
    }

    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, dateKey, totals, byBranch });

  } catch (e) {
    console.error('[api daily-stats] error:', e);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ---------------- API: Recalculate Daily Stats (ADMIN ONLY) ----------------
// POST /api/admin/recalc-daily?date=YYYY-MM-DD
// Recomputes waitingNow from queues + reserved = waitingTotal + seated + skipped
app.post('/api/admin/recalc-daily', requireAdminApi, async (req, res) => {
  try {
    const dateKey = String(req.query.date || '').trim() || manilaDayKey();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      return res.status(400).json({ ok: false, error: 'Invalid date (YYYY-MM-DD)' });
    }

    const branches = await getBranchesList();
    const results = [];

    for (const b of branches) {
      const statsId = adminStatsDocId(dateKey, b.code);
      const statsRef = db.collection('adminDailyStats').doc(statsId);

      // Preserve seated/skipped as currently tracked (from events via staff actions)
      const prevSnap = await statsRef.get();
      const prev = prevSnap.exists ? (prevSnap.data() || {}) : {};
      const totals = prev.totals || {};

      const seated = Number(totals.seated || 0);
      const skipped = Number(totals.skipped || 0);

      const waitingNow = await countWaitingNow(b.code, dateKey);
      const waitingTotal = waitingNow.P + waitingNow.A + waitingNow.B + waitingNow.C;

      // Reserved should represent "total tickets today" that still matter:
      // waiting/ called + seated + skipped
      const reserved = waitingTotal + seated + skipped;

      // IMPORTANT: write nested object, DO NOT write "totals.reserved" as a literal field.
      await statsRef.set({
        dateKey,
        branchCode: b.code,
        branchName: b.name,
        totals: { reserved, seated, skipped },
        waitingNow,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      results.push({ branchCode: b.code, reserved, seated, skipped, waitingNow });
    }

    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, dateKey, results });

  } catch (e) {
    console.error('[api recalc-daily] error:', e);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ---------------- Debug ----------------
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, project: ENV.PROJECT_ID });
});

app.get('/__whoami', (req, res) => {
  res.json({
    ok: true,
    cwd: process.cwd(),
    file: __filename,
    user: req.session?.user || null
  });
});

// ---------------- Start ----------------
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`[admin-app] listening on ${PORT}`);
});
