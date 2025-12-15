// /public_js/staff.live.js
// Client Firestore listener for staff panel (uses server-minted custom token with role claim).
// Expects window.FIREBASE_CONFIG and window.STAFF_CUSTOM_TOKEN to be defined in the page.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import { getAuth, signInWithCustomToken, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import { getFirestore, collection, query, where, orderBy, onSnapshot } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

(function(){
  const root = document.getElementById("staff-root") || document.querySelector("[data-branch]");
  if (!root) return; // Not on staff page

  const cfg = window.FIREBASE_CONFIG;
  const token = window.STAFF_CUSTOM_TOKEN;
  if (!cfg || !cfg.projectId) { console.error("[staff.live] Missing FIREBASE_CONFIG"); return; }
  if (!token) { console.error("[staff.live] Missing STAFF_CUSTOM_TOKEN"); return; }

  const app  = initializeApp(cfg);
  const auth = getAuth(app);
  const db   = getFirestore(app);

  const branch = (root.dataset.branch || "YL-MOA").toUpperCase();

  // Manila date (YYYY-MM-DD)
  const DEFAULT_TZ = "Asia/Manila";
  function ymdInTZ(tz = DEFAULT_TZ) {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const p = fmt.formatToParts(new Date());
    const y = p.find(x=>x.type==="year").value;
    const m = p.find(x=>x.type==="month").value;
    const d = p.find(x=>x.type==="day").value;
    return `${y}-${m}-${d}`;
  }
  const today = ymdInTZ();

  // Already-rendered ticket ids to avoid noisy reloads
  function currentDomTicketIds() {
    return new Set([...document.querySelectorAll(".item[data-ticket]")].map(el => el.dataset.ticket));
  }
  let seen = currentDomTicketIds();

  let reloadTimer = null;
  function softReloadSoon() {
    if (reloadTimer) return;
    reloadTimer = setTimeout(() => location.reload(), 350);
  }

  function attachListeners() {
    ["A","B","C"].forEach(group => {
      const ref = collection(db, "queues", branch, today, group, "items");
      const q = query(ref, where("status","in",["waiting","called"]), orderBy("timestamp","asc"));
      onSnapshot(q, snap => {
        for (const d of snap.docs) {
          if (!seen.has(d.id)) { softReloadSoon(); return; }
        }
      }, err => {
        // Common errors: PERMISSION_DENIED (rules), FAILED_PRECONDITION (index needed)
        console.warn("[staff.live] onSnapshot error:", err?.message || err);
      });
    });
  }

  // Sign in with server-minted custom token (has role claim required by your rules)
  onAuthStateChanged(auth, (u) => {
    if (u) return attachListeners();
    signInWithCustomToken(auth, token)
      .then(() => attachListeners())
      .catch(err => console.error("[staff.live] signInWithCustomToken failed:", err?.message || err));
  });
})();