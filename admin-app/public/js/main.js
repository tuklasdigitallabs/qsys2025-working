/* admin-app/public/js/main.js
 * Dashboard data loader + renderer (cache-busted)
 * Expects dashboard.ejs IDs:
 *  - kpi-reserved, kpi-seated, kpi-skipped
 *  - kpi-wp, kpi-wa, kpi-wb, kpi-wc
 *  - dk, dateKey, btnRefresh, dashStatus, branchTable
 */

(function () {
  function $(id) { return document.getElementById(id); }

  function setText(id, val) {
    var el = $(id);
    if (!el) {
      console.warn('[admin] missing element id:', id);
      return;
    }
    el.textContent = (val === null || val === undefined) ? '—' : String(val);
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function normalizeDateKey(v) {
    if (!v) return null;
    // input[type=date] should be YYYY-MM-DD already
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;

    var d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function fmtUpdated(u) {
    try {
      if (!u) return '';
      if (typeof u === 'string') return u;
      if (typeof u._seconds === 'number') return new Date(u._seconds * 1000).toLocaleString();
      if (typeof u.seconds === 'number') return new Date(u.seconds * 1000).toLocaleString();
      return '';
    } catch {
      return '';
    }
  }

  function renderBranchTable(byBranch) {
    var table = $('branchTable');
    if (!table) return;

    var tbody = table.querySelector('tbody');
    if (!tbody) return;

    var rows = [];
    (byBranch || []).forEach(function (b) {
      var totals = b.totals || {};
      var wn = b.waitingNow || {};
      rows.push(
        '<tr>' +
          '<td>' + (b.branchName || b.branchCode || '—') + '</td>' +
          '<td>' + (totals.reserved ?? totals["totals.reserved"] ?? b["totals.reserved"] ?? 0) + '</td>' +
          '<td>' + (totals.seated ?? 0) + '</td>' +
          '<td>' + (totals.skipped ?? 0) + '</td>' +
          '<td>' + (wn.P ?? 0) + '</td>' +
          '<td>' + (wn.A ?? 0) + '</td>' +
          '<td>' + (wn.B ?? 0) + '</td>' +
          '<td>' + (wn.C ?? 0) + '</td>' +
          '<td>' + fmtUpdated(b.updatedAt) + '</td>' +
        '</tr>'
      );
    });

    tbody.innerHTML = rows.length
      ? rows.join('')
      : '<tr><td colspan="9">No data</td></tr>';
  }

  async function fetchDaily(dateKey) {
    // IMPORTANT: cache-bust every request
    var url = '/api/admin/daily-stats?date=' + encodeURIComponent(dateKey) + '&t=' + Date.now();
    console.log('[admin] GET', url);

    var resp = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
    var json = await resp.json();
    if (!resp.ok || !json.ok) throw new Error(json.error || ('HTTP ' + resp.status));
    return json;
  }

  function render(data) {
    // Update “Date (Manila)” label
    setText('dk', data.dateKey || '—');

    var totals = data.totals || {};
    var wn = totals.waitingNow || {};

    setText('kpi-reserved', totals.reserved ?? 0);
    setText('kpi-seated', totals.seated ?? 0);
    setText('kpi-skipped', totals.skipped ?? 0);

    setText('kpi-wp', wn.P ?? 0);
    setText('kpi-wa', wn.A ?? 0);
    setText('kpi-wb', wn.B ?? 0);
    setText('kpi-wc', wn.C ?? 0);

    renderBranchTable(data.byBranch || []);

    var status = 'Updated: ' + (new Date()).toLocaleString();
    // If backend provides updatedAt on first branch, show that too
    try {
      var b0 = (data.byBranch && data.byBranch[0]) ? data.byBranch[0] : null;
      if (b0 && b0.updatedAt) status = 'Updated: ' + fmtUpdated(b0.updatedAt);
    } catch {}
    setText('dashStatus', status);
  }

  async function refresh() {
    try {
      var input = $('dateKey');
      var dateKey = normalizeDateKey(input ? input.value : null) || todayKey();

      // keep input consistent
      if (input && input.value !== dateKey) input.value = dateKey;

      setText('dashStatus', 'Loading…');

      var data = await fetchDaily(dateKey);
      console.log('[admin] payload', data);
      render(data);
    } catch (e) {
      console.error('[admin] refresh failed:', e);
      setText('dashStatus', 'Error: ' + (e.message || e));
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = $('btnRefresh');
    if (btn) btn.addEventListener('click', function (ev) { ev.preventDefault(); refresh(); });

    // first load + auto refresh
    refresh();
    setInterval(refresh, 15000);
  });
})();
