// Placeholder for future admin-side JS (filters, charts, etc.)
(function () {
  function el(id) { return document.getElementById(id); }
  function fmtTs(ts) {
    try {
      // Firestore Timestamp -> { _seconds } or { seconds } depending on serialization
      var s = (ts && (ts._seconds || ts.seconds)) ? (ts._seconds || ts.seconds) : null;
      if (!s) return '—';
      var d = new Date(s * 1000);
      return d.toLocaleString();
    } catch (e) { return '—'; }
  }

  async function loadDashboard(dateKey) {
    var status = el('dashStatus');
    if (status) status.textContent = 'Loading…';

    var url = '/api/dashboard?date=' + encodeURIComponent(dateKey || '');
    var resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'unknown');

    // KPIs
    el('kpi-reserved').textContent = data.totals.reserved;
    el('kpi-seated').textContent = data.totals.seated;
    el('kpi-skipped').textContent = data.totals.skipped;

    el('kpi-wp').textContent = data.totals.waitingNow.P;
    el('kpi-wa').textContent = data.totals.waitingNow.A;
    el('kpi-wb').textContent = data.totals.waitingNow.B;
    el('kpi-wc').textContent = data.totals.waitingNow.C;

    // Branch table
    var tbody = el('branchTable') && el('branchTable').querySelector('tbody');
    if (tbody) {
      tbody.innerHTML = '';
      if (!data.byBranch || !data.byBranch.length) {
        tbody.innerHTML = '<tr><td colspan="9">No stats found for this date.</td></tr>';
      } else {
        data.byBranch.forEach(function (r) {
          var w = r.waitingNow || {};
          var t = r.totals || {};
          var tr = document.createElement('tr');
          tr.innerHTML =
            '<td>' + (r.branchName || r.branchCode || '-') + '</td>' +
            '<td>' + (t.reserved || 0) + '</td>' +
            '<td>' + (t.seated || 0) + '</td>' +
            '<td>' + (t.skipped || 0) + '</td>' +
            '<td>' + (w.P || 0) + '</td>' +
            '<td>' + (w.A || 0) + '</td>' +
            '<td>' + (w.B || 0) + '</td>' +
            '<td>' + (w.C || 0) + '</td>' +
            '<td>' + fmtTs(r.updatedAt) + '</td>';
          tbody.appendChild(tr);
        });
      }
    }

    if (status) status.textContent = 'Updated: ' + new Date().toLocaleString();
  }

  // Run only on pages that have the dashboard controls
  document.addEventListener('DOMContentLoaded', function () {
    var dateInput = el('dateKey');
    var btn = el('btnRefresh');
    if (!dateInput || !btn) return;

    function refresh() { loadDashboard(dateInput.value).catch(function (e) {
      var s = el('dashStatus'); if (s) s.textContent = 'Error: ' + e.message;
    }); }

    btn.addEventListener('click', refresh);
    refresh();
  });
})();
