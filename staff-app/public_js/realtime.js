// public_js/realtime.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js";
import {
  getAuth, signInWithCustomToken
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js";
import {
  getFirestore, collection, query, orderBy, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";

const cfg = window.FIREBASE_WEB_CONFIG;
const app = initializeApp(cfg);
const auth = getAuth(app);
const db = getFirestore(app);

const { branchCode, dayKey, customToken, queueNumberWidth = 2 } = window.QSYS_STAFF || {};
const GROUPS = ["P","A","B","C"];

// Utilities
const pad = (n, w=2) => String(n ?? "").padStart(w, "0");
const escape = (s) => String(s ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

// Build one <li> item HTML from a document
// Build one <li> item HTML from a document
function renderItem(doc, group) {
  const t = doc.data();
  const id = doc.id;
  const rawNum = t.queueNum ?? t.number ?? t.queueNumber ?? null;
  const num = (rawNum !== null && rawNum !== undefined) ? pad(rawNum, queueNumberWidth) : "--";
  const code = `${group}${num}`;
  const status = String(t.status || "waiting").toUpperCase();
  const startMs =
    (t.createdAt && typeof t.createdAt.toMillis === "function" && t.createdAt.toMillis()) ||
    (t.timestamp && typeof t.timestamp.toMillis === "function" && t.timestamp.toMillis()) ||
    Date.now();

  const calledCls = status === "CALLED" ? " called" : "";
  const pBadge = group === "P" ? '<span class="badge called">P</span>' : "";

  return `
    <li class="item${calledCls}" data-id="${escape(id)}" data-group="${escape(group)}">
      <div class="row select">
        <span class="code">#${escape(code)}</span>
        <span class="name">${escape(t.name || "Guest")}</span>
        <span class="pax">(${escape(t.pax || 1)} pax)</span>
        ${pBadge}
        <span class="badge status">${escape(status)}</span>
      </div>
      <div class="row timer-row">
        <span class="timer" data-start="${Number(startMs)}"></span>
      </div>
      <div class="actions" style="margin-top:10px; display:flex; gap:8px;">
        <button class="btn call" data-action="call">Call</button>
        <button class="btn seat" data-action="seat">Seat</button>
        <button class="btn skip" data-action="skip">Skip</button>
      </div>
    </li>
  `;
}


// Replace a group's list in-place (no reload, no flicker)
function updateGroupUI(group, docs) {
  const column = document.querySelector(`.group-column[data-group="${group}"]`);
  if (!column) return;

  // empty placeholder
  const emptyEl = column.querySelector(".empty");
  const listEl = column.querySelector(".list");

  // filter statuses we show
  const items = [];
  docs.forEach(d => {
    const s = String((d.data()?.status) || "waiting");
    if (["waiting","called"].includes(s)) items.push(d);
  });

  if (items.length === 0) {
    if (listEl) listEl.innerHTML = "";
    if (emptyEl) emptyEl.style.display = "block";
    else {
      const div = document.createElement("div");
      div.className = "empty";
      div.textContent = "No guests in this group.";
      column.insertBefore(div, listEl);
    }
    return;
  }

  if (emptyEl) emptyEl.style.display = "none";

  // build HTML
  const html = items.map(d => renderItem(d, group)).join("");
  if (listEl) listEl.innerHTML = html;

  // Timers will be picked up by staff.js interval; trigger a microtask to ensure immediate paint
  queueMicrotask(() => {
    // dispatch an event in case other scripts want to hook into updates
    document.dispatchEvent(new CustomEvent("qsys:group-updated", { detail: { group, count: items.length } }));
  });
}

(async () => {
  try {
    if (customToken) {
      await signInWithCustomToken(auth, customToken);
      console.log("[Realtime] Signed in with custom token");
    } else {
      console.warn("[Realtime] No custom token; Firestore rules may block reads");
    }

    // Attach listeners per group and update DOM in-place
    for (const g of GROUPS) {
      const q = query(
        collection(db, `queues/${branchCode}/${dayKey}/${g}/items`),
        orderBy("timestamp", "asc")
      );
      onSnapshot(q, (snap) => {
        updateGroupUI(g, snap.docs);
      }, (err) => {
        console.error("[Realtime] snapshot error:", err);
      });
    }
  } catch (err) {
    console.error("[Realtime] init error:", err);
  }
})();
