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
  SESSION_COOKIE_DOMAIN: process.env.SESSION_COOKIE_DOMAIN || '', // leave BLANK for staging unless you KNOW you need it
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
    // Do NOT proceed and crash later. Fail fast with a clear error.
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

// Trust proxy is REQUIRED on cPanel/Passenger (must be BEFORE session)
app.set('trust proxy', 1);

app.use('/public', express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Force HTTPS (optional)
if (ENV.FORCE_HTTPS === '1') {
  app.use((req, res, next) => {
    const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (proto && proto !== 'https') {
      return res.redirect(307, 'https://' + req.headers.host + req.originalUrl);
    }
    next();
  });
}

// ---------------- Session ----------------
// IMPORTANT: If blank, do NOT set cookie domain at all.
function getCookieDomain(req) {
  // If explicitly set in cPanel, use it (only if it looks valid)
  const v = (ENV.SESSION_COOKIE_DOMAIN || '').trim();
  if (v && v.includes('.')) return v;

  // Default: DO NOT set cookie domain (works for both staging and live reliably)
  return undefined;
}


app.use(session({
  name: process.env.SESSION_COOKIE_NAME || 'admin.sid',
  secret: ENV.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true, // IMPORTANT behind reverse proxy (cPanel)
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    // keep this false here; we'll force secure dynamically per request based on x-forwarded-proto
    secure: false,
    domain: cookieDomain,
    // optional: reduce weird long-lived loops while testing
    maxAge: 1000 * 60 * 60 * 12 // 12 hours
  }
}));

app.use((req, _res, next) => {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const isHttps = (proto === 'https') || req.secure === true;

  // always correct behind cPanel proxy
  req.session.cookie.secure = isHttps;

  // flexible domain: undefined = host-only cookie (recommended)
  req.session.cookie.domain = getCookieDomain(req);

  next();
});

// Force secure cookie when behind HTTPS (fixes login loops on cPanel)
app.use((req, _res, next) => {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const isHttps = (proto === 'https') || req.secure === true;

  if (req.session && req.session.cookie) {
    req.session.cookie.secure = isHttps;
  }
  next();
});

// Remove legacy cookies (if any)
app.use((req, res, next) => {
  const c = (req.headers.cookie || '');
  if (c.includes('connect.sid=')) {
    res.clearCookie('connect.sid', { path: '/' });
    res.clearCookie('connect.sid', { path: '/', domain: '.onegourmetph.com' });
  }
  // also clear legacy admin.sid if domain was previously set incorrectly
  if (c.includes('admin.sid=')) {
    res.clearCookie('admin.sid', { path: '/' });
    res.clearCookie('admin.sid', { path: '/', domain: '.onegourmetph.com' });
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

function normalizeBranchDoc(docSnap) {
  const d = docSnap.data() || {};
  const code = (d.branchCode || d.code || docSnap.id || '').toString().trim().toUpperCase();
  return {
    id: docSnap.id,
    branchCode: code,
    code,
    branchName: d.branchName || d.name || d.displayName || code,
    name: d.branchName || d.name || d.displayName || code,
    slug: (d.slug || code).toString().trim().toLowerCase(),
    location: d.location || '',
    active: (d.active === false) ? false : true,
    updatedAt: d.updatedAt || null,
    createdAt: d.createdAt || null
  };
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------- Auth Routes ----------------
app.get('/', (_req, res) => res.redirect('/dashboard'));

app.get('/login', (req, res) => {
  if (req.session?.user?.role === 'admin') return res.redirect('/dashboard');
  res.set('Cache-Control', 'no-store');
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

    if (!user.emailLower && user.email) {
      try {
        await db.collection('users').doc(user.id).set({ emailLower: user.email.toLowerCase() }, { merge: true });
      } catch (e) {
        console.warn('[admin login] backfill emailLower failed:', e.message);
      }
    }

    step('regenerate session');
    req.session.regenerate((err) => {
      if (err) {
        console.error('[admin login] regenerate error:', err);
        return res.render('login', { error: 'Session error.' });
      }

      req.session.user = {
        uid,
        email: emailFromAuth,
        name: user.name,
        role: 'admin',
        idToken: authJson.idToken
      };

      console.log('[admin login] ✔', emailFromAuth);

      req.session.save((err2) => {
        if (err2) {
          console.error('[admin login] save error:', err2);
          return res.render('login', { error: 'Session error.' });
        }
        res.redirect('/dashboard');
      });
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

// Branches page (server-rendered list)
app.get('/branches', requireAdminPage, async (req, res) => {
  try {
    const snap = await db.collection('branches').get();
    const branches = snap.docs.map(normalizeBranchDoc)
      .sort((a, b) => (a.branchName || '').localeCompare(b.branchName || ''));

    res.set('Cache-Control', 'no-store');
    res.render('branches', { user: req.session.user, branches, error: null, ok: null });
  } catch (e) {
    console.error('[branches page] error:', e);
    res.status(500).send('Error loading branches.');
  }
});

app.post('/branches/save', requireAdminPage, async (req, res) => {
  try {
    const branchCode = String(req.body.branchCode || req.body.code || '').trim().toUpperCase();
    const branchName = String(req.body.branchName || req.body.name || '').trim();
    const slug = String(req.body.slug || '').trim().toLowerCase();
    const location = String(req.body.location || '').trim();
    const active = String(req.body.active || 'true').toLowerCase() !== 'false';

    if (!branchCode || !branchName) {
      return res.redirect('/branches');
    }

    await db.collection('branches').doc(branchCode).set({
      branchCode,
      code: branchCode,
      branchName,
      name: branchName,
      slug: slug || branchCode.toLowerCase(),
      location,
      active,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.redirect('/branches');
  } catch (e) {
    console.error('[branches save] error:', e);
    res.status(500).send('Error saving branch.');
  }
});

// placeholders so nav doesn’t 404
app.get('/users', requireAdminPage, (_req, res) => res.send('Users page placeholder'));
app.get('/reports', requireAdminPage, (_req, res) => res.send('Reports page placeholder'));
app.get('/qrcodes', requireAdminPage, (_req, res) => res.send('QR Codes page placeholder'));

// ---------------- API: Daily Stats ----------------
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
      const reservedNested = safeNumber(t.reserved);
      const reservedLegacy = safeNumber(b['totals.reserved']);
      const reserved = Math.max(reservedNested, reservedLegacy);

      totals.reserved += reserved;
      totals.seated   += safeNumber(t.seated);
      totals.skipped  += safeNumber(t.skipped);

      const w = b.waitingNow || {};
      totals.waitingNow.P += safeNumber(w.P);
      totals.waitingNow.A += safeNumber(w.A);
      totals.waitingNow.B += safeNumber(w.B);
      totals.waitingNow.C += safeNumber(w.C);
    }

    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, dateKey, totals, byBranch });

  } catch (e) {
    console.error('[api daily-stats] error:', e);
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ---------------- API: Branches ----------------
app.get('/api/admin/branches', requireAdminApi, async (_req, res) => {
  try {
    const snap = await db.collection('branches').get();
    const branches = snap.docs.map(normalizeBranchDoc);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, branches });
  } catch (e) {
    console.error('[api branches] error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

app.post('/api/admin/branches/save', requireAdminApi, async (req, res) => {
  try {
    const body = req.body || {};
    const branchCode = String(body.branchCode || body.code || '').trim().toUpperCase();
    const branchName = String(body.branchName || body.name || '').trim();
    const slug = String(body.slug || '').trim().toLowerCase();
    const location = String(body.location || '').trim();
    const active = (body.active === false || String(body.active).toLowerCase() === 'false') ? false : true;

    if (!branchCode || !branchName) {
      return res.status(400).json({ ok: false, error: 'branchCode and branchName are required' });
    }

    await db.collection('branches').doc(branchCode).set({
      branchCode,
      code: branchCode,
      branchName,
      name: branchName,
      slug: slug || branchCode.toLowerCase(),
      location,
      active,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ ok: true });
  } catch (e) {
    console.error('[api branches save] error:', e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

// ---------------- Debug ----------------
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, project: ENV.PROJECT_ID });
});

app.get('/__whoami', (req, res) => {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  res.json({
    ok: true,
    cwd: process.cwd(),
    file: __filename,
    cookieDomain,
    xForwardedProto: proto || null,
    reqSecure: !!req.secure,
    sessionHasUser: !!req.session?.user,
    user: req.session?.user || null
  });
});

// ---------------- Start ----------------
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`[admin-app] listening on ${PORT}`);
});
