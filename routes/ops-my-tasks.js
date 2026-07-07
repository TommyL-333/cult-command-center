/**
 * Ops Engine "My Tasks" — per-person task UI for cult-command-center.
 *
 * Mounts on manifest.cultcontent.cc. Each team member (identified by their
 * Cloudflare-Access @cultcontent.cc email -> Lark open_id) sees ONLY the Ops
 * Engine Live Tasks assigned to them, and completes them (with a required
 * Result/Output note) without ever touching the Lark Bitable.
 *
 * Factory module: module.exports = (app, deps) => { ... }
 * deps: { requireAuth, getLarkTenantToken?, axios?, express? }
 *   - requireAuth: CF Access gate that sets req.userEmail (staff-only).
 *   - If getLarkTenantToken is not supplied, we self-fetch a tenant token
 *     from LARK_APP_ID / LARK_APP_SECRET (both present on cult-command-center).
 *
 * Bitable IDs (Ops Engine base):
 *   app:        EsfBbIqfkauKozsxMHMuilDztod
 *   Live Tasks: tbl7XaSc37mtcBKg
 *   Clients:    tblgM1L7myeAfYQm
 *   Team:       tblswNG7LAFaOJOn
 *
 * Bitable write quirks (do not rediscover):
 *   - fields keyed by NAME, never field_id
 *   - User field written as [{ id: open_id }]
 *   - SingleLink written as ["rec..."]
 *   - DateTime as epoch ms
 *   - SingleSelect as exact option string
 *   - Url field as { link, text }
 *
 * Live Tasks field names (verified): Task(Text,primary), Client(SingleLink),
 *   Status(SingleSelect: To Do|In Progress|Blocked|Completed), Pillar,
 *   Phase, Role, Owner(User), Execution Mode, Auto?(Checkbox), Due Date(DateTime),
 *   Prompt / Action(Text), Result / Output(Text), SOP Link(Url),
 *   Created On(DateTime), Priority(SingleSelect), Category, Source(Text),
 *   Completed On(DateTime).
 */

const LARK_BASE = 'https://open.larksuite.com';
const OPS_APP_TOKEN = 'EsfBbIqfkauKozsxMHMuilDztod';
const TASKS_TABLE = 'tbl7XaSc37mtcBKg';
const CLIENTS_TABLE = 'tblgM1L7myeAfYQm';
const TEAM_TABLE = 'tblswNG7LAFaOJOn';

// Exact SingleSelect option strings on the Status field.
const STATUS = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  BLOCKED: 'Blocked',
  COMPLETED: 'Completed',
};

// Seed map (fallback when Team-table / email resolution can't find a person).
const SEED_EMAIL_OPENID = {
  'tommy@cultcontent.cc': 'ou_cd6157679f48e0cea557ebcb1995c462',
  'tommy@organicsocialmarketing.com': 'ou_cd6157679f48e0cea557ebcb1995c462',
  'hasan@cultcontent.cc': 'ou_c8f157f2f18a8c4ffe6a20d3971348e1',
  'shayan@cultcontent.cc': 'ou_19a69dda7462358e4b3c31e2f157a238',
};

const MY_TASKS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>My Tasks · Cult Content</title>
<style>
  :root{
    --bg:#161823; --panel:#1e2030; --panel2:#252838; --border:#2f3346;
    --txt:#e8eaf2; --muted:#9aa0b5; --cyan:#00f2ea; --red:#ff0050;
    --p1:#ff0050; --p2:#ff9f0a; --p3:#ffd60a; --p4:#5a6072;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:860px;margin:0 auto;padding:28px 18px 80px}
  header.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  h1{font-size:24px;margin:0;font-weight:700;background:linear-gradient(90deg,var(--cyan),var(--red));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .sub{color:var(--muted);font-size:13px;margin:2px 0 20px}
  .filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px}
  .chip{background:var(--panel2);border:1px solid var(--border);color:var(--muted);padding:6px 13px;border-radius:20px;font-size:12.5px;cursor:pointer;transition:.15s;user-select:none}
  .chip:hover{border-color:var(--cyan);color:var(--txt)}
  .chip.active{background:linear-gradient(90deg,rgba(0,242,234,.16),rgba(255,0,80,.16));border-color:var(--cyan);color:var(--txt)}
  a.chip{text-decoration:none;display:inline-flex;align-items:center;gap:5px}
  .chip.sisy{background:linear-gradient(90deg,rgba(0,242,234,.22),rgba(255,0,80,.22));border-color:var(--cyan);color:var(--txt);font-weight:600}
  .chip.sisy:hover{box-shadow:0 0 12px rgba(0,242,234,.35)}
  .group{margin-bottom:26px}
  .group h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 11px;display:flex;align-items:center;gap:8px}
  .dot{width:9px;height:9px;border-radius:50%}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px 15px;margin-bottom:10px;display:flex;justify-content:space-between;gap:14px;align-items:flex-start}
  .card .body{flex:1;min-width:0}
  .card .task-title{font-size:15px;font-weight:600;margin:0 0 5px;line-height:1.35}
  .meta{display:flex;gap:7px;flex-wrap:wrap;margin-top:7px}
  .tag{font-size:11px;color:var(--muted);background:var(--panel2);border:1px solid var(--border);padding:2px 8px;border-radius:6px}
  .tag.client{color:var(--cyan);border-color:rgba(0,242,234,.3)}
  .prompt{color:var(--muted);font-size:12.5px;margin-top:7px;line-height:1.45;white-space:pre-wrap}
  .btn{background:linear-gradient(90deg,var(--cyan),var(--red));color:#0c0d15;border:none;padding:8px 15px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;white-space:nowrap}
  .btn:hover{opacity:.9}
  .btn.ghost{background:var(--panel2);color:var(--txt);border:1px solid var(--border)}
  .empty{text-align:center;color:var(--muted);padding:60px 20px;font-size:14px}
  .empty .big{font-size:40px;margin-bottom:10px}
  /* modal */
  .overlay{position:fixed;inset:0;background:rgba(6,7,12,.72);backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;padding:20px;z-index:50}
  .overlay.show{display:flex}
  .modal{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:22px;width:100%;max-width:480px}
  .modal h3{margin:0 0 4px;font-size:17px}
  .modal .mt{color:var(--muted);font-size:13px;margin:0 0 16px}
  .modal label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}
  .modal textarea{width:100%;min-height:110px;background:var(--panel2);border:1px solid var(--border);border-radius:9px;color:var(--txt);padding:11px;font-size:14px;font-family:inherit;resize:vertical}
  .modal textarea:focus{outline:none;border-color:var(--cyan)}
  .modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}
  .err{color:var(--red);font-size:12.5px;margin-top:8px;display:none}
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--panel2);border:1px solid var(--cyan);color:var(--txt);padding:11px 18px;border-radius:10px;font-size:13.5px;display:none;z-index:60}
  .banner{background:rgba(255,159,10,.12);border:1px solid rgba(255,159,10,.4);color:#ffcf8a;padding:12px 15px;border-radius:10px;font-size:13.5px;margin-bottom:20px}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div><h1>My Tasks</h1></div>
    <div style="display:flex;gap:8px;align-items:center">
      <a class="chip sisy" href="https://sisyphus.cultcontent.cc" target="_blank" rel="noopener" title="Work on your tasks with Sisyphus">🪨 Go to Sisyphus</a>
      <button class="chip" onclick="load()" title="Refresh">↻ Refresh</button>
    </div>
  </header>
  <div class="sub" id="sub">Loading your Ops Engine tasks…</div>

  <div id="unlinked" class="banner" style="display:none"></div>
  <div class="filters" id="filters" style="display:none"></div>
  <div id="board"></div>
</div>

<div class="overlay" id="overlay">
  <div class="modal">
    <h3 id="modalTitle">Complete task</h3>
    <p class="mt" id="modalTask"></p>
    <label for="resultBox" id="modalLabel">Result / Output <span style="color:var(--red)">*</span> — what did you do?</label>
    <textarea id="resultBox" placeholder="Describe the outcome. Required."></textarea>
    <div class="err" id="modalErr">A result / output note is required.</div>
    <div class="modal-actions" style="justify-content:space-between">
      <a class="chip sisy" id="sisyLink" href="https://sisyphus.cultcontent.cc" target="_blank" rel="noopener">🪨 Work on this in Sisyphus</a>
      <div style="display:flex;gap:10px">
        <button class="btn ghost" onclick="closeModal()">Cancel</button>
        <button class="btn" id="confirmBtn" disabled onclick="doConfirm()">Mark complete</button>
      </div>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
var ALL=[]; var FILTER='all'; var CURRENT=null; var MODE='complete';
var PRIO=[
  {key:'Critical',label:'Critical',color:'var(--p1)',match:['critical','p0','urgent']},
  {key:'High',label:'High',color:'var(--p2)',match:['high','p1']},
  {key:'Medium',label:'Medium',color:'var(--p3)',match:['medium','normal','p2']},
  {key:'Low',label:'Low',color:'var(--p4)',match:['low','p3','']}
];
function prioBucket(p){
  var s=(p||'').toLowerCase().trim();
  for(var i=0;i<PRIO.length;i++){ if(PRIO[i].match.indexOf(s)>=0) return PRIO[i]; }
  // default unknown -> Medium
  return PRIO[2];
}
function esc(s){return (s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}

function load(){
  document.getElementById('sub').textContent='Loading your Ops Engine tasks…';
  fetch('/api/my-tasks/list',{credentials:'include'}).then(function(r){return r.json();}).then(function(d){
    if(d.unlinked){
      document.getElementById('unlinked').style.display='block';
      document.getElementById('unlinked').textContent=d.message||'Your account is not linked to a task owner yet.';
      document.getElementById('sub').textContent='';
      return;
    }
    ALL=d.tasks||[];
    document.getElementById('sub').textContent=ALL.length+' active task'+(ALL.length===1?'':'s')+' assigned to you.';
    renderFilters(); render();
  }).catch(function(e){
    document.getElementById('sub').textContent='Failed to load tasks: '+e;
  });
}

function renderFilters(){
  var pillars={}; ALL.forEach(function(t){ if(t.pillar) pillars[t.pillar]=1; });
  var keys=Object.keys(pillars).sort();
  var el=document.getElementById('filters');
  el.style.display='flex';
  var html='<div class="chip'+(FILTER==='all'?' active':'')+'" onclick="setFilter(\\'all\\')">All Pillars</div>';
  keys.forEach(function(k){
    html+='<div class="chip'+(FILTER===k?' active':'')+'" onclick="setFilter(\\''+esc(k).replace(/'/g,"")+'\\')">'+esc(k)+'</div>';
  });
  el.innerHTML=html;
}
function setFilter(f){FILTER=f;renderFilters();render();}

function render(){
  var board=document.getElementById('board');
  var list=ALL.filter(function(t){return FILTER==='all'||t.pillar===FILTER;});
  if(!list.length){
    board.innerHTML='<div class="empty"><div class="big">✓</div>Nothing here. You are all caught up.</div>';
    return;
  }
  var html='';
  PRIO.forEach(function(P){
    var g=list.filter(function(t){return prioBucket(t.priority).key===P.key;});
    if(!g.length) return;
    html+='<div class="group"><h2><span class="dot" style="background:'+P.color+'"></span>'+P.label+' · '+g.length+'</h2>';
    g.forEach(function(t){
      html+='<div class="card"><div class="body">';
      html+='<div class="task-title">'+esc(t.task||'(untitled)')+'</div>';
      html+='<div class="meta">';
      if(t.client) html+='<span class="tag client">'+esc(t.client)+'</span>';
      if(t.pillar) html+='<span class="tag">'+esc(t.pillar)+'</span>';
      if(t.status) html+='<span class="tag">'+esc(t.status)+'</span>';
      if(t.executionMode) html+='<span class="tag">'+esc(t.executionMode)+'</span>';
      html+='</div>';
      if(t.promptAction) html+='<div class="prompt">'+esc(t.promptAction)+'</div>';
      if(t.status==='Blocked'&&t.blockedReason) html+='<div class="prompt" style="color:var(--red)">⛔ '+esc(t.blockedReason)+'</div>';
      html+='</div>';
      html+='<div style="display:flex;flex-direction:column;gap:8px">';
      html+='<button class="btn" onclick="openModal(\\''+t.record_id+'\\')">Complete</button>';
      html+='<button class="btn ghost" onclick="openBlockModal(\\''+t.record_id+'\\')">Block</button>';
      html+='</div>';
      html+='</div>';
    });
    html+='</div>';
  });
  board.innerHTML=html;
}

function setModalMode(mode){
  MODE=mode;
  var isBlock=mode==='block';
  document.getElementById('modalTitle').textContent=isBlock?'Block task':'Complete task';
  document.getElementById('modalLabel').innerHTML=isBlock?'Reason <span style="color:var(--red)">*</span> — why is this blocked?':'Result / Output <span style="color:var(--red)">*</span> — what did you do?';
  document.getElementById('resultBox').placeholder=isBlock?'What is blocking this task? Required.':'Describe the outcome. Required.';
  document.getElementById('modalErr').textContent=isBlock?'A reason is required to block a task.':'A result / output note is required.';
  document.getElementById('confirmBtn').textContent=isBlock?'Mark blocked':'Mark complete';
}
function openModal(id){
  setModalMode('complete');
  CURRENT=ALL.filter(function(t){return t.record_id===id;})[0];
  if(!CURRENT) return;
  document.getElementById('modalTask').textContent=CURRENT.task||'';
  var sl=document.getElementById('sisyLink');
  if(sl){var q='Help me work on this Ops Engine task: '+(CURRENT.task||'')+(CURRENT.client?' (client: '+CURRENT.client+')':'');sl.href='https://sisyphus.cultcontent.cc/?prefill='+encodeURIComponent(q);}
  var box=document.getElementById('resultBox'); box.value='';
  document.getElementById('modalErr').style.display='none';
  document.getElementById('confirmBtn').disabled=true;
  document.getElementById('overlay').classList.add('show');
  setTimeout(function(){box.focus();},50);
}
function closeModal(){document.getElementById('overlay').classList.remove('show');CURRENT=null;}
document.getElementById('resultBox').addEventListener('input',function(){
  // CLIENT-SIDE required-result guard: submit disabled until non-empty (trimmed).
  document.getElementById('confirmBtn').disabled = this.value.trim().length===0;
});

function doComplete(){
  if(!CURRENT) return;
  var result=document.getElementById('resultBox').value.trim();
  if(!result){ document.getElementById('modalErr').style.display='block'; return; }
  var btn=document.getElementById('confirmBtn'); btn.disabled=true; btn.textContent='Saving…';
  fetch('/api/my-tasks/complete',{
    method:'POST',credentials:'include',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({record_id:CURRENT.record_id,result:result})
  }).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
  .then(function(x){
    btn.textContent='Mark complete';
    if(x.ok&&x.j.verified){
      ALL=ALL.filter(function(t){return t.record_id!==CURRENT.record_id;});
      closeModal(); renderFilters(); render();
      document.getElementById('sub').textContent=ALL.length+' active task'+(ALL.length===1?'':'s')+' assigned to you.';
      toast('✓ Completed & verified in Bitable');
    } else {
      document.getElementById('modalErr').style.display='block';
      document.getElementById('modalErr').textContent=(x.j&&x.j.error)||'Failed to complete.';
      btn.disabled=false;
    }
  }).catch(function(e){
    document.getElementById('modalErr').style.display='block';
    document.getElementById('modalErr').textContent='Network error: '+e;
    btn.disabled=false; btn.textContent='Mark complete';
  });
}
function openBlockModal(id){
  setModalMode('block');
  CURRENT=ALL.filter(function(t){return t.record_id===id;})[0];
  if(!CURRENT) return;
  document.getElementById('modalTask').textContent=CURRENT.task||'';
  var sl=document.getElementById('sisyLink');
  if(sl){var q='Help me unblock this Ops Engine task: '+(CURRENT.task||'')+(CURRENT.client?' (client: '+CURRENT.client+')':'');sl.href='https://sisyphus.cultcontent.cc/?prefill='+encodeURIComponent(q);}
  var box=document.getElementById('resultBox'); box.value='';
  document.getElementById('modalErr').style.display='none';
  document.getElementById('confirmBtn').disabled=true;
  document.getElementById('overlay').classList.add('show');
  setTimeout(function(){box.focus();},50);
}
function doConfirm(){ if(MODE==='block'){ doBlock(); } else { doComplete(); } }
function doBlock(){
  if(!CURRENT) return;
  var reason=document.getElementById('resultBox').value.trim();
  if(!reason){ document.getElementById('modalErr').style.display='block'; return; }
  var btn=document.getElementById('confirmBtn'); btn.disabled=true; btn.textContent='Saving…';
  fetch('/api/my-tasks/block',{
    method:'POST',credentials:'include',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({record_id:CURRENT.record_id,reason:reason})
  }).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
  .then(function(x){
    btn.textContent='Mark blocked';
    if(x.ok&&x.j.verified){
      var rid=CURRENT.record_id;
      ALL=ALL.map(function(t){ if(t.record_id===rid){ t.status='Blocked'; t.blockedReason=x.j.reason; } return t; });
      closeModal(); renderFilters(); render();
      toast('⛔ Blocked & verified in Bitable');
    } else {
      document.getElementById('modalErr').style.display='block';
      document.getElementById('modalErr').textContent=(x.j&&x.j.error)||'Failed to block.';
      btn.disabled=false;
    }
  }).catch(function(e){
    document.getElementById('modalErr').style.display='block';
    document.getElementById('modalErr').textContent='Network error: '+e;
    btn.disabled=false; btn.textContent='Mark blocked';
  });
}
function toast(msg){var t=document.getElementById('toast');t.textContent=msg;t.style.display='block';setTimeout(function(){t.style.display='none';},2600);}

load();
</script>
</body>
</html>`;

module.exports = function registerOpsMyTasks(app, deps = {}) {
  const axios = deps.axios || require('axios');
  const express = deps.express || require('express');
  // Auth gate. Prefer the host app's requireAuth (CF Access / team session).
  // When none is provided (e.g. standalone/dynamic mount before the auth wall),
  // fall back to a self-contained guard that returns a CLEAN JSON 401 when the
  // request carries no authenticated identity — so unauthenticated API hits are
  // never silently allowed through. (DoD: unauth /api/my-tasks/* -> JSON 401.)
  const requireAuth =
    deps.requireAuth ||
    ((req, res, next) => {
      const email = req.userEmail || (req.session && req.session.userEmail);
      const isAdmin = !!(req.session && req.session.isPortalAdmin);
      if (email || isAdmin) return next();
      return res
        .status(401)
        .json({ error: 'Authentication required', code: 401 });
    });
  const providedGetToken = deps.getLarkTenantToken;
  const jsonBody = express.json();

  // ---------- (a) tenant token ----------
  let _tokenCache = { token: null, exp: 0 };
  async function getTenantToken() {
    // If a dedicated base-owning app is configured (OPS_LARK_APP_ID), ALWAYS self-fetch
    // with it — the injected token belongs to an app that lacks Bitable scopes on this base.
    const haveDedicated = !!(process.env.OPS_LARK_APP_ID && process.env.OPS_LARK_APP_SECRET);
    if (providedGetToken && !haveDedicated) {
      try {
        const t = await providedGetToken();
        if (t) return t;
      } catch (e) { /* fall through to self-fetch */ }
    }
    const now = Date.now();
    if (_tokenCache.token && now < _tokenCache.exp) return _tokenCache.token;
    const app_id = process.env.OPS_LARK_APP_ID || process.env.LARK_APP_ID;
    const app_secret = process.env.OPS_LARK_APP_SECRET || process.env.LARK_APP_SECRET;
    if (!app_id || !app_secret) throw new Error('OPS_LARK_APP_ID/SECRET or LARK_APP_ID/SECRET missing');
    const r = await axios.post(
      `${LARK_BASE}/open-apis/auth/v3/tenant_access_token/internal`,
      { app_id, app_secret },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    if (r.data.code !== 0) throw new Error('tenant token: ' + r.data.msg);
    _tokenCache = {
      token: r.data.tenant_access_token,
      // expire 60s early
      exp: now + (r.data.expire ? (r.data.expire - 60) * 1000 : 90 * 60 * 1000),
    };
    return _tokenCache.token;
  }

  async function larkGet(path, params) {
    const token = await getTenantToken();
    const r = await axios.get(`${LARK_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
      timeout: 20000,
    });
    return r.data;
  }
  async function larkPatch(path, body) {
    const token = await getTenantToken();
    const r = await axios.put(`${LARK_BASE}${path}`, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    });
    return r.data;
  }

  // ---------- (b) list all task records (paginate fully) ----------
  async function listAllTaskRecords() {
    const out = [];
    let pageToken = null;
    let guard = 0;
    do {
      const params = { page_size: 500 };
      if (pageToken) params.page_token = pageToken;
      const data = await larkGet(
        `/open-apis/bitable/v1/apps/${OPS_APP_TOKEN}/tables/${TASKS_TABLE}/records`,
        params
      );
      if (data.code !== 0) throw new Error('listAllTaskRecords: ' + data.msg);
      const items = (data.data && data.data.items) || [];
      for (const it of items) out.push(it);
      pageToken = data.data && data.data.has_more ? data.data.page_token : null;
      guard++;
    } while (pageToken && guard < 20);
    return out;
  }

  // ---------- (c) clients map (record_id -> brand) with ~10min cache ----------
  let _clientsCache = { map: null, exp: 0 };
  async function getClientsMap() {
    const now = Date.now();
    if (_clientsCache.map && now < _clientsCache.exp) return _clientsCache.map;
    const map = {};
    let pageToken = null;
    let guard = 0;
    do {
      const params = { page_size: 500 };
      if (pageToken) params.page_token = pageToken;
      const data = await larkGet(
        `/open-apis/bitable/v1/apps/${OPS_APP_TOKEN}/tables/${CLIENTS_TABLE}/records`,
        params
      );
      if (data.code !== 0) throw new Error('getClientsMap: ' + data.msg);
      const items = (data.data && data.data.items) || [];
      for (const it of items) {
        const f = it.fields || {};
        // Brand primary field is commonly "Brand" or "Client" or "Name".
        const brand =
          textVal(f['Brand']) ||
          textVal(f['Client']) ||
          textVal(f['Name']) ||
          textVal(f['Brand Name']) ||
          '';
        if (brand) map[it.record_id] = brand;
      }
      pageToken = data.data && data.data.has_more ? data.data.page_token : null;
      guard++;
    } while (pageToken && guard < 20);
    _clientsCache = { map, exp: now + 10 * 60 * 1000 };
    return map;
  }

  // ---------- (d) patch record (fields keyed by NAME) ----------
  async function patchRecord(recordId, fieldsByName) {
    const data = await larkPatch(
      `/open-apis/bitable/v1/apps/${OPS_APP_TOKEN}/tables/${TASKS_TABLE}/records/${recordId}`,
      { fields: fieldsByName }
    );
    if (data.code !== 0) throw new Error('patchRecord: ' + data.code + ' ' + data.msg);
    return data.data && data.data.record;
  }

  // ---------- (e) read single record ----------
  async function readRecord(recordId) {
    const data = await larkGet(
      `/open-apis/bitable/v1/apps/${OPS_APP_TOKEN}/tables/${TASKS_TABLE}/records/${recordId}`
    );
    if (data.code !== 0) throw new Error('readRecord: ' + data.msg);
    return data.data && data.data.record;
  }

  // ---------- email -> open_id resolution ----------
  // Team table has Person(User) + "Open ID"(Text). The User object carries an
  // email, so we scan the Team table and match on email; seed map is fallback.
  let _teamCache = { byEmail: null, exp: 0 };
  async function getTeamByEmail() {
    const now = Date.now();
    if (_teamCache.byEmail && now < _teamCache.exp) return _teamCache.byEmail;
    const byEmail = {};
    try {
      let pageToken = null;
      let guard = 0;
      do {
        const params = { page_size: 500 };
        if (pageToken) params.page_token = pageToken;
        const data = await larkGet(
          `/open-apis/bitable/v1/apps/${OPS_APP_TOKEN}/tables/${TEAM_TABLE}/records`,
          params
        );
        if (data.code !== 0) break;
        const items = (data.data && data.data.items) || [];
        for (const it of items) {
          const f = it.fields || {};
          const openId = textVal(f['Open ID']);
          const person = f['Person'];
          let email = '';
          if (Array.isArray(person) && person[0]) email = person[0].email || '';
          else if (person && person.email) email = person.email;
          if (email && openId) byEmail[email.toLowerCase()] = openId;
        }
        pageToken = data.data && data.data.has_more ? data.data.page_token : null;
        guard++;
      } while (pageToken && guard < 10);
    } catch (e) {
      // fall through to seed map only
    }
    _teamCache = { byEmail, exp: now + 10 * 60 * 1000 };
    return byEmail;
  }

  async function resolveOpenId(email) {
    if (!email) return null;
    const key = email.toLowerCase();
    // env override map first
    if (process.env.OPS_EMAIL_OPENID_MAP) {
      try {
        const m = JSON.parse(process.env.OPS_EMAIL_OPENID_MAP);
        if (m[key]) return m[key];
      } catch (_) {}
    }
    const team = await getTeamByEmail();
    if (team[key]) return team[key];
    if (SEED_EMAIL_OPENID[key]) return SEED_EMAIL_OPENID[key];
    return null;
  }

  // ---------- helpers ----------
  function textVal(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (Array.isArray(v)) {
      // link field: [{text, text_arr, record_ids}]
      const first = v[0];
      if (first && typeof first === 'object') {
        if (Array.isArray(first.text_arr) && first.text_arr[0]) return first.text_arr[0];
        if (first.text) return first.text;
        if (first.name) return first.name;
      }
      return v.map((x) => (typeof x === 'string' ? x : x && (x.text || x.name) || '')).join(', ');
    }
    if (typeof v === 'object') {
      if (v.text) return v.text;
      if (v.link) return v.link;
    }
    return '';
  }

  function ownerIds(fields) {
    const owner = fields && fields.Owner;
    if (!Array.isArray(owner)) return [];
    return owner.map((o) => o && o.id).filter(Boolean);
  }

  function clientRecordIds(fields) {
    const c = fields && fields.Client;
    if (!Array.isArray(c)) return [];
    const ids = [];
    for (const link of c) {
      if (link && Array.isArray(link.record_ids)) ids.push(...link.record_ids);
    }
    return ids;
  }

  function shapeTask(rec, clientsMap) {
    const f = rec.fields || {};
    // Prefer the inline link text; fall back to clients map by record_id.
    let client = textVal(f.Client);
    if (!client) {
      const ids = clientRecordIds(f);
      client = ids.map((id) => clientsMap[id]).filter(Boolean).join(', ');
    }
    return {
      record_id: rec.record_id,
      task: textVal(f.Task),
      client,
      status: textVal(f.Status),
      pillar: textVal(f.Pillar),
      priority: textVal(f.Priority),
      executionMode: textVal(f['Execution Mode']),
      promptAction: textVal(f['Prompt / Action']),
      dueDate: f['Due Date'] || null,
      sopLink: textVal(f['SOP Link']),
      blockedReason: textVal(f['Blocked Reason']),
      source: textVal(f.Source),
    };
  }

  // Resolve the caller's open_id from their CF Access email (or session).
  async function resolveCaller(req) {
    const email = req.userEmail || (req.session && req.session.userEmail) || null;
    const isAdmin = !!(req.session && req.session.isPortalAdmin);
    const openId = await resolveOpenId(email);
    return { email, isAdmin, openId };
  }


  // ---------- ROUTE: POST /api/my-tasks/block ----------
  // Mark a task Blocked with a required reason. Mirrors /complete:
  // owner check -> patch (keyed by NAME) -> read-back verification.
  app.post('/api/my-tasks/block', requireAuth, jsonBody, async (req, res) => {
    try {
      const { record_id } = req.body || {};
      const rawReason = (req.body && req.body.reason) != null ? req.body.reason : '';
      const reason = typeof rawReason === 'string' ? rawReason.trim() : '';

      if (!record_id || typeof record_id !== 'string') {
        return res.status(400).json({ error: 'record_id is required' });
      }
      if (!reason) {
        return res
          .status(400)
          .json({ error: 'A reason is required to block a task.' });
      }

      const { openId } = await resolveCaller(req);
      if (!openId) {
        return res
          .status(403)
          .json({ error: "Your account isn't linked to a task owner. Ping Tommy." });
      }

      let existing;
      try {
        existing = await readRecord(record_id);
      } catch (e) {
        return res.status(404).json({ error: 'Task not found', detail: e.message });
      }
      const existingFields = (existing && existing.fields) || {};
      const owners = ownerIds(existingFields);
      if (!owners.includes(openId)) {
        return res
          .status(403)
          .json({ error: "You can't block a task you don't own." });
      }

      await patchRecord(record_id, {
        Status: STATUS.BLOCKED,
        'Blocked Reason': reason,
      });

      const after = await readRecord(record_id);
      const afterFields = (after && after.fields) || {};
      const afterStatus = textVal(afterFields.Status);
      const afterReason = textVal(afterFields['Blocked Reason']);

      const verified = afterStatus === STATUS.BLOCKED && afterReason === reason;
      if (!verified) {
        return res.status(500).json({
          ok: false,
          verified: false,
          error: 'Write did not verify on read-back',
          readback: { status: afterStatus, reason: afterReason },
        });
      }

      return res.json({
        ok: true,
        verified: true,
        record_id,
        status: afterStatus,
        reason: afterReason,
      });
    } catch (e) {
      console.error('[ops-my-tasks] block error:', e.message);
      res.status(500).json({ error: 'Failed to block task', detail: e.message });
    }
  });

  app.get('/api/my-tasks/whoami', requireAuth, async (req, res) => {
    const email = req.userEmail || (req.session && req.session.userEmail) || null;
    let openId = null, err = null;
    try { openId = await resolveOpenId(email); } catch (e) { err = e.message; }
    let teamKeys = [];
    try { const t = await getTeamByEmail(); teamKeys = Object.keys(t); } catch (e) {}
    let activeCount = null, sample = [];
    try {
      const records = await listAllTaskRecords();
      for (const rec of records) {
        const f = rec.fields || {};
        if (textVal(f.Status) === "Completed") continue;
        if (openId && !ownerIds(f).includes(openId)) continue;
        sample.push(textVal(f.Task).slice(0,50));
      }
      activeCount = sample.length;
    } catch (e) {
      const detail = e.response ? JSON.stringify(e.response.data) : e.message;
      const url = e.config ? (e.config.url + "?" + JSON.stringify(e.config.params||{})) : "";
      const authHdr = e.config && e.config.headers ? String(e.config.headers.Authorization||"").slice(0,20) : "";
      err = (err||"") + " listErr:" + e.message + " | detail:" + detail + " | url:" + url + " | auth:" + authHdr;
    }
    res.json({ email, openId, activeCount, sample, seedHasEmail: !!(email && SEED_EMAIL_OPENID[email.toLowerCase()]), teamEmailKeys: teamKeys, err });
  });

  // ---------- ROUTE: GET /api/my-tasks/list ----------
  app.get('/api/my-tasks/list', requireAuth, async (req, res) => {
    try {
      const email = req.userEmail || (req.session && req.session.userEmail) || null;
      const isAdmin = !!(req.session && req.session.isPortalAdmin);

      // Team View hook: ?owner=all only for portal admins.
      const wantAll = req.query.owner === 'all';
      let openId = null;
      if (!(wantAll && isAdmin)) {
        openId = await resolveOpenId(email);
        if (!openId) {
          return res.status(200).json({
            tasks: [],
            unlinked: true,
            message:
              "Your account isn't linked to a task owner yet — ping Tommy to map your Lark open_id.",
            email: email || null,
          });
        }
      }

      const [records, clientsMap] = await Promise.all([
        listAllTaskRecords(),
        getClientsMap().catch(() => ({})),
      ]);

      const tasks = [];
      for (const rec of records) {
        const f = rec.fields || {};
        const status = textVal(f.Status);
        if (status === 'Completed') continue; // active view excludes completed
        if (!(wantAll && isAdmin)) {
          if (!ownerIds(f).includes(openId)) continue;
        }
        tasks.push(shapeTask(rec, clientsMap));
      }

      res.json({ tasks, owner: wantAll && isAdmin ? 'all' : openId });
    } catch (e) {
      console.error('[ops-my-tasks] list error:', e.message);
      res.status(500).json({ error: 'Failed to load tasks', detail: e.message });
    }
  });

  // ---------- ROUTE: POST /api/my-tasks/complete ----------
  // Body: { record_id, result }
  //  - 400 if result missing/empty/whitespace (server-side guard, cannot be
  //    bypassed by the client).
  //  - 403 if the caller's open_id is not in the task's Owner field
  //    (you cannot complete someone else's task).
  //  - Writes Status='Completed', 'Result / Output'=result, 'Completed On'=now,
  //    then reads the record back and confirms BOTH before returning
  //    { ok:true, verified:true }.
  app.post('/api/my-tasks/complete', requireAuth, jsonBody, async (req, res) => {
    try {
      const { record_id } = req.body || {};
      const rawResult = (req.body && req.body.result) != null ? req.body.result : '';
      const result = typeof rawResult === 'string' ? rawResult.trim() : '';

      if (!record_id || typeof record_id !== 'string') {
        return res.status(400).json({ error: 'record_id is required' });
      }
      // Server-side required-result guard (mirrors the client-side guard).
      if (!result) {
        return res
          .status(400)
          .json({ error: 'A result / output note is required to complete a task.' });
      }

      // Resolve caller identity.
      const { openId } = await resolveCaller(req);
      if (!openId) {
        return res
          .status(403)
          .json({ error: "Your account isn't linked to a task owner. Ping Tommy." });
      }

      // Read the record and verify ownership BEFORE writing.
      let existing;
      try {
        existing = await readRecord(record_id);
      } catch (e) {
        return res.status(404).json({ error: 'Task not found', detail: e.message });
      }
      const existingFields = (existing && existing.fields) || {};
      const owners = ownerIds(existingFields);
      if (!owners.includes(openId)) {
        return res
          .status(403)
          .json({ error: "You can't complete a task you don't own." });
      }

      // Write: Status + Result/Output (keyed by NAME) + Completed On (epoch ms).
      await patchRecord(record_id, {
        Status: STATUS.COMPLETED,
        'Result / Output': result,
        'Completed On': Date.now(),
      });

      // Read back and confirm the write took effect.
      const after = await readRecord(record_id);
      const afterFields = (after && after.fields) || {};
      const afterStatus = textVal(afterFields.Status);
      const afterResult = textVal(afterFields['Result / Output']);

      const verified = afterStatus === STATUS.COMPLETED && afterResult === result;
      if (!verified) {
        return res.status(500).json({
          ok: false,
          verified: false,
          error: 'Write did not verify on read-back',
          readback: { status: afterStatus, result: afterResult },
        });
      }

      return res.json({
        ok: true,
        verified: true,
        record_id,
        status: afterStatus,
        result: afterResult,
      });
    } catch (e) {
      console.error('[ops-my-tasks] complete error:', e.message);
      res.status(500).json({ error: 'Failed to complete task', detail: e.message });
    }
  });


  // ---------- ROUTE: GET /my-tasks (HTML page) ----------
  // The per-person task board. Auth-gated. Renders a dark-theme page that
  // fetches /api/my-tasks/list on load, groups tasks by Priority, offers a
  // Pillar filter, and completes tasks via a modal with a CLIENT-SIDE
  // required-result guard (submit disabled until the textarea is non-empty).
  app.get('/my-tasks', requireAuth, (req, res) => {
    res.type('html').send(MY_TASKS_HTML);
  });
  // Alias: the portal-admin nav links to /ops/my-tasks — serve the same page there.
  app.get('/ops/my-tasks', requireAuth, (req, res) => {
    res.type('html').send(MY_TASKS_HTML);
  });

  // Expose helpers for later steps / test harnesses.
  registerOpsMyTasks._helpers = {
    getTenantToken,
    listAllTaskRecords,
    getClientsMap,
    patchRecord,
    readRecord,
    resolveOpenId,
    getTeamByEmail,
    resolveCaller,
    shapeTask,
    ownerIds,
    textVal,
    STATUS,
  };

  return app;
};
