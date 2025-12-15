// public_js/staff.js
(function () {
  var root = document.getElementById('staff-root');
  if (!root) return;

  var branchCode = root.getAttribute('data-branch') || '';
  var baseUrl = '/staff/' + encodeURIComponent(branchCode);
  var TICK_INTERVAL = 1000;
  var openItem = null;

  // ---- utils ----
  function pad2(n){ return (n<10?'0':'')+n; }
  function fmt(ms){
    var s = Math.floor(ms/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60), d=s%60;
    return h>0 ? (pad2(h)+':'+pad2(m)+':'+pad2(d)) : (pad2(m)+':'+pad2(d));
  }
  function tick(){
    var now=Date.now(), els=document.querySelectorAll('.timer[data-start]');
    for(var i=0;i<els.length;i++){
      var st=Number(els[i].getAttribute('data-start')||0);
      if(st) els[i].textContent = fmt(now-st);
    }
  }

  function setStatus(li, status){ // status = 'CALLED' | 'WAITING' (display text)
    var badge = li.querySelector('.badge.status');
    if (badge) badge.textContent = status;
    if (status === 'CALLED') li.classList.add('called');
    else li.classList.remove('called');
  }

  function optimisticSwitchCalled(targetLi){
    var group = targetLi.getAttribute('data-group');
    // remove CALLED from others in same group
    var others = document.querySelectorAll('li.item[data-group="'+group+'"].called');
    for (var i=0;i<others.length;i++){
      if (others[i] !== targetLi) setStatus(others[i], 'WAITING');
    }
    // set target to CALLED
    setStatus(targetLi, 'CALLED');
  }

  function optimisticToggleOff(targetLi){
    setStatus(targetLi, 'WAITING');
  }

  function postJson(url, payload) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      credentials: 'same-origin'   // send session cookies, fixes many “HTML login page” cases
    }).then(async function (r) {
      var contentType = r.headers.get('content-type') || '';
      var text = await r.text();

      if (!r.ok) {
        console.error('Server error on', url, r.status, text);
        throw new Error('Server error ' + r.status + ' on ' + url + ':\n' + text.slice(0, 200));
      }

      if (contentType.indexOf('application/json') === -1) {
        console.error('Non-JSON response from', url, contentType, text);
        throw new Error('Non-JSON response from ' + url + ':\n' + text.slice(0, 200));
      }

      try {
        return JSON.parse(text);
      } catch (e) {
        console.error('Bad JSON from', url, text);
        throw new Error('Invalid JSON from server on ' + url);
      }
    });
  }

  function doAction(type, group, ticketId, li){
    if (type === 'call') {
      var isCalled = (li.classList.contains('called') ||
                      (li.querySelector('.badge.status') &&
                       String(li.querySelector('.badge.status').textContent||'').toUpperCase()==='CALLED'));

      return postJson('/api/call', {
        branch: branchCode,
        group: group,
        id: ticketId,
        toggle: true
      }).then(function(out){
        if (!out || !out.ok) throw new Error((out && out.error) || 'Call failed');

        // Optimistic UI
        if (isCalled) {
          // CALLED → WAITING (uncall) – no sound
          optimisticToggleOff(li);
        } else {
          // WAITING → CALLED – play sound
          optimisticSwitchCalled(li);
          playCallSound(); // 🔊 only here
        }
      });
    }
    // seat/skip
    return fetch(baseUrl + '/' + type + '/' + group + '/' + ticketId, { method:'POST' })
      .then(function(r){ return r.json(); })
      .then(function(out){
        if (!out || !out.ok) throw new Error((out && out.error) || ('Failed to ' + type));
      });
  }

  // click wiring
  root.addEventListener('click', function(e){
    var btn = e.target.closest && e.target.closest('button[data-action]');
    var li  = e.target.closest && e.target.closest('li.item');

    if (li && !btn) {
      if (openItem && openItem!==li) openItem.classList.remove('open');
      var nowOpen=!li.classList.contains('open');
      if (nowOpen){ li.classList.add('open'); openItem=li; }
      else { li.classList.remove('open'); openItem=null; }
      var act=li.querySelector('.actions'); if (act) act.style.display = nowOpen ? 'flex' : 'none';
      return;
    }

    if (btn && li){
      var id    = li.getAttribute('data-id');
      var group = li.getAttribute('data-group');
      var act   = btn.getAttribute('data-action');
      if (!id || !group || !act) return;

      doAction(act, group, id, li).catch(function(err){
        alert(err && err.message ? err.message : ('Failed to ' + act));
      });
    }
  });

  // init
  (function init(){
    var acts=document.querySelectorAll('.item .actions');
    for (var i=0;i<acts.length;i++) acts[i].style.display='none';
    setInterval(tick, 1000);
  })();
})();

// External Display opener (kept same)
(function () {
  function getBranch(){ var r=document.getElementById('staff-root'); return r? (r.getAttribute('data-branch')||'') : ''; }
  function url(b){ return b?('/display/'+encodeURIComponent(b)):'/display'; }
  function openExt(u){
    var w=(screen && (screen.availWidth||screen.width))||1280, h=(screen && (screen.availHeight||screen.height))||720;
    var f='menubar=0,toolbar=0,location=0,status=0,scrollbars=0,resizable=1,noopener,noreferrer,left=0,top=0,width='+w+',height='+h;
    var win=null; try{ win=window.open(u,'QSysExternal_'+Date.now(),f); }catch(e){}
    if(!win||win.closed){ window.location.href=u; return; }
    try{win.moveTo(0,0);}catch(e1){}
    try{win.resizeTo(screen.availWidth,screen.availHeight);}catch(e2){}
    try{win.focus();}catch(e3){}
  }
  function wire(){
    var btn=document.getElementById('open-display'); if(!btn) return;
    btn.addEventListener('click', function(e){
      var u=url(getBranch());
      var w=null;
      try{
        var W=screen.availWidth||1280,H=screen.availHeight||720;
        w=window.open(u,'QSysExternal_'+Date.now(),'menubar=0,toolbar=0,location=0,status=0,scrollbars=0,resizable=1,noopener,noreferrer,left=0,top=0,width='+W+',height='+H);
      }catch(_){}
      if(w && !w.closed){ e.preventDefault(); try{w.moveTo(0,0); w.resizeTo(screen.availWidth,screen.availHeight); w.focus();}catch(_){}} 
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();

document.addEventListener('DOMContentLoaded', () => {
  const tabs  = Array.from(document.querySelectorAll('.group-tab'));
  const views = Array.from(document.querySelectorAll('.group-view'));

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const g = tab.dataset.group;

      // update active tab
      tabs.forEach(t => t.classList.toggle('is-active', t === tab));

      // show only selected group
      views.forEach(v => {
        v.classList.toggle('is-hidden', v.dataset.group !== g);
      });
    });
  });

  // Ticket selection + action-bar logic stays as-is;
  // it will naturally work on whichever group is currently visible.
});

const callSound = document.getElementById('call-sound');

function playCallSound() {
  if (!callSound) return;
  try {
    callSound.currentTime = 0; // restart from beginning
    callSound.play().catch(() => {
      // ignore play errors (e.g. browser blocked, no user gesture)
    });
  } catch (err) {
    console.error('Error playing call sound:', err);
  }
}
