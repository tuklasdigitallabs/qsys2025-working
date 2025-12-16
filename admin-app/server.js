// QSys Admin-App (Standalone, JS version)

// Express + EJS + Firebase Admin (ENV-only, cPanel-ready)

const express = require("express");

const path = require("path");

const session = require("express-session");

const dayjs = require("dayjs");

const utc = require("dayjs/plugin/utc");

const tz = require("dayjs/plugin/timezone");

dayjs.extend(utc);

dayjs.extend(tz);

// --- ensure fetch exists on Node < 18 (cPanel often uses 16) ---

let _fetch = global.fetch;

if (!_fetch) {
  _fetch = (...args) => import("node-fetch").then((m) => m.default(...args));
}

const fetch = (...args) => _fetch(...args);

// ---------------- ENV + Firebase Admin ----------------

const admin = require("firebase-admin");

const ENV = {
  PROJECT_ID:
    process.env.ADMIN_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID,

  CLIENT_EMAIL:
    process.env.ADMIN_FIREBASE_ADMIN_EMAIL ||
    process.env.FIREBASE_ADMIN_CLIENT_EMAIL ||
    process.env.FIREBASE_CLIENT_EMAIL,

  PRIVATE_KEY:
    process.env.ADMIN_FIREBASE_PRIVATE_KEY ||
    process.env.FIREBASE_ADMIN_PRIVATE_KEY ||
    process.env.FIREBASE_PRIVATE_KEY,

  DB_URL:
    process.env.ADMIN_FIREBASE_DB_URL || process.env.FIREBASE_DATABASE_URL,

  // Reuse same web config as staff app so login behaves identically

  WEB_API_KEY:
    process.env.STAFF_FIREBASE_API_KEY ||
    process.env.FIREBASE_WEB_API_KEY ||
    process.env.FIREBASE_API_KEY,

  AUTH_DOMAIN:
    process.env.STAFF_FIREBASE_AUTH_DOMAIN || process.env.FIREBASE_AUTH_DOMAIN,

  APP_ID: process.env.STAFF_FIREBASE_APP_ID || process.env.FIREBASE_APP_ID,

  SESSION_SECRET:
    process.env.ADMIN_SESSION_SECRET ||
    process.env.SESSION_SECRET ||
    "qsys-admin-secret-fallback",

  NODE_ENV: process.env.NODE_ENV || "development",

  PORT: process.env.PORT || 3002,
};

// basic trim on string envs

for (const k of Object.keys(ENV)) {
  if (typeof ENV[k] === "string") ENV[k] = ENV[k].trim();
}

// Env debug (without leaking secrets)

console.log("[ADMIN-APP] ENV summary:", {
  PROJECT_ID: ENV.PROJECT_ID || null,

  HAS_CLIENT_EMAIL: !!ENV.CLIENT_EMAIL,

  HAS_PRIVATE_KEY: !!ENV.PRIVATE_KEY,

  HAS_DB_URL: !!ENV.DB_URL,

  HAS_WEB_API_KEY: !!ENV.WEB_API_KEY,

  AUTH_DOMAIN: ENV.AUTH_DOMAIN || null,

  APP_ID: ENV.APP_ID || null,

  NODE_ENV: ENV.NODE_ENV,

  PORT: ENV.PORT,
});

if (!ENV.PROJECT_ID || !ENV.CLIENT_EMAIL || !ENV.PRIVATE_KEY) {
  console.error("[ADMIN-APP] Missing Firebase Admin env vars");
}

// Initialize Firebase Admin for Admin project

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: ENV.PROJECT_ID,

      clientEmail: ENV.CLIENT_EMAIL,

      privateKey: ENV.PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),

    databaseURL: ENV.DB_URL,
  });

  console.log("[ADMIN-APP] Firebase initialized for project:", ENV.PROJECT_ID);
} else {
  console.log("[ADMIN-APP] Firebase already initialized");
}

const db = admin.firestore();

// ---------------- Express App Setup ----------------

const app = express();

app.set("view engine", "ejs");

app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));

app.use(express.json());

app.use("/public", express.static(path.join(__dirname, "public")));

app.set("trust proxy", 1);

const isProd = ENV.NODE_ENV === "production";

// ---------------- Session ----------------

app.use(
  session({
    name: "admin.sid",

    secret: ENV.SESSION_SECRET,

    resave: false,

    saveUninitialized: false,

    cookie: {
      httpOnly: true,

      secure: isProd, // true on production

      sameSite: "lax",

      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    },
  })
);

// ---------------- Auth Helpers ----------------

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect("/login");
  }

  next();
}

function requireAdmin(req, res, next) {
  if (
    !req.session ||
    !req.session.user ||
    !["admin", "superadmin"].includes(req.session.user.role)
  ) {
    return res.redirect("/login");
  }

  next();
}

// ---------------- Routes: Auth ----------------

// Redirect root -> dashboard or login

app.get("/", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");

  return res.redirect("/login");
});

app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");

  const error = req.query.error || null;

  res.render("login", { error });
});

// DEBUG helper to see current session user

app.get("/whoami", (req, res) => {
  res.json({
    loggedIn: !!req.session.user,

    user: req.session.user || null,
  });
});

// Login via Firebase Auth REST + Firestore user profile (admin role required)

app.post("/login", async (req, res) => {
  let lastStep = "start";

  try {
    lastStep = "parse";

    const rawEmail = (req.body.email || "").trim();

    const password = String(req.body.password ?? "");

    console.log("[ADMIN-APP] /login attempt:", {
      rawEmail,

      hasPassword: !!password,
    });

    if (!rawEmail || !password) {
      console.warn("[ADMIN-APP] /login missing credentials");

      return res.redirect("/login?error=Missing+credentials");
    }

    const API_KEY = ENV.WEB_API_KEY;

    if (!API_KEY) {
      console.error("[ADMIN-APP] Missing WEB_API_KEY for login");

      return res.redirect("/login?error=Auth+not+configured");
    }

    // 1) Firebase Auth sign-in (same as staff app)

    lastStep = "firebase-auth";

    console.log("[ADMIN-APP] /login Firebase Auth signInWithPassword...");

    let authResp,
      bodyText = "";

    try {
      authResp = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,

        {
          method: "POST",

          headers: { "Content-Type": "application/json" },

          body: JSON.stringify({
            email: rawEmail,
            password,
            returnSecureToken: true,
          }),
        }
      );
    } catch (e) {
      console.error("[ADMIN-APP] login fetch failed:", e);

      return res.redirect("/login?error=Network+error");
    }

    console.log("[ADMIN-APP] Firebase Auth response status:", authResp.status);

    if (!authResp.ok) {
      try {
        bodyText = await authResp.text();
      } catch {}

      console.warn("[ADMIN-APP] Firebase Auth error body:", bodyText);

      let fbMsg = "Invalid+credentials";

      try {
        fbMsg = JSON.parse(bodyText)?.error?.message || fbMsg;
      } catch {}

      return res.redirect(`/login?error=${encodeURIComponent(fbMsg)}`);
    }

    lastStep = "parse-auth-json";

    const authJson = await authResp.json();

    const emailFromAuth = (authJson.email || rawEmail).toLowerCase();

    const uid = authJson.localId;

    console.log("[ADMIN-APP] Firebase Auth success:", {
      emailFromAuth,

      uid,
    });

    // 2) Look up user profile in Firestore

    lastStep = "lookup-user-doc";

    console.log("[ADMIN-APP] Looking up Firestore user by email/emailLower...");

    let snap = await db

      .collection("users")

      .where("email", "==", emailFromAuth)

      .limit(1)

      .get();

    if (snap.empty) {
      console.log("[ADMIN-APP] No user by email, trying emailLower...");

      snap = await db

        .collection("users")

        .where("emailLower", "==", emailFromAuth)

        .limit(1)

        .get();
    }

    if (snap.empty) {
      console.warn("[ADMIN-APP] No Firestore user profile for:", emailFromAuth);

      return res.redirect("/login?error=Unauthorized");
    }

    const doc = snap.docs[0];

    const user = doc.data() || {};

    console.log("[ADMIN-APP] Firestore user doc:", {
      id: doc.id,

      email: user.email,

      emailLower: user.emailLower,

      role: user.role,

      branchCodes: user.branchCodes || user.branchCode || null,
    });

    // 3) Require admin role

    if (!["admin", "superadmin"].includes(user.role)) {
      console.warn(
        "[ADMIN-APP] User not admin:",
        emailFromAuth,
        "role=",
        user.role
      );

      return res.redirect("/login?error=Not+authorized");
    }

    // 4) Store session

    req.session.user = {
      uid,

      email: emailFromAuth,

      name: user.name || emailFromAuth,

      role: user.role,
    };

    console.log(
      "[ADMIN-APP] /login success, session user set:",
      req.session.user
    );

    return res.redirect("/dashboard");
  } catch (err) {
    console.error("[ADMIN-APP] Login error at", lastStep, ":", err);

    return res.redirect("/login?error=Server+error");
  }
});

app.post("/logout", (req, res) => {
  console.log("[ADMIN-APP] /logout for", req.session?.user?.email);

  req.session.destroy(() => {
    res.redirect("/login");
  });
});

// ---------------- Routes: Dashboard ----------------

app.get("/dashboard", requireAdmin, async (req, res) => {
  try {
    console.log("[ADMIN-APP] /dashboard for", req.session.user.email);

    const branchesSnap = await db.collection("branches").get();

    const branches = branchesSnap.docs.map((d) => ({
      id: d.id,

      ...d.data(),
    }));

    const today = dayjs().tz("Asia/Manila").format("YYYY-MM-DD");

    res.render("dashboard", {
      user: req.session.user,

      branches,

      today,
    });
  } catch (err) {
    console.error("[ADMIN-APP] Dashboard error", err);

    res.status(500).send("Dashboard error");
  }
});

// ---------------- Routes: Branches ----------------

app.get("/branches", requireAdmin, async (req, res) => {
  try {
    console.log("[ADMIN-APP] /branches for", req.session.user.email);

    const snap = await db.collection("branches").get();

    const branches = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    res.render("branches", {
      user: req.session.user,

      branches,
    });
  } catch (err) {
    console.error("[ADMIN-APP] Branches error", err);

    res.status(500).send("Branches error");
  }
});

app.get("/branches/:id", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;

    console.log(
      "[ADMIN-APP] /branches/:id for",
      req.session.user.email,
      "id=",
      id
    );

    const doc = await db.collection("branches").doc(id).get();

    if (!doc.exists) {
      return res.status(404).send("Branch not found");
    }

    const branch = { id: doc.id, ...doc.data() };

    res.render("branches", {
      user: req.session.user,

      branches: [branch],

      activeBranch: branch,
    });
  } catch (err) {
    console.error("[ADMIN-APP] Branch detail error", err);

    res.status(500).send("Branch detail error");
  }
});

// ---------------- Routes: Users (Admin users listing) ----------------

app.get("/users", requireAdmin, async (req, res) => {
  try {
    console.log("[ADMIN-APP] /users for", req.session.user.email);

    const snap = await db.collection("users").get();

    const users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    res.render("users", {
      user: req.session.user,

      users,
    });
  } catch (err) {
    console.error("[ADMIN-APP] Users error", err);

    res.status(500).send("Users error");
  }
});

// ---------------- Routes: Reports (placeholder) ----------------

app.get("/reports", requireAdmin, async (req, res) => {
  try {
    console.log("[ADMIN-APP] /reports for", req.session.user.email);

    const today = dayjs().tz("Asia/Manila").format("YYYY-MM-DD");

    res.render("reports", {
      user: req.session.user,

      today,
    });
  } catch (err) {
    console.error("[ADMIN-APP] Reports error", err);

    res.status(500).send("Reports error");
  }
});

// ---------------- Routes: QR Codes (placeholder) ----------------

app.get("/qrcodes", requireAdmin, async (req, res) => {
  try {
    console.log("[ADMIN-APP] /qrcodes for", req.session.user.email);

    res.render("qrcodes", {
      user: req.session.user,
    });
  } catch (err) {
    console.error("[ADMIN-APP] QR Codes error", err);

    res.status(500).send("QR Codes error");
  }
});

// ---------------- API: Dashboard Stats ----------------
function manilaDateKey(input) {
  const d = input ? dayjs(input) : dayjs();
  return d.tz("Asia/Manila").format("YYYY-MM-DD");
}

app.get("/api/dashboard", requireAdmin, async (req, res) => {
  try {
    const dateKey = manilaDateKey(req.query.date);
    const snap = await db
      .collection("adminDailyStats")
      .where("dateKey", "==", dateKey)
      .get();

    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Aggregate totals across branches
    const sum = {
      reserved: 0,
      seated: 0,
      skipped: 0,
      waitingNow: { P: 0, A: 0, B: 0, C: 0 },
    };

    for (const r of rows) {
      sum.reserved += Number(r?.totals?.reserved || 0);
      sum.seated += Number(r?.totals?.seated || 0);
      sum.skipped += Number(r?.totals?.skipped || 0);

      const w = r?.waitingNow || {};
      sum.waitingNow.P += Number(w.P || 0);
      sum.waitingNow.A += Number(w.A || 0);
      sum.waitingNow.B += Number(w.B || 0);
      sum.waitingNow.C += Number(w.C || 0);
    }

    return res.json({
      ok: true,
      dateKey,
      totals: sum,
      byBranch: rows.sort((a, b) =>
        String(a.branchCode || "").localeCompare(String(b.branchCode || ""))
      ),
    });
  } catch (err) {
    console.error("[ADMIN-APP] /api/dashboard error", err);
    res.status(500).json({ ok: false, error: "dashboard_error" });
  }
});

// ---------------- Healthcheck ----------------

app.get("/healthz", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ---------------- Start Server ----------------

app.listen(ENV.PORT, () => {
  console.log(
    `[ADMIN-APP] Listening on port ${ENV.PORT} (env: ${ENV.NODE_ENV})`
  );
});
