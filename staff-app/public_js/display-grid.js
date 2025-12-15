/* display-grid.js
 * Updates the 4 queue cells + next-in-line list + pulse highlight
 */

(function () {
  // ------------------------------
  // AUDIO SETUP + UNLOCK
  // ------------------------------
  var displayCallSound = null;
  var soundEnabled = false;
  var lastCalledCodeSound = { P: null, A: null, B: null, C: null };

 function initDisplaySound() {
  displayCallSound = document.getElementById("display-call-sound");
  var btn = document.getElementById("enable-sound");
  var adPlayer = document.getElementById("adPlayer"); // 🔊 video element

  if (!btn) return;

  btn.addEventListener("click", function () {
    if (!displayCallSound) {
      displayCallSound = document.getElementById("display-call-sound");
      if (!displayCallSound) return;
    }

    // Try a short play/pause to unlock audio
    displayCallSound.currentTime = 0;
    displayCallSound
      .play()
      .then(function () {
        displayCallSound.pause();
        soundEnabled = true;
        window.SOUND_ENABLED = true;

        // 🔊 also unmute the video
        if (adPlayer) {
          adPlayer.muted = false;
          adPlayer.volume = 1.0;
          adPlayer.removeAttribute("muted");
          var p = adPlayer.play();
          if (p && p.catch) p.catch(function () {});
        }

        btn.style.display = "none";
      })
      .catch(function (err) {
        console.warn("[display-grid] Unable to unlock audio:", err);

        // even if chime fails, still mark as enabled & unmute video
        soundEnabled = true;
        window.SOUND_ENABLED = true;

        if (adPlayer) {
          adPlayer.muted = false;
          adPlayer.volume = 1.0;
          adPlayer.removeAttribute("muted");
          var p = adPlayer.play();
          if (p && p.catch) p.catch(function () {});
        }

        btn.style.display = "none";
      });
  });
}



  function playDisplaySound() {
    if (!soundEnabled || !displayCallSound) return;
    try {
      displayCallSound.currentTime = 0;
      displayCallSound.play().catch(function () {});
    } catch (err) {
      console.warn("[display-grid] sound error:", err);
    }
  }

  // ------------------------------
  // JSON API + DOM refs
  // ------------------------------
  var API = window.DISPLAY && window.DISPLAY.apiJson;
  var GROUPS = ["P", "A", "B", "C"];

  if (!API) {
    console.log("[display-grid] No window.DISPLAY.apiJson set");
    return;
  }

  console.log("[display-grid] boot, API:", API);

  var els = {};
  for (var i = 0; i < GROUPS.length; i++) {
    var g = GROUPS[i];
    els[g] = {
      code: document.getElementById("code-" + g),
      sub: document.getElementById("sub-" + g),
      ts: document.getElementById("ts-" + g),
      pulse: document.getElementById("pulse-" + g),
      next: document.getElementById("next-" + g)
    };
    console.log("[display-grid] elements for", g, els[g]);
  }

  var lastState = {};

  function fmtTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  }

  function showPulse(el) {
    if (!el) return;
    el.style.display = "block";
    el.classList.remove("run");
    void el.offsetWidth; // force reflow
    el.classList.add("run");
    setTimeout(function () {
      el.style.display = "none";
    }, 1500);
  }

  // ------------------------------
  // NEXT-IN-LINE LIST
  // ------------------------------
  function updateNextList(group, data) {
    var el = els[group].next;
    if (!el) return;

    el.innerHTML = "";

    var waiting = (data && data.waiting) ? data.waiting.slice(0) : [];
    if (!waiting.length) return;

    waiting.sort(function (a, b) {
      return (a.timestamp || 0) - (b.timestamp || 0);
    });

    for (var i = 0; i < waiting.length && i < 3; i++) {
      var w = waiting[i];
      var li = document.createElement("li");
      li.textContent = w.code;
      el.appendChild(li);
    }
  }

  // ------------------------------
  // UPDATE GROUP CELL
  // ------------------------------
  function updateGroup(group, data) {
    var refs = els[group];
    if (!refs || !refs.code || !refs.sub || !refs.ts) {
      console.warn("[display-grid] Missing DOM refs for group", group);
      return;
    }

    var codeEl = refs.code;
    var subEl = refs.sub;
    var tsEl = refs.ts;
    var pulseEl = refs.pulse;

    var called = data && data.called ? data.called : null;
    var waiting = data && data.waiting ? data.waiting : [];

    console.log("[display-grid] updateGroup", group, {
      called: called,
      waitingCount: waiting.length
    });

    if (called) {
      codeEl.textContent = called.code || "—";
      subEl.textContent =
        (called.name || "") + " • " + (called.pax || 0) + " pax";
      tsEl.textContent = fmtTime(called.updatedAt);
    } else if (waiting.length) {
      codeEl.textContent = "—";
      subEl.textContent = "Waiting…";
      tsEl.textContent = "";
    } else {
      codeEl.textContent = "—";
      subEl.textContent = "";
      tsEl.textContent = "";
    }

    updateNextList(group, data);

    // ---------------------------------
    // PULSE + SOUND ON NEW CALLED CODE
    // ---------------------------------
    var prev = lastState[group];
    var currCode = called ? called.code : "";
    var prevCode = prev ? prev.code : "";

    if (currCode !== prevCode) {
      if (called) showPulse(pulseEl);
      lastState[group] = { code: currCode };
    }

    if (called && currCode && currCode !== lastCalledCodeSound[group]) {
      playDisplaySound();
    }

    lastCalledCodeSound[group] = currCode;
  }

  // ------------------------------
  // FETCH + UPDATE
  // ------------------------------
  function refresh() {
    var url = API + "?t=" + Date.now();
    fetch(url, { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) {
          console.warn("[display-grid] fetch not ok:", r.status, r.statusText);
          return null;
        }
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        console.log("[display-grid] JSON data:", data);

        for (var i = 0; i < GROUPS.length; i++) {
          var g = GROUPS[i];
          var gData = data[g] || { called: null, waiting: [] };
          updateGroup(g, gData);
        }
      })
      .catch(function (err) {
        console.warn("[display-grid] JSON fetch error:", err);
      });
  }

  // ------------------------------
  // CLOCK
  // ------------------------------
  var clockEl = document.getElementById("clock");
  function tickClock() {
    if (clockEl) {
      var d = new Date();
      clockEl.textContent = d.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit"
      });
    }
  }

  // INIT
  initDisplaySound();
  tickClock();
  setInterval(tickClock, 1000);

  refresh();
  setInterval(refresh, 2500);
})();
