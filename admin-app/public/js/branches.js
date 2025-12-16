(function () {
  function el(id) { return document.getElementById(id); }
  function setText(id, val) {
    var node = el(id);
    if (node) node.textContent = (val === undefined || val === null) ? '—' : String(val);
  }

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

  async function apiList() {
    var resp = await fetch('/api/admin/branches?t=' + Date.now(), {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' }
    });
    if (resp.status === 401) { window.location.href = '/login'; return null; }
    return await resp.json();
  }

  async function apiSave(payload) {
    var resp = await fetch('/api/admin/branches?t=' + Date.now(), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (resp.status === 401) { window.location.href = '/login'; return null; }
    return await resp.json();
  }

  async function apiDelete(code) {
    var resp = await fetch('/api/admin/branches/' + encodeURIComponent(code) + '?t=' + Date.now(), {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    });
    if (resp.status === 401) { window.location.href = '/login'; return null; }
    return await resp.json();
  }

  function renderTable(branches) {
    var table = el('branchesTable');
    var tbody = table ? table.querySelector('tbody') : null;
    if (!tbody) return;

    if (!branches || !branches.length) {
      tbody.innerHTML = '<tr><td colspan="5">No branches found.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    branches.forEach(function (b) {
      var code = (b.branchCode || b.code || b.id || '').toString();
      var name = (b.name || b.branchName || '').toString();
      var slug = (b.slug || '').toString();

      var tr = document.createElement('tr');

      function td(txt) {
        var x = document.createElement('td');
        x.textContent = (txt === undefined || txt === null) ? '—' : String(txt);
        return x;
      }

      tr.appendChild(td(code));
      tr.appendChild(td(name));
      tr.appendChild(td(slug));
      tr.appendChild(td(fmtUpdated(b.updatedAt)));

      var actions = document.createElement('td');

      var btnEdit = document.createElement('button');
      btnEdit.className = 'btn btn-ghost';
      btnEdit.textContent = 'Edit';
      btnEdit.addEventListener('click', function () {
        el('branchCode').value = code;
        el('branchName').value = name;
        el('branchSlug').value = slug;
        setText('branchStatus', 'Loaded into form.');
      });

      var btnDel = document.createElement('button');
      btnDel.className = 'btn btn-ghost';
      btnDel.textContent = 'Delete';
      btnDel.addEventListener('click', async function () {
        if (!confirm('Delete branch ' + code + '?')) return;
        setText('branchStatus', 'Deleting…');
        try {
          var out = await apiDelete(code);
          if (!out || !out.ok) throw new Error(out && out.error ? out.error : 'Delete failed');
          setText('branchStatus', 'Deleted: ' + code);
          await reload();
        } catch (e) {
          console.error(e);
          setText('branchStatus', 'Delete failed. Check console.');
        }
      });

      actions.appendChild(btnEdit);
      actions.appendChild(btnDel);

      tr.appendChild(actions);
      tbody.appendChild(tr);
    });
  }

  async function reload() {
    setText('branchStatus', 'Loading…');
    try {
      var data = await apiList();
      if (!data || !data.ok) throw new Error((data && data.error) || 'List failed');
      renderTable(data.branches || []);
      setText('branchStatus', 'Updated: ' + new Date().toLocaleString());
    } catch (e) {
      console.error(e);
      setText('branchStatus', 'Load failed. Check console.');
    }
  }

  async function save() {
    var code = (el('branchCode').value || '').trim().toUpperCase();
    var name = (el('branchName').value || '').trim();
    var slug = (el('branchSlug').value || '').trim().toLowerCase();

    if (!code) return setText('branchStatus', 'Branch Code is required.');
    if (!name) return setText('branchStatus', 'Branch Name is required.');

    setText('branchStatus', 'Saving…');
    try {
      var out = await apiSave({ branchCode: code, name: name, slug: slug });
      if (!out || !out.ok) throw new Error(out && out.error ? out.error : 'Save failed');
      setText('branchStatus', 'Saved: ' + code);
      await reload();
    } catch (e) {
      console.error(e);
      setText('branchStatus', 'Save failed. Check console.');
    }
  }

  function boot() {
    var btnSave = el('btnSaveBranch');
    if (btnSave) btnSave.addEventListener('click', save);

    var btnReload = el('btnReloadBranches');
    if (btnReload) btnReload.addEventListener('click', reload);

    reload();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
