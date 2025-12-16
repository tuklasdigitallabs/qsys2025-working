(function () {
  function el(id) { return document.getElementById(id); }

  function fmtUpdated(v) {
    if (!v) return '—';
    if (typeof v === 'object' && v._seconds) {
      var ms = (v._seconds * 1000) + Math.floor((v._nanoseconds || 0) / 1e6);
      var d = new Date(ms);
      return isNaN(d.getTime()) ? '—' : d.toLocaleString();
    }
    try {
      var d2 = new Date(v);
      if (!isNaN(d2.getTime())) return d2.toLocaleString();
    } catch {}
    return String(v);
  }

  /* ---------------- Toast ---------------- */
  function toast(msg, type) {
    var wrap = el('toastWrap');
    if (!wrap) return;

    var box = document.createElement('div');
    box.textContent = msg;
    box.style.padding = '10px 12px';
    box.style.borderRadius = '12px';
    box.style.boxShadow = '0 8px 24px rgba(0,0,0,.12)';
    box.style.background = '#fff';
    box.style.border = '1px solid rgba(0,0,0,.08)';
    box.style.fontWeight = '600';
    box.style.maxWidth = '360px';

    if (type === 'success') box.style.borderColor = 'rgba(0,160,80,.35)';
    if (type === 'error')   box.style.borderColor = 'rgba(200,0,0,.35)';
    if (type === 'info')    box.style.borderColor = 'rgba(30,90,200,.25)';

    wrap.appendChild(box);
    setTimeout(function () {
      try { wrap.removeChild(box); } catch {}
    }, 3500);
  }

  /* ---------------- Form ---------------- */
  function setForm(b) {
    el('f-code').value = (b.branchCode || '').toUpperCase();
    el('f-name').value = b.branchName || '';
    el('f-slug').value = b.slug || '';
    el('f-location').value = b.location || '';
    el('f-active').value = (b.active === false) ? 'false' : 'true';
    el('lastUpdated').textContent = 'Updated: ' + fmtUpdated(b.updatedAt);
  }

  function clearForm() {
    el('f-code').value = '';
    el('f-name').value = '';
    el('f-slug').value = '';
    el('f-location').value = '';
    el('f-active').value = 'true';
    el('lastUpdated').textContent = '—';
  }

  function getPayload() {
    return {
      branchCode: (el('f-code').value || '').trim().toUpperCase(),
      branchName: (el('f-name').value || '').trim(),
      slug: (el('f-slug').value || '').trim().toLowerCase(),
      location: (el('f-location').value || '').trim(),
      active: (el('f-active').value || 'true') !== 'false'
    };
  }

  /* ---------------- API ---------------- */
  async function apiSave(payload) {
    var resp = await fetch('/api/admin/branches/save?t=' + Date.now(), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (resp.status === 401) {
      window.location.href = '/login';
      return null;
    }

    var json = await resp.json();
    if (!resp.ok || !json.ok) {
      throw new Error(json.error || 'Save failed');
    }
    return json;
  }

  async function apiReload() {
    var resp = await fetch('/api/admin/branches?t=' + Date.now(), {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' }
    });

    if (resp.status === 401) {
      window.location.href = '/login';
      return null;
    }

    var json = await resp.json();
    if (!resp.ok || !json.ok) throw new Error(json.error || 'Reload failed');
    return json.branches || [];
  }

  /* ---------------- Table Rendering ---------------- */
  function renderTable(branches) {
    var table = el('branchesTable');
    if (!table) return;
    var tbody = table.querySelector('tbody');
    if (!tbody) return;

    if (!branches.length) {
      tbody.innerHTML = '<tr><td colspan="6">No branches found.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    branches.sort(function (a, b) {
      return String(a.branchName || '').localeCompare(String(b.branchName || ''));
    });

    for (var i = 0; i < branches.length; i++) {
      var b = branches[i] || {};
      var tr = document.createElement('tr');
      tr.className = 'branch-row';
      tr.tabIndex = 0;

      var packed = {
        branchCode: (b.branchCode || b.code || b.id || '').toUpperCase(),
        branchName: b.branchName || b.name || '',
        slug: b.slug || '',
        location: b.location || '',
        active: (b.active === false) ? false : true,
        updatedAt: b.updatedAt || null
      };
      tr.dataset.branch = JSON.stringify(packed);

      function td(txt) {
        var x = document.createElement('td');
        x.textContent = (txt === undefined || txt === null || txt === '') ? '—' : String(txt);
        return x;
      }

      tr.appendChild(td(packed.branchCode));
      tr.appendChild(td(packed.branchName));
      tr.appendChild(td(packed.slug));
      tr.appendChild(td(packed.active ? 'Yes' : 'No'));
      tr.appendChild(td(fmtUpdated(packed.updatedAt)));

      /* ---- ACTION COLUMN (DELETE) ---- */
      var tdAction = document.createElement('td');

      var form = document.createElement('form');
      form.method = 'post';
      form.action = '/branches/delete';
      form.onsubmit = function () {
        return confirm(
          'Delete branch ' + packed.branchCode + '?\n\n' +
          'This will NOT delete historical queue or report data.\n' +
          'An audit log will be recorded.'
        );
      };

      var hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = 'branchCode';
      hidden.value = packed.branchCode;

      var btn = document.createElement('button');
      btn.type = 'submit';
      btn.textContent = 'Delete';
      btn.className = 'btn btn-danger btn-sm';
      btn.onclick = function (e) {
        e.stopPropagation(); // critical: prevent row edit
      };

      form.appendChild(hidden);
      form.appendChild(btn);
      tdAction.appendChild(form);
      tr.appendChild(tdAction);

      tbody.appendChild(tr);
    }

    bindRowClicks();
  }

  /* ---------------- Row Click ---------------- */
  function bindRowClicks() {
    var rows = document.querySelectorAll('.branch-row');
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        function act() {
          try {
            var b = JSON.parse(row.dataset.branch || '{}');
            setForm(b);
            toast('Loaded branch: ' + (b.branchCode || ''), 'info');
          } catch (e) {
            console.error('row parse error', e);
          }
        }
        row.addEventListener('click', act);
        row.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            act();
          }
        });
      })(rows[i]);
    }
  }

  /* ---------------- Events ---------------- */
  async function onSave(ev) {
    ev.preventDefault();

    var payload = getPayload();
    if (!payload.branchCode || !payload.branchName) {
      toast('Branch Code and Branch Name are required.', 'error');
      return;
    }

    if (!confirm('Save branch ' + payload.branchCode + '?')) return;

    try {
      await apiSave(payload);
      toast('Saved: ' + payload.branchCode, 'success');

      var branches = await apiReload();
      renderTable(branches);
      el('lastUpdated').textContent = 'Updated: just now';
    } catch (e) {
      console.error(e);
      toast('Error: ' + (e.message || e), 'error');
    }
  }

  async function onReload() {
    try {
      var branches = await apiReload();
      renderTable(branches);
      toast('Branches reloaded.', 'success');
    } catch (e) {
      console.error(e);
      toast('Reload error: ' + (e.message || e), 'error');
    }
  }

  function boot() {
    var form = el('branchForm');
    if (form) form.addEventListener('submit', onSave);

    var btnClear = el('btnClear');
    if (btnClear) btnClear.addEventListener('click', function () {
      clearForm();
      toast('Cleared form.', 'info');
    });

    var btnReload = el('btnReload');
    if (btnReload) btnReload.addEventListener('click', onReload);

    bindRowClicks();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
