(function () {
  const cfg = window.QSYS_TICKET || {};
  if (!cfg.firebaseConfig || !cfg.firebaseConfig.apiKey) {
    console.warn('[ticket-rt] Missing firebaseConfig, realtime disabled.');
    return;
  }

  const branchCode = cfg.branchCode;
  const dateKey    = cfg.date;
  const group      = cfg.group;
  const ticketId   = cfg.ticketId;

  // DOM elements
  const elNow  = document.getElementById('js-now-serving');
  const elPos  = document.getElementById('js-position');
  const elTot  = document.getElementById('js-total');
  const elEta  = document.getElementById('js-eta');

  try {
    firebase.initializeApp(cfg.firebaseConfig);
  } catch (e) {
    if (!/already exists/i.test(e.message)) {
      console.error('[ticket-rt] firebase init error:', e);
      return;
    }
  }

  const db = firebase.firestore();
  console.log('[ticket-rt] Realtime listeners starting:', {
    branchCode, dateKey, group, ticketId
  });

  const AVG_MIN_PER_TICKET = { P: 10, A: 15, B: 20, C: 25 };

  // 1) Listen to nowServing for this group
  db.doc(`queues/${branchCode}/nowServing/${group}`)
    .onSnapshot(function (snap) {
      let code = '—';
      if (snap.exists) {
        const d = snap.data() || {};
        if (d.code) code = d.code;
      }
      if (elNow) elNow.textContent = code;
      console.log('[ticket-rt] nowServing update:', code);
    }, function (err) {
      console.error('[ticket-rt] nowServing listener error:', err);
    });

  // 2) Listen to the group items to recompute position / total / ETA
  db.collection(`queues/${branchCode}/${dateKey}/${group}/items`)
    .orderBy('timestamp', 'asc')
    .onSnapshot(function (snap) {
      let pos = 0;
      let total = 0;

      snap.forEach(function (doc) {
        const d = doc.data() || {};
        const status = String(d.status || '').toLowerCase();

        const finished =
          status === 'done' ||
          status === 'finished' ||
          status === 'complete' ||
          status === 'completed' ||
          status === 'skipped' ||
          status === 'seated' ||
          status === 'cancelled' ||
          status === 'canceled';

        if (!finished) {
          total++;
          if (doc.id === ticketId) {
            pos = total;
          }
        }
      });

      if (!pos && total) pos = total;

      if (elPos) elPos.textContent = pos || '—';
      if (elTot) elTot.textContent = total || '—';

      const perTicket = AVG_MIN_PER_TICKET[group] || 15;
      const eta = pos ? pos * perTicket : total * perTicket;
      if (elEta) elEta.textContent = eta || '—';

      console.log('[ticket-rt] group snapshot:', {
        pos, total, eta
      });
    }, function (err) {
      console.error('[ticket-rt] group listener error:', err);
    });
})();
