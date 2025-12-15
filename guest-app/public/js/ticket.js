(function () {
  function initTicketPolling() {
    const body = document.body;
    if (!body) return;

    const branch = body.dataset.branch;
    const date = body.dataset.date;
    const group = body.dataset.group;
    const id = body.dataset.id;

    if (!branch || !date || !group || !id) {
      console.warn('[ticket.js] Missing data-* attributes, skipping polling.');
      return;
    }

    const posEl = document.getElementById('pos-value');
    const totalEl = document.getElementById('total-value');
    const etaEl = document.getElementById('eta-value');
    const nowServingEl = document.getElementById('now-serving-value');

    const endpoint = `/api/ticket-status/${encodeURIComponent(branch)}/${encodeURIComponent(
      date
    )}/${encodeURIComponent(group)}/${encodeURIComponent(id)}`;

    console.log('[ticket.js] Polling endpoint:', endpoint);

    function applyStatus(data) {
      if (posEl && typeof data.positionInGroup === 'number') {
        posEl.textContent = data.positionInGroup;
      }
      if (totalEl && typeof data.totalInGroup === 'number') {
        totalEl.textContent = data.totalInGroup;
      }
      if (etaEl && typeof data.etaMinutes === 'number') {
        etaEl.textContent = data.etaMinutes;
      }
      if (nowServingEl && typeof data.nowServingCode !== 'undefined') {
        nowServingEl.textContent = data.nowServingCode || '—';
      }
    }

        async function fetchStatus() {
      try {
        const res = await fetch(endpoint, { cache: 'no-store' });
        if (!res.ok) {
          console.warn('[ticket.js] status fetch failed:', res.status);
          if (res.status === 404) {
            console.warn('[ticket.js] Ticket not found, stopping polling.');
            clearInterval(intervalId);
          }
          return;
        }
        const json = await res.json();
        if (!json.ok) {
          console.warn('[ticket.js] API returned not ok:', json);
          return;
        }

        console.log('[ticket.js] Fetched status:', json);  // <-- add this
        applyStatus(json);
      } catch (err) {
        console.error('[ticket.js] Error fetching ticket status:', err);
      }
    }

    // Initial fetch, then poll every 10s
    fetchStatus();
    const intervalId = setInterval(fetchStatus, 10000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTicketPolling);
  } else {
    initTicketPolling();
  }
})();
