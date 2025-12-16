(function () {
  function el(id) { return document.getElementById(id); }

  function setText(id, val) {
    var node = el(id);
    if (node) node.textContent = (val === undefined || val === null) ? '—' : String(val);
  }

  function fmtUpdated(v) {
    if (!v) return '—';
    // Firestore Timestamp can come as {_seconds,_nanoseconds}
    if (typeof v === 'object' && v._seconds) {
      var ms = (v._seconds * 1000) + Math.floor((v._nanoseconds || 0) / 1e6);
      var d = new Date(ms);
      return isNaN(d.getTime()) ? '—' : d.toLocaleString();
    }
    // Already a string/date
    try {
      var d2 = new Date(v);
      if (!isNaN(d2.getTime())) return d2.toLocaleString();
    } catch {}
    return String(v);
  }

  async function fetchDaily(dateKey) {
    var url = '/api/admin/daily-stats?date=' + encodeURIComponent(dateKey) + '&t=' + Date.now();
    var resp = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' }
    });

    // If session expired, server returns JSON 401.
    if (resp.status === 401) {
      window.location.href = '/login';
      return null;
    }

    var ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('application/json') === -1) {
      // This is exactly the "<!DOCTYPE" problem. Show a useful error and force login.
      var text = '';
      try { text = await resp.text(); } catch {}
      console.error('[admin] Expected JSON, got:', ct, 'body:', text.slice(0, 200));
      window.location.href = '/login';
      return null;
    }

    return await resp.json();
  }

  function render(data) {
    if (!data || !data.ok) return;

    // KPIs
    setText('kpi-reserved', data.totals && data.totals.reserved);
    setText('kpi-seated', data.totals && data.totals.seated);
    setText('kpi-skipped', data.totals && data.totals.skipped);

    var w = (data.totals && data.totals.waitingNow) || {};
    setText('kpi-wp', w.P || 0);
    setText('kpi-wa', w.A || 0);
    setText('kpi-wb', w.B || 0);
    setText('kpi-wc', w.C || 0);

    // By Branch table
    var tbody = el('branchTable') ? el('branchTable').querySelector('tbody') : null;
    if (!tbody) return;

    var rows = data.byBranch || [];
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="9">No data for this date.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    for (var i = 0; i < rows.length; i++) {
      var b = rows[i] || {};
      var totals = b.totals || {};
      var waiting = b.waitingNow || {};

      var tr = document.createElement('tr');

      function td(txt) {
        var x = document.createElement('td');
        x.textContent = (txt === undefined || txt === null) ? '—' : String(txt);
        return x;
      }

      tr.appendChild(td(b.branchName || b.branchCode || b.id || '—'));
      tr.appendChild(td(totals.reserved || b['totals.reserved'] || 0));
      tr.appendChild(td(totals.seated || 0));
      tr.appendChild(td(totals.skipped || 0));
      tr.appendChild(td(waiting.P || 0));
      tr.appendChild(td(waiting.A || 0));
      tr.appendChild(td(waiting.B || 0));
      tr.appendChild(td(waiting.C || 0));
      tr.appendChild(td(fmtUpdated(b.updatedAt)));

      tbody.appendChild(tr);
    }
  }

  async function refresh() {
    var dateInput = el('dateKey');
    var dateKey = dateInput ? dateInput.value : (el('dk') ? el('dk').textContent : '');

    setText('dashStatus', 'Refreshing…');
    try {
      var data = await fetchDaily(dateKey);
      if (!data) return;

      render(data);

      // status line
      var stamp = new Date();
      setText('dashStatus', 'Updated: ' + stamp.toLocaleString());
    } catch (e) {
      console.error('[admin] refresh failed:', e);
      setText('dashStatus', 'Refresh failed. Check console.');
    }
  }

  function boot() {
    var btn = el('btnRefresh');
    if (btn) btn.addEventListener('click', function () { refresh(); });

    // auto-refresh every 15s (optional)
    // setInterval(refresh, 15000);

    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
