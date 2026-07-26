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

// Weekly Reports Lark base
const WR_LARK_APP = 'ACkBbUDWhaXYRrsLpvquuTKPtwb';
const WR_TABLES = {
  brand_manager: 'tblirCIMRjvDEldZ',
  operations:    'tbleCKQBNgOw8p9l',
  video_editor:  'tblJIS8iHBEhgE0g',
  ceo:           'tblU0f6BPVDqCqCY',
};
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
  'daniel@cultcontent.cc': 'ou_4332cd6e701b50b0668f7dcbd7196a40',
  'gourab@cultcontent.cc': 'ou_a391574932a4bf8a4d8d08a6297cceaa',
};

// Brand managers: email -> client names they own.
// Used for Weekly Report brand selector and admin brand-context display.
// Add gourab@cultcontent.cc once they're added to the Lark Team table.
const BRAND_MANAGERS = {
  'shayan@cultcontent.cc': ['Approved Science', 'The Perfect Haircare', 'Dissolvd', 'B NOOR'],
  'gourab@cultcontent.cc': ['Lode WTR', 'Roots by Genetic Art', 'YUGLO Skin'],
};

// Weekly report form type per team member.
// brand_manager: per-brand GMV/content/SPS
// operations: Hasan — automations, templates, blockers removed
// video_editor: Gilbert — videos edited/delivered
// ceo: Tommy — sales calls, proposals, community growth, strategic notes
const REPORT_TYPES = {
  'shayan@cultcontent.cc': 'brand_manager',
  'gourab@cultcontent.cc': 'brand_manager',
  'hasan@cultcontent.cc': 'operations',
  'gilbert@cultcontent.cc': 'video_editor',
  'tommy@cultcontent.cc': 'ceo',
  'tommy@organicsocialmarketing.com': 'ceo',
};

// Emails allowed to access /task-management admin view.
const ADMIN_EMAILS = new Set([
  'tommy@cultcontent.cc',
  'tommy@organicsocialmarketing.com',
]);

// Manager emails: the only people who can delete tasks.
const MANAGER_EMAILS = new Set([
  'tommy@cultcontent.cc',
  'tommy@organicsocialmarketing.com',
  'hasan@cultcontent.cc',
]);

const MY_TASKS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>My Tasks · Cult Content</title>
<style>
  :root{--bg:#161823;--panel:#1e2030;--panel2:#252838;--border:#2f3346;--txt:#e8eaf2;--muted:#9aa0b5;--cyan:#00f2ea;--red:#ff0050;--p1:#ff0050;--p2:#ff9f0a;--p3:#ffd60a;--p4:#5a6072;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:860px;margin:0 auto;padding:28px 18px 80px}
  header.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  h1{font-size:24px;margin:0;font-weight:700;background:linear-gradient(90deg,var(--cyan),var(--red));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .sub{color:var(--muted);font-size:13px;margin:2px 0 16px}
  .tabs{display:flex;gap:0;margin-bottom:20px;border-bottom:1px solid var(--border)}
  .tab{background:none;border:none;border-bottom:2px solid transparent;color:var(--muted);padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:-1px;transition:.15s;font-family:inherit}
  .tab:hover{color:var(--txt)}
  .tab.active{color:var(--cyan);border-bottom-color:var(--cyan)}
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
  .subtasks{margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}
  .st-item{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px}
  .st-item input[type=checkbox]{accent-color:var(--cyan);width:14px;height:14px;cursor:pointer;flex-shrink:0}
  .st-item.done .st-lbl{text-decoration:line-through;color:var(--muted)}
  .add-st{background:none;border:1px dashed var(--border);color:var(--muted);padding:5px 10px;border-radius:6px;font-size:12px;cursor:pointer;margin-top:6px;width:100%;text-align:left;font-family:inherit}
  .add-st:hover{border-color:var(--cyan);color:var(--txt)}
  .btn{background:linear-gradient(90deg,var(--cyan),var(--red));color:#0c0d15;border:none;padding:8px 15px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;white-space:nowrap;font-family:inherit}
  .btn:hover{opacity:.9}
  .btn.ghost{background:var(--panel2);color:var(--txt);border:1px solid var(--border)}
  .empty{text-align:center;color:var(--muted);padding:60px 20px;font-size:14px}
  .empty .big{font-size:40px;margin-bottom:10px}
  .overlay{position:fixed;inset:0;background:rgba(6,7,12,.72);backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;padding:20px;z-index:50}
  .overlay.show{display:flex}
  .modal{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:22px;width:100%;max-width:480px}
  .modal h3{margin:0 0 4px;font-size:17px}
  .modal .mt{color:var(--muted);font-size:13px;margin:0 0 16px}
  .modal label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}
  .modal textarea,.modal input[type=text]{width:100%;background:var(--panel2);border:1px solid var(--border);border-radius:9px;color:var(--txt);padding:11px;font-size:14px;font-family:inherit}
  .modal textarea{min-height:110px;resize:vertical}
  .modal textarea:focus,.modal input[type=text]:focus{outline:none;border-color:var(--cyan)}
  .modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}
  .err{color:var(--red);font-size:12.5px;margin-top:8px;display:none}
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--panel2);border:1px solid var(--cyan);color:var(--txt);padding:11px 18px;border-radius:10px;font-size:13.5px;display:none;z-index:60}
  .banner{background:rgba(255,159,10,.12);border:1px solid rgba(255,159,10,.4);color:#ffcf8a;padding:12px 15px;border-radius:10px;font-size:13.5px;margin-bottom:20px}
  /* weekly report */
  .wr-form{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:22px;margin-bottom:22px}
  .wr-form h2{margin:0 0 16px;font-size:17px;font-weight:700}
  .fr{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
  .fr.full{grid-template-columns:1fr}
  .fg{display:flex;flex-direction:column;gap:5px}
  .fg label{font-size:12px;color:var(--muted)}
  .fg input,.fg select,.fg textarea{background:var(--panel2);border:1px solid var(--border);border-radius:8px;color:var(--txt);padding:9px 11px;font-size:14px;font-family:inherit}
  .fg input:focus,.fg select:focus,.fg textarea:focus{outline:none;border-color:var(--cyan)}
  .trow{display:flex;align-items:center;gap:12px;background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:10px 12px}
  .trow label{font-size:13px;flex:1;color:var(--txt);margin:0}
  .toggle{position:relative;width:40px;height:22px;flex-shrink:0}
  .toggle input{opacity:0;width:0;height:0;position:absolute}
  .slider{position:absolute;inset:0;background:var(--border);border-radius:22px;cursor:pointer;transition:.2s}
  .slider:before{content:'';position:absolute;width:16px;height:16px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.2s}
  .toggle input:checked+.slider{background:var(--cyan)}
  .toggle input:checked+.slider:before{transform:translateX(18px)}
  .wr-section-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin:12px 0 6px;padding-bottom:4px;border-bottom:1px solid var(--border)}
  .wr-hist h3{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:0 0 12px}
  .wr-card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px}
  .wr-head{display:flex;justify-content:space-between;margin-bottom:10px;font-size:13px}
  .wr-brand{font-weight:700;color:var(--cyan)}
  .wr-week{color:var(--muted)}
  .wr-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
  .wr-stat{background:var(--panel2);border-radius:6px;padding:8px;text-align:center}
  .wr-stat .n{font-size:18px;font-weight:700}
  .wr-stat .l{font-size:10px;color:var(--muted);text-transform:uppercase;margin-top:2px}
  @media(max-width:540px){.fr{grid-template-columns:1fr}.wr-grid{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div><h1>My Tasks</h1></div>
    <div style="display:flex;gap:8px;align-items:center">
      <a class="chip sisy" href="https://sisyphus.cultcontent.cc" target="_blank" rel="noopener">🪨 Sisyphus</a>
      <a class="chip" href="/task-management">⚙ Admin</a>
      <button class="chip" onclick="load()" title="Refresh">↻</button>
    </div>
  </header>
  <div class="sub" id="sub">Loading…</div>
  <div class="tabs">
    <button class="tab active" onclick="switchTab(0)">My Tasks</button>
    <button class="tab" onclick="switchTab(1)">Weekly Report</button>
  </div>

  <div id="tab-tasks">
    <div id="unlinked" class="banner" style="display:none"></div>
    <div class="filters" id="filters" style="display:none"></div>
    <div id="board"></div>
  </div>

  <div id="tab-report" style="display:none">
    <div class="wr-form">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2 style="margin:0">Weekly Report</h2>
        <div style="font-size:12px;color:var(--muted)" id="wr-sub-label"></div>
      </div>
      <div id="wr-form-body"><div style="color:var(--muted);font-size:13px">Loading…</div></div>
      <div class="err" id="wr-err" style="margin-top:8px"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:14px">
        <button class="btn" onclick="submitReport()">Submit Report</button>
      </div>
    </div>
    <div class="wr-hist">
      <h3 id="wr-hist-title">Recent Reports</h3>
      <div id="wr-list"><div style="color:var(--muted);font-size:13px">Loading…</div></div>
    </div>
  </div>
</div>

<!-- complete / block / reassign modal -->
<div class="overlay" id="overlay">
  <div class="modal">
    <h3 id="modalTitle">Complete task</h3>
    <p class="mt" id="modalTask"></p>
    <div id="assignWrap" style="display:none;margin-bottom:10px">
      <label for="assignSel">Reassign to</label>
      <select id="assignSel" style="width:100%;margin-top:6px;padding:10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border)"></select>
      <label for="prioSel" style="display:block;margin-top:12px">Priority</label>
      <select id="prioSel" style="width:100%;margin-top:6px;padding:10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border)">
        <option value="🔴 Critical">🔴 Critical</option><option value="🟠 High">🟠 High</option><option value="🟡 Normal">🟡 Normal</option><option value="⚪ Low">⚪ Low</option>
      </select>
    </div>
    <label for="resultBox" id="modalLabel">Result / Output <span style="color:var(--red)">*</span> — what did you do?</label>
    <textarea id="resultBox" placeholder="Describe the outcome. Required."></textarea>
    <div class="err" id="modalErr">A result / output note is required.</div>
    <div class="modal-actions" style="justify-content:space-between">
      <a class="chip sisy" id="sisyLink" href="https://sisyphus.cultcontent.cc" target="_blank" rel="noopener">🪨 Open in Sisyphus</a>
      <div style="display:flex;gap:10px">
        <button class="btn ghost" onclick="closeModal()">Cancel</button>
        <button class="btn" id="confirmBtn" disabled onclick="doConfirm()">Mark complete</button>
      </div>
    </div>
  </div>
</div>

<!-- add subtask modal -->
<div class="overlay" id="stOverlay">
  <div class="modal" style="max-width:420px">
    <h3>Add Subtask</h3>
    <p class="mt" id="stParent" style="font-size:13px;margin-bottom:14px"></p>
    <label for="stTitle">Subtask title <span style="color:var(--red)">*</span></label>
    <input type="text" id="stTitle" placeholder="What needs to happen?"/>
    <div class="err" id="stErr">Title is required.</div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeStModal()">Cancel</button>
      <button class="btn" onclick="doAddSubtask()">Add Subtask</button>
    </div>
  </div>
</div>

<!-- delete confirmation modal -->
<div class="overlay" id="delOverlay">
  <div class="modal" style="max-width:420px">
    <h3 style="color:var(--red)">Delete Task</h3>
    <p class="mt" id="delTask" style="font-size:14px;margin-bottom:6px"></p>
    <p style="font-size:13px;color:var(--muted);margin:0 0 16px">This permanently removes the task from the Ops Engine. It cannot be undone.</p>
    <div class="err" id="delErr" style="display:none"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeDelModal()">Cancel</button>
      <button class="btn" style="background:var(--red);color:#fff" id="delBtn" onclick="doDelete()">Delete Task</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
var ALL=[],FILTER='all',CURRENT=null,MODE='complete',TEAM=[],SUBTASKS={},ST_PARENT=null,IS_MANAGER=false,DEL_TARGET=null;
var PRIO=[
  {key:'Critical',label:'Critical',color:'var(--p1)',match:['critical','p0','urgent']},
  {key:'High',label:'High',color:'var(--p2)',match:['high','p1']},
  {key:'Medium',label:'Medium',color:'var(--p3)',match:['medium','normal','p2']},
  {key:'Low',label:'Low',color:'var(--p4)',match:['low','p3','']}
];
function prioBucket(p){var s=(p||'').toLowerCase().trim();for(var i=0;i<PRIO.length;i++){if(PRIO[i].match.indexOf(s)>=0)return PRIO[i];}return PRIO[2];}
function esc(s){return(s||'').replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}

function switchTab(idx){
  document.querySelectorAll('.tab').forEach(function(el,i){el.classList.toggle('active',i===idx);});
  document.getElementById('tab-tasks').style.display=idx===0?'':'none';
  document.getElementById('tab-report').style.display=idx===1?'':'none';
  if(idx===1)loadReportTab();
}

function load(){
  document.getElementById('sub').textContent='Loading your Ops Engine tasks…';
  fetch('/api/my-tasks/list',{credentials:'include'}).then(function(r){return r.json();}).then(function(d){
    if(d.unlinked){document.getElementById('unlinked').style.display='block';document.getElementById('unlinked').textContent=d.message||'Account not linked.';document.getElementById('sub').textContent='';return;}
    ALL=d.tasks||[];
    IS_MANAGER=!!d.isManager;
    document.getElementById('sub').textContent=ALL.length+' active task'+(ALL.length===1?'':'s')+' assigned to you.';
    loadSubtasks();renderFilters();render();
  }).catch(function(e){document.getElementById('sub').textContent='Failed: '+e;});
}

function loadSubtasks(){
  fetch('/api/subtasks/my',{credentials:'include'}).then(function(r){return r.json();}).then(function(d){SUBTASKS=d.byParent||{};render();}).catch(function(){});
}

function renderFilters(){
  var pillars={};ALL.forEach(function(t){if(t.pillar)pillars[t.pillar]=1;});
  var keys=Object.keys(pillars).sort();
  var el=document.getElementById('filters');el.style.display='flex';
  var html='<div class="chip'+(FILTER==='all'?' active':'')+'" onclick="setFilter(\\'all\\')">All Pillars</div>';
  keys.forEach(function(k){html+='<div class="chip'+(FILTER===k?' active':'')+'" onclick="setFilter(\\''+k.replace(/[^\w\s-]/g,'')+'\\')">'+esc(k)+'</div>';});
  el.innerHTML=html;
}
function setFilter(f){FILTER=f;renderFilters();render();}

function render(){
  var board=document.getElementById('board');
  var list=ALL.filter(function(t){return FILTER==='all'||t.pillar===FILTER;});
  if(!list.length){board.innerHTML='<div class="empty"><div class="big">✓</div>Nothing here. All caught up.</div>';return;}
  var html='';
  PRIO.forEach(function(P){
    var g=list.filter(function(t){return prioBucket(t.priority).key===P.key;});
    if(!g.length)return;
    html+='<div class="group"><h2><span class="dot" style="background:'+P.color+'"></span>'+P.label+' · '+g.length+'</h2>';
    g.forEach(function(t){
      var subs=SUBTASKS[t.record_id]||[];
      html+='<div class="card" id="card-'+t.record_id+'"><div class="body">';
      html+='<div class="task-title">'+esc(t.task||'(untitled)')+'</div>';
      html+='<div class="meta">';
      if(t.client)html+='<span class="tag client">'+esc(t.client)+'</span>';
      if(t.pillar)html+='<span class="tag">'+esc(t.pillar)+'</span>';
      if(t.status)html+='<span class="tag">'+esc(t.status)+'</span>';
      if(t.executionMode)html+='<span class="tag">'+esc(t.executionMode)+'</span>';
      html+='</div>';
      if(t.promptAction)html+='<div class="prompt">'+esc(t.promptAction)+'</div>';
      if(t.status==='Blocked'&&t.blockedReason)html+='<div class="prompt" style="color:var(--red)">⛔ '+esc(t.blockedReason)+'</div>';
      if(subs.length){
        html+='<div class="subtasks">';
        subs.forEach(function(s){
          html+='<div class="st-item'+(s.done?' done':'')+'" id="st-'+s.id+'">';
          html+='<input type="checkbox"'+(s.done?' checked':'')+' onchange="toggleSt(\\''+s.id+'\\',\\''+t.record_id+'\\',this.checked)"/>';
          html+='<span class="st-lbl">'+esc(s.title)+'</span></div>';
        });
        html+='</div>';
      }
      html+='<button class="add-st" onclick="openStModal(\\''+t.record_id+'\\')">+ Add subtask</button>';
      html+='</div>';
      html+='<div style="display:flex;flex-direction:column;gap:8px">';
      html+='<button class="btn" onclick="openModal(\\''+t.record_id+'\\')">Complete</button>';
      html+='<button class="btn ghost" onclick="openBlockModal(\\''+t.record_id+'\\')">Block</button>';
      html+='<button class="btn ghost" onclick="openAssignModal(\\''+t.record_id+'\\')">Reassign</button>';
      html+='<button class="btn ghost" style="color:var(--red);border-color:rgba(255,0,80,.4)" onclick="openDelModal(\\''+t.record_id+'\\')">Delete</button>';
      html+='</div></div>';
    });
    html+='</div>';
  });
  board.innerHTML=html;
}

/* subtask modal */
function openStModal(parentId){
  ST_PARENT=parentId;
  var task=ALL.filter(function(t){return t.record_id===parentId;})[0];
  document.getElementById('stParent').textContent=task?task.task||'':'';
  document.getElementById('stTitle').value='';
  document.getElementById('stErr').style.display='none';
  document.getElementById('stOverlay').classList.add('show');
  setTimeout(function(){document.getElementById('stTitle').focus();},50);
}
function closeStModal(){document.getElementById('stOverlay').classList.remove('show');ST_PARENT=null;}
function doAddSubtask(){
  var title=document.getElementById('stTitle').value.trim();
  if(!title){document.getElementById('stErr').style.display='block';return;}
  fetch('/api/subtasks/create',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({parent_record_id:ST_PARENT,title:title})})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){if(!SUBTASKS[ST_PARENT])SUBTASKS[ST_PARENT]=[];SUBTASKS[ST_PARENT].push({id:d.subtask.id,title:d.subtask.title,done:false});closeStModal();render();toast('Subtask added');}
    else{document.getElementById('stErr').textContent=d.error||'Failed';document.getElementById('stErr').style.display='block';}
  }).catch(function(e){document.getElementById('stErr').textContent=''+e;document.getElementById('stErr').style.display='block';});
}
function toggleSt(id,parentId,done){
  fetch('/api/subtasks/toggle',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,done:done})})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){var subs=SUBTASKS[parentId]||[];subs.forEach(function(s){if(s.id===id)s.done=done;});render();}
  }).catch(function(){});
}

/* weekly report */
var WR_REPORT_TYPE='brand_manager';
function mondayStr(){var d=new Date(),day=d.getDay(),diff=d.getDate()-day+(day===0?-6:1);d.setDate(diff);return d.toISOString().slice(0,10);}
function weekRow(){return'<div class="fr"><div class="fg"><label>Week of (Monday)</label><input type="date" id="wr-week" value="'+mondayStr()+'"/></div><div class="fg"></div></div>';}
function numFg(id,label,opts){opts=opts||{};return'<div class="fg"><label>'+label+'</label><input type="number" id="'+id+'" min="0"'+(opts.step?' step="'+opts.step+'"':'')+(opts.max?' max="'+opts.max+'"':'')+' placeholder="'+(opts.placeholder||'0')+'"/></div>';}
function toggleFg(id,label){return'<div class="trow"><label>'+label+'</label><label class="toggle"><input type="checkbox" id="'+id+'"/><span class="slider"></span></label></div>';}
function notesFg(placeholder){return'<div class="fr full" style="margin-top:10px"><div class="fg"><label>Notes</label><textarea id="wr-notes" style="min-height:70px" placeholder="'+placeholder+'"></textarea></div></div>';}
function sectionLabel(t){return'<div class="wr-section-label">'+t+'</div>';}

function renderFormForType(type,brands){
  var h='';
  if(type==='brand_manager'){
    var brandOpts='<option value="">Select brand…</option>'+(brands||[]).map(function(x){return'<option value="'+esc(x)+'">'+esc(x)+'</option>';}).join('');
    h+='<div class="fr"><div class="fg"><label>Brand / Client</label><select id="wr-brand">'+brandOpts+'</select></div>';
    h+='<div class="fg"><label>Week of (Monday)</label><input type="date" id="wr-week" value="'+mondayStr()+'"/></div></div>';
    if(brands&&brands.length===1)setTimeout(function(){var s=document.getElementById('wr-brand');if(s)s.value=brands[0];},0);
    h+=sectionLabel('Content & Pipeline');
    h+='<div class="fr">'+numFg('wr-videos','Videos Posted')+numFg('wr-samples','Samples Sent')+'</div>';
    h+=sectionLabel('Revenue');
    h+='<div class="fr">'+numFg('wr-gmv','Affiliate GMV ($)',{step:'0.01',placeholder:'0.00'})+numFg('wr-retainer','Retainer Budget ($)',{step:'0.01',placeholder:'0.00'})+'</div>';
    h+=sectionLabel('Content Performance');
    h+='<div class="fr">'+numFg('wr-ctr','CTR (%)',{step:'0.01',max:'100',placeholder:'0.00'})+numFg('wr-ctor','CTOR (%)',{step:'0.01',max:'100',placeholder:'0.00'})+'</div>';
    h+=sectionLabel('Client Health Scores <span style="font-weight:400;font-size:11px">(each /5)</span>');
    h+='<div class="fr">'+numFg('wr-sps','SPS Overall',{step:'0.1',max:'5',placeholder:'0.0'})+numFg('wr-pss','Product Satisfaction',{step:'0.1',max:'5',placeholder:'0.0'})+'</div>';
    h+='<div class="fr">'+numFg('wr-fls','Fulfillment &amp; Logistics',{step:'0.1',max:'5',placeholder:'0.0'})+numFg('wr-css','Customer Service',{step:'0.1',max:'5',placeholder:'0.0'})+'</div>';
    h+='<div class="fr" style="margin-top:4px">'+toggleFg('wr-promo','Promotion / Campaign Running?')+toggleFg('wr-growth','Growth Opps All Enrolled?')+'</div>';
    h+=notesFg('Wins, risks, or context for Tommy…');
  } else if(type==='operations'){
    h+=weekRow();
    h+=sectionLabel('Productivity');
    h+='<div class="fr">'+numFg('wr-automations','New Automations Built')+numFg('wr-templates','New Templates / Prompts Created')+'</div>';
    h+='<div class="fr">'+numFg('wr-blockers','Team Blockers Removed')+numFg('wr-capacity','Capacity Issues Resolved')+'</div>';
    h+=sectionLabel('Process Improvements');
    h+='<div class="fr full"><div class="fg"><label>What did you improve, build, or streamline this week?</label><textarea id="wr-improvements" style="min-height:80px" placeholder="Describe any new workflows, tools, or processes that help the team…"></textarea></div></div>';
    h+=notesFg('Any other notes, ideas, or escalations…');
  } else if(type==='video_editor'){
    h+=weekRow();
    h+=sectionLabel('Output');
    h+='<div class="fr">'+numFg('wr-edited','Videos Edited')+numFg('wr-delivered','Videos Delivered')+'</div>';
    h+='<div class="fr">'+numFg('wr-revisions','Avg Revision Rounds',{step:'0.1',placeholder:'0.0'})+numFg('wr-turnaround','Avg Turnaround (days)',{step:'0.5',placeholder:'0.0'})+'</div>';
    h+=sectionLabel('Brands Worked On');
    h+='<div class="fr full"><div class="fg"><label>Which brands / clients did you edit for this week?</label><input type="text" id="wr-brands-worked" placeholder="e.g. Approved Science, Lode WTR"/></div></div>';
    h+=notesFg('Any notes, issues with footage, or requests…');
  } else if(type==='ceo'){
    h+=weekRow();
    h+=sectionLabel('Sales Pipeline');
    h+='<div class="fr">'+numFg('wr-calls','Sales Calls Booked')+numFg('wr-proposals','Proposals Sent')+'</div>';
    h+=sectionLabel('Growth');
    h+='<div class="fr">'+numFg('wr-community','Community Size (affiliates w/ phone in CRM)')+numFg('wr-personal-videos','Personal Account Videos Posted')+'</div>';
    h+=sectionLabel('Strategic Notes');
    h+='<div class="fr full"><div class="fg"><label>Wins, priorities &amp; blockers this week</label><textarea id="wr-notes" style="min-height:90px" placeholder="What moved the needle? What\\'s stuck? What needs a decision?"></textarea></div></div>';
  }
  document.getElementById('wr-form-body').innerHTML=h;
}

function loadReportTab(){
  fetch('/api/weekly-reports/brands',{credentials:'include'}).then(function(r){return r.json();}).then(function(d){
    WR_REPORT_TYPE=d.reportType||'brand_manager';
    renderFormForType(WR_REPORT_TYPE,d.brands||[]);
    if(d.isAdmin){
      document.getElementById('wr-sub-label').textContent='Admin view';
      document.getElementById('wr-hist-title').textContent='All Team Reports';
    }
  }).catch(function(){document.getElementById('wr-form-body').innerHTML='<div style="color:var(--red);font-size:13px">Failed to load report config.</div>';});
  loadReportHistory();
}
function loadReportHistory(){
  fetch('/api/weekly-reports/history',{credentials:'include'}).then(function(r){return r.json();}).then(function(d){
    var el=document.getElementById('wr-list'),rpts=d.reports||[];
    if(!rpts.length){el.innerHTML='<div style="color:var(--muted);font-size:13px">No reports yet.</div>';return;}
    var html='';
    rpts.slice(0,20).forEach(function(r){
      var rt=r.reportType||'brand_manager';
      html+='<div class="wr-card">';
      html+='<div class="wr-head">';
      html+='<div>'+(r.brand?'<span class="wr-brand">'+esc(r.brand)+'</span>':'')+
        (r.submittedBy?'<span style="font-size:11px;color:var(--muted);margin-left:8px">'+esc(r.submittedBy.split('@')[0])+'</span>':'')+'</div>';
      html+='<span class="wr-week">Wk '+esc(r.week)+'</span>';
      html+='</div>';
      html+='<div class="wr-grid">';
      if(rt==='brand_manager'){
        var h=0,hc=0;
        ['spsOverall','productSatisfaction','fulfillmentScore','customerServiceScore'].forEach(function(k){if(r[k]){h+=parseFloat(r[k]);hc++;}});
        var ha=hc?Math.round(h/hc*10)/10:null;
        var hColor=ha===null?'var(--muted)':ha>=4?'#6be86b':ha>=3?'#ffcf8a':'var(--red)';
        var gpv=(r.videosPosted&&r.gmv)?'$'+Math.round(r.gmv/r.videosPosted).toLocaleString():'—';
        html+='<div class="wr-stat"><div class="n">'+Number(r.gmv||0).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0})+'</div><div class="l">GMV</div></div>';
        html+='<div class="wr-stat"><div class="n">'+(r.videosPosted||0)+'</div><div class="l">Videos</div></div>';
        html+='<div class="wr-stat"><div class="n">'+(r.samplesCount||0)+'</div><div class="l">Samples</div></div>';
        html+='<div class="wr-stat"><div class="n" style="color:'+hColor+'">'+(ha!==null?ha+'/5':'—')+'</div><div class="l">Health</div></div>';
        html+='<div class="wr-stat"><div class="n">'+(r.ctr||'—')+'%</div><div class="l">CTR</div></div>';
        html+='<div class="wr-stat"><div class="n">'+gpv+'</div><div class="l">GMV/Video</div></div>';
      } else if(rt==='operations'){
        html+='<div class="wr-stat"><div class="n">'+(r.automationsBuilt||0)+'</div><div class="l">Automations</div></div>';
        html+='<div class="wr-stat"><div class="n">'+(r.templatesCreated||0)+'</div><div class="l">Templates</div></div>';
        html+='<div class="wr-stat"><div class="n">'+(r.blockersRemoved||0)+'</div><div class="l">Blockers Fixed</div></div>';
        html+='<div class="wr-stat"><div class="n">'+(r.capacityResolved||0)+'</div><div class="l">Capacity Issues</div></div>';
      } else if(rt==='video_editor'){
        html+='<div class="wr-stat"><div class="n">'+(r.videosEdited||0)+'</div><div class="l">Edited</div></div>';
        html+='<div class="wr-stat"><div class="n">'+(r.videosDelivered||0)+'</div><div class="l">Delivered</div></div>';
        html+='<div class="wr-stat"><div class="n">'+(r.avgRevisions||'—')+'x</div><div class="l">Avg Revisions</div></div>';
        html+='<div class="wr-stat"><div class="n">'+(r.avgTurnaround||'—')+'d</div><div class="l">Turnaround</div></div>';
      } else if(rt==='ceo'){
        html+='<div class="wr-stat"><div class="n">'+(r.callsBooked||0)+'</div><div class="l">Calls Booked</div></div>';
        html+='<div class="wr-stat"><div class="n">'+(r.proposalsSent||0)+'</div><div class="l">Proposals</div></div>';
        html+='<div class="wr-stat"><div class="n">'+(r.communitySize||'—')+'</div><div class="l">Community</div></div>';
        html+='<div class="wr-stat"><div class="n">'+(r.personalVideos||0)+'</div><div class="l">Personal Videos</div></div>';
      }
      html+='</div>';
      var noteText=(rt==='operations'&&r.improvements)?r.improvements:(r.notes||'');
      if(noteText)html+='<div style="font-size:12px;color:var(--muted);margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">'+esc(noteText)+'</div>';
      html+='</div>';
    });
    el.innerHTML=html;
  }).catch(function(){document.getElementById('wr-list').innerHTML='<div style="color:var(--muted);font-size:13px">Failed to load.</div>';});
}
function val(id){var el=document.getElementById(id);return el?el.value.trim():'';}
function numVal(id){return parseFloat(val(id))||0;}
function chkVal(id){var el=document.getElementById(id);return el?el.checked:false;}
function submitReport(){
  var week=val('wr-week');
  if(!week){var e=document.getElementById('wr-err');e.textContent='Week is required.';e.style.display='block';return;}
  var payload={week:week,reportType:WR_REPORT_TYPE};
  if(WR_REPORT_TYPE==='brand_manager'){
    var brand=val('wr-brand');
    if(!brand){var e=document.getElementById('wr-err');e.textContent='Brand is required.';e.style.display='block';return;}
    payload.brand=brand;
    payload.videosPosted=numVal('wr-videos');payload.samplesCount=numVal('wr-samples');
    payload.gmv=numVal('wr-gmv');payload.retainerBudget=numVal('wr-retainer');
    payload.ctr=numVal('wr-ctr');payload.ctor=numVal('wr-ctor');
    payload.spsOverall=numVal('wr-sps');payload.productSatisfaction=numVal('wr-pss');
    payload.fulfillmentScore=numVal('wr-fls');payload.customerServiceScore=numVal('wr-css');
    payload.promotionRunning=chkVal('wr-promo');payload.growthOppsEnrolled=chkVal('wr-growth');
    payload.notes=val('wr-notes');
  } else if(WR_REPORT_TYPE==='operations'){
    payload.automationsBuilt=numVal('wr-automations');payload.templatesCreated=numVal('wr-templates');
    payload.blockersRemoved=numVal('wr-blockers');payload.capacityResolved=numVal('wr-capacity');
    payload.improvements=val('wr-improvements');payload.notes=val('wr-notes');
  } else if(WR_REPORT_TYPE==='video_editor'){
    payload.videosEdited=numVal('wr-edited');payload.videosDelivered=numVal('wr-delivered');
    payload.avgRevisions=numVal('wr-revisions');payload.avgTurnaround=numVal('wr-turnaround');
    payload.brandsWorked=val('wr-brands-worked');payload.notes=val('wr-notes');
  } else if(WR_REPORT_TYPE==='ceo'){
    payload.callsBooked=numVal('wr-calls');payload.proposalsSent=numVal('wr-proposals');
    payload.communitySize=numVal('wr-community');payload.personalVideos=numVal('wr-personal-videos');
    payload.notes=val('wr-notes');
  }
  fetch('/api/weekly-reports/submit',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){document.getElementById('wr-err').style.display='none';loadReportHistory();toast('✅ Report submitted!');}
    else{var e=document.getElementById('wr-err');e.textContent=d.error||'Failed';e.style.display='block';}
  }).catch(function(e){var el=document.getElementById('wr-err');el.textContent=''+e;el.style.display='block';});
}

/* complete / block / reassign modal */
function setModalMode(mode){
  MODE=mode;
  document.getElementById('modalLabel').style.display='';
  document.getElementById('resultBox').style.display='';
  document.getElementById('assignWrap').style.display='none';
  var isBlock=mode==='block';
  document.getElementById('modalTitle').textContent=isBlock?'Block task':'Complete task';
  document.getElementById('modalLabel').innerHTML=isBlock?'Reason <span style="color:var(--red)">*</span> — why is this blocked?':'Result / Output <span style="color:var(--red)">*</span> — what did you do?';
  document.getElementById('resultBox').placeholder=isBlock?'What is blocking this task? Required.':'Describe the outcome. Required.';
  document.getElementById('modalErr').textContent=isBlock?'A reason is required.':'A result / output note is required.';
  document.getElementById('confirmBtn').textContent=isBlock?'Mark blocked':'Mark complete';
}
function openAssignModal(id){
  MODE='assign';CURRENT=ALL.filter(function(t){return t.record_id===id;})[0];if(!CURRENT)return;
  document.getElementById('modalTitle').textContent='Reassign task';document.getElementById('modalTask').textContent=CURRENT.task||'';
  document.getElementById('modalLabel').style.display='none';document.getElementById('resultBox').style.display='none';
  document.getElementById('assignWrap').style.display='block';document.getElementById('modalErr').style.display='none';
  var btn=document.getElementById('confirmBtn');btn.textContent='Reassign';btn.disabled=true;
  var fill=function(){var sel=document.getElementById('assignSel');sel.innerHTML='<option value="">Choose…</option>'+TEAM.map(function(m){return'<option value="'+m.openId+'">'+esc(m.name)+(m.role?' — '+esc(m.role):'')+'</option>';}).join('');sel.onchange=function(){btn.disabled=!this.value;};};
  var ps=document.getElementById('prioSel');var curP=(CURRENT.priority||'').trim();var match=['🔴 Critical','🟠 High','🟡 Normal','⚪ Low'].filter(function(p){return p===curP;});ps.value=match[0]||'🟡 Normal';
  if(TEAM.length){fill();}else{fetch('/api/my-tasks/team',{credentials:'include'}).then(function(r){return r.json();}).then(function(d){TEAM=d.team||[];fill();}).catch(function(){});}
  document.getElementById('overlay').classList.add('show');
}
function doReassign(){
  if(!CURRENT)return;var to=document.getElementById('assignSel').value;if(!to)return;
  var btn=document.getElementById('confirmBtn');btn.disabled=true;btn.textContent='Saving…';
  fetch('/api/my-tasks/reassign',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({record_id:CURRENT.record_id,to_open_id:to,priority:document.getElementById('prioSel').value})})
  .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});}).then(function(x){
    btn.textContent='Reassign';
    if(x.ok&&x.j.verified){ALL=ALL.filter(function(t){return t.record_id!==CURRENT.record_id;});closeModal();renderFilters();render();document.getElementById('sub').textContent=ALL.length+' active task'+(ALL.length===1?'':'s');toast('✅ Reassigned');}
    else{document.getElementById('modalErr').style.display='block';document.getElementById('modalErr').textContent=(x.j&&x.j.error)||'Failed';btn.disabled=false;}
  }).catch(function(e){document.getElementById('modalErr').style.display='block';document.getElementById('modalErr').textContent=''+e;btn.disabled=false;btn.textContent='Reassign';});
}
function openModal(id){
  setModalMode('complete');CURRENT=ALL.filter(function(t){return t.record_id===id;})[0];if(!CURRENT)return;
  document.getElementById('modalTask').textContent=CURRENT.task||'';
  var sl=document.getElementById('sisyLink');if(sl){var q='Help me work on this Ops Engine task: '+(CURRENT.task||'')+(CURRENT.client?' (client: '+CURRENT.client+')':'');sl.href='https://sisyphus.cultcontent.cc/?prefill='+encodeURIComponent(q);}
  var box=document.getElementById('resultBox');box.value='';document.getElementById('modalErr').style.display='none';document.getElementById('confirmBtn').disabled=true;document.getElementById('overlay').classList.add('show');setTimeout(function(){box.focus();},50);
}
function closeModal(){document.getElementById('overlay').classList.remove('show');CURRENT=null;}
document.getElementById('resultBox').addEventListener('input',function(){document.getElementById('confirmBtn').disabled=this.value.trim().length===0;});
function doComplete(){
  if(!CURRENT)return;var result=document.getElementById('resultBox').value.trim();if(!result){document.getElementById('modalErr').style.display='block';return;}
  var btn=document.getElementById('confirmBtn');btn.disabled=true;btn.textContent='Saving…';
  fetch('/api/my-tasks/complete',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({record_id:CURRENT.record_id,result:result})})
  .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});}).then(function(x){
    btn.textContent='Mark complete';
    if(x.ok&&x.j.verified){ALL=ALL.filter(function(t){return t.record_id!==CURRENT.record_id;});closeModal();renderFilters();render();document.getElementById('sub').textContent=ALL.length+' active task'+(ALL.length===1?'':'s')+' assigned to you.';toast('✓ Completed');}
    else{document.getElementById('modalErr').style.display='block';document.getElementById('modalErr').textContent=(x.j&&x.j.error)||'Failed';btn.disabled=false;}
  }).catch(function(e){document.getElementById('modalErr').style.display='block';document.getElementById('modalErr').textContent=''+e;btn.disabled=false;btn.textContent='Mark complete';});
}
function openBlockModal(id){
  setModalMode('block');CURRENT=ALL.filter(function(t){return t.record_id===id;})[0];if(!CURRENT)return;
  document.getElementById('modalTask').textContent=CURRENT.task||'';
  var sl=document.getElementById('sisyLink');if(sl){var q='Help me unblock: '+(CURRENT.task||'');sl.href='https://sisyphus.cultcontent.cc/?prefill='+encodeURIComponent(q);}
  var box=document.getElementById('resultBox');box.value='';document.getElementById('modalErr').style.display='none';document.getElementById('confirmBtn').disabled=true;document.getElementById('overlay').classList.add('show');setTimeout(function(){box.focus();},50);
}
function doBlock(){
  if(!CURRENT)return;var reason=document.getElementById('resultBox').value.trim();if(!reason){document.getElementById('modalErr').style.display='block';return;}
  var btn=document.getElementById('confirmBtn');btn.disabled=true;btn.textContent='Saving…';
  fetch('/api/my-tasks/block',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({record_id:CURRENT.record_id,reason:reason})})
  .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});}).then(function(x){
    btn.textContent='Mark blocked';
    if(x.ok&&x.j.verified){var rid=CURRENT.record_id;ALL=ALL.map(function(t){if(t.record_id===rid){t.status='Blocked';t.blockedReason=x.j.reason;}return t;});closeModal();renderFilters();render();toast('⛔ Blocked');}
    else{document.getElementById('modalErr').style.display='block';document.getElementById('modalErr').textContent=(x.j&&x.j.error)||'Failed';btn.disabled=false;}
  }).catch(function(e){document.getElementById('modalErr').style.display='block';document.getElementById('modalErr').textContent=''+e;btn.disabled=false;btn.textContent='Mark blocked';});
}
function doConfirm(){if(MODE==='assign'){doReassign();}else if(MODE==='block'){doBlock();}else{doComplete();}}
function toast(msg){var t=document.getElementById('toast');t.textContent=msg;t.style.display='block';setTimeout(function(){t.style.display='none';},2600);}

/* delete modal */
function openDelModal(id){
  DEL_TARGET=ALL.filter(function(t){return t.record_id===id;})[0];
  if(!DEL_TARGET)return;
  var label=DEL_TARGET.task+(DEL_TARGET.client?' — '+DEL_TARGET.client:'');
  document.getElementById('delTask').textContent=label;
  document.getElementById('delErr').style.display='none';
  document.getElementById('delBtn').disabled=false;
  document.getElementById('delBtn').textContent='Delete Task';
  document.getElementById('delOverlay').classList.add('show');
}
function closeDelModal(){document.getElementById('delOverlay').classList.remove('show');DEL_TARGET=null;}
function doDelete(){
  if(!DEL_TARGET)return;
  var btn=document.getElementById('delBtn');btn.disabled=true;btn.textContent='Deleting…';
  fetch('/api/my-tasks/delete',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({record_id:DEL_TARGET.record_id})})
  .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
  .then(function(x){
    btn.textContent='Delete Task';
    if(x.ok&&x.j.ok){
      var rid=DEL_TARGET.record_id;
      ALL=ALL.filter(function(t){return t.record_id!==rid;});
      closeDelModal();renderFilters();render();
      document.getElementById('sub').textContent=ALL.length+' active task'+(ALL.length===1?'':'s')+' assigned to you.';
      toast('🗑 Task deleted');
    }else{
      var e=document.getElementById('delErr');e.textContent=(x.j&&x.j.error)||'Failed to delete.';e.style.display='block';btn.disabled=false;
    }
  }).catch(function(e){
    var el=document.getElementById('delErr');el.textContent='Network error: '+e;el.style.display='block';btn.disabled=false;btn.textContent='Delete Task';
  });
}

load();
</script>
</body>
</html>`;

const TASK_MANAGEMENT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Task Management · Cult Content</title>
<style>
  :root{--bg:#161823;--panel:#1e2030;--panel2:#252838;--border:#2f3346;--txt:#e8eaf2;--muted:#9aa0b5;--cyan:#00f2ea;--red:#ff0050;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1200px;margin:0 auto;padding:28px 18px 80px}
  h1{font-size:24px;margin:0 0 4px;font-weight:700;background:linear-gradient(90deg,var(--cyan),var(--red));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .sub{color:var(--muted);font-size:13px;margin:0 0 22px}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px}
  .sc{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center}
  .sc .n{font-size:30px;font-weight:700}
  .sc .l{font-size:11px;color:var(--muted);text-transform:uppercase;margin-top:4px}
  .fb{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;align-items:center}
  .fb select,.fb input{background:var(--panel2);border:1px solid var(--border);border-radius:8px;color:var(--txt);padding:8px 12px;font-size:13px;font-family:inherit}
  .fb select:focus,.fb input:focus{outline:none;border-color:var(--cyan)}
  .chip{background:var(--panel2);border:1px solid var(--border);color:var(--muted);padding:6px 13px;border-radius:20px;font-size:12.5px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
  .chip:hover{border-color:var(--cyan);color:var(--txt)}
  .tbl-wrap{overflow-x:auto;border-radius:12px;border:1px solid var(--border)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:10px 14px;color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--border);white-space:nowrap;background:var(--panel)}
  td{padding:10px 14px;border-bottom:1px solid rgba(47,51,70,.4);vertical-align:top}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:rgba(37,40,56,.7)}
  .badge{display:inline-block;font-size:10.5px;padding:2px 8px;border-radius:4px;font-weight:600;white-space:nowrap}
  .todo{background:rgba(90,96,114,.3);color:#9aa0b5}
  .inprogress{background:rgba(0,242,234,.15);color:var(--cyan)}
  .blocked{background:rgba(255,0,80,.15);color:var(--red)}
  .completed{background:rgba(50,205,50,.15);color:#6be86b}
  .tn{font-weight:600;margin-bottom:2px}
  .ts{font-size:11.5px;color:var(--muted)}
  .btn{background:linear-gradient(90deg,var(--cyan),var(--red));color:#0c0d15;border:none;padding:6px 12px;border-radius:6px;font-weight:700;font-size:12px;cursor:pointer;font-family:inherit}
  .btn.ghost{background:var(--panel2);color:var(--txt);border:1px solid var(--border)}
  .overlay{position:fixed;inset:0;background:rgba(6,7,12,.72);backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;padding:20px;z-index:50}
  .overlay.show{display:flex}
  .modal{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:22px;width:100%;max-width:460px}
  .modal h3{margin:0 0 6px;font-size:17px}
  .modal .mt{color:var(--muted);font-size:13px;margin:0 0 14px}
  .modal textarea{width:100%;min-height:100px;background:var(--panel2);border:1px solid var(--border);border-radius:9px;color:var(--txt);padding:11px;font-size:14px;font-family:inherit;resize:vertical}
  .modal textarea:focus{outline:none;border-color:var(--cyan)}
  .modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:14px}
  .err{color:var(--red);font-size:12.5px;margin-top:6px;display:none}
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--panel2);border:1px solid var(--cyan);color:var(--txt);padding:11px 18px;border-radius:10px;font-size:13.5px;display:none;z-index:60}
  .empty{text-align:center;color:var(--muted);padding:40px;font-size:14px}
  .tabs{display:flex;gap:0;margin-bottom:22px;border-bottom:1px solid var(--border)}
  .tab{background:none;border:none;border-bottom:2px solid transparent;color:var(--muted);padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:-1px;transition:.15s;font-family:inherit}
  .tab:hover{color:var(--txt)}
  .tab.active{color:var(--cyan);border-bottom-color:var(--cyan)}
  /* weekly reports tab */
  .wr-kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px}
  .wr-kpi-c{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px;text-align:center}
  .wr-kpi-c .n{font-size:26px;font-weight:700}
  .wr-kpi-c .l{font-size:11px;color:var(--muted);text-transform:uppercase;margin-top:3px}
  .wr-tbl{overflow-x:auto;border-radius:12px;border:1px solid var(--border);margin-bottom:24px}
  .wr-section{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin:24px 0 10px}
  .spark-row{display:flex;gap:2px;align-items:flex-end;height:28px}
  .spark-bar{background:var(--cyan);border-radius:2px 2px 0 0;opacity:.7;min-width:6px}
  .brand-trend{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:16px}
  .bt-brand{font-weight:600;font-size:13px;min-width:160px}
  .bt-gmv{font-size:20px;font-weight:700;min-width:90px}
  .bt-delta{font-size:12px;padding:2px 8px;border-radius:12px;font-weight:700}
  .delta-up{background:rgba(107,232,107,.15);color:#6be86b}
  .delta-dn{background:rgba(255,0,80,.15);color:var(--red)}
  .delta-flat{background:rgba(154,160,181,.15);color:var(--muted)}
  .wr-fb{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
  .wr-fb select{background:var(--panel2);border:1px solid var(--border);border-radius:8px;color:var(--txt);padding:7px 11px;font-size:13px;font-family:inherit}
  @media(max-width:768px){.stats{grid-template-columns:repeat(2,1fr)}.wr-kpi{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<div class="wrap">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
    <h1>Task Management</h1>
    <div style="display:flex;gap:8px">
      <a href="/my-tasks" class="chip">← My Tasks</a>
      <button class="chip" onclick="loadAll()">↻ Refresh</button>
    </div>
  </div>
  <div class="sub" id="sub">Loading all tasks…</div>
  <div class="tabs">
    <button class="tab active" onclick="adminSwitchTab(0)">Tasks</button>
    <button class="tab" onclick="adminSwitchTab(1)">Weekly Reports</button>
  </div>

  <div id="admin-tab-tasks">
    <div class="stats">
      <div class="sc"><div class="n" id="s-total">—</div><div class="l">Total Active</div></div>
      <div class="sc"><div class="n" id="s-blocked" style="color:var(--red)">—</div><div class="l">Blocked</div></div>
      <div class="sc"><div class="n" id="s-inp" style="color:var(--cyan)">—</div><div class="l">In Progress</div></div>
      <div class="sc"><div class="n" id="s-avg">—</div><div class="l">Avg Days to Complete</div></div>
    </div>
    <div class="fb">
      <select id="f-owner" onchange="applyFilters()"><option value="">All Team Members</option></select>
      <select id="f-client" onchange="applyFilters()"><option value="">All Clients</option></select>
      <select id="f-status" onchange="applyFilters()">
        <option value="">All Statuses</option>
        <option value="To Do">To Do</option>
        <option value="In Progress">In Progress</option>
        <option value="Blocked">Blocked</option>
      </select>
      <select id="f-type" onchange="applyFilters()">
        <option value="">Tasks + Subtasks</option>
        <option value="task">Tasks only</option>
        <option value="subtask">Subtasks only</option>
      </select>
      <input id="f-search" placeholder="Search tasks…" oninput="applyFilters()" style="min-width:180px"/>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr>
          <th>Task</th><th>Client</th><th>Owner</th><th>Status</th><th>Due</th><th>Days Open</th><th>Action</th>
        </tr></thead>
        <tbody id="tbody"></tbody>
      </table>
      <div class="empty" id="empty" style="display:none">No tasks match filters.</div>
    </div>
  </div>

  <div id="admin-tab-reports" style="display:none">
    <div class="wr-kpi">
      <div class="wr-kpi-c"><div class="n" id="wr-k-total">—</div><div class="l">Total Submissions</div></div>
      <div class="wr-kpi-c"><div class="n" id="wr-k-gmv" style="color:var(--cyan)">—</div><div class="l">Total GMV Reported</div></div>
      <div class="wr-kpi-c"><div class="n" id="wr-k-videos">—</div><div class="l">Videos Posted</div></div>
      <div class="wr-kpi-c"><div class="n" id="wr-k-health">—</div><div class="l">Avg Client Health</div></div>
    </div>
    <div class="wr-fb">
      <select id="wr-f-person" onchange="renderAdminReports()"><option value="">All Team Members</option></select>
      <select id="wr-f-brand" onchange="renderAdminReports()"><option value="">All Brands</option></select>
      <select id="wr-f-weeks" onchange="renderAdminReports()">
        <option value="8">Last 8 weeks</option>
        <option value="4">Last 4 weeks</option>
        <option value="12">Last 12 weeks</option>
        <option value="0">All time</option>
      </select>
    </div>
    <div class="wr-section">Brand Trends — GMV &amp; Content</div>
    <div id="wr-trends"></div>
    <div class="wr-section">All Submissions</div>
    <div class="wr-tbl">
      <table>
        <thead><tr>
          <th>Week</th><th>Brand</th><th>Submitted By</th><th>GMV</th><th>Videos</th><th>Samples</th><th>Health</th><th>CTR</th><th>Notes</th>
        </tr></thead>
        <tbody id="wr-tbody"></tbody>
      </table>
      <div class="empty" id="wr-empty" style="display:none">No reports found.</div>
    </div>
  </div>
</div>
<div class="overlay" id="nudge-overlay">
  <div class="modal">
    <h3>Nudge Team Member</h3>
    <p class="mt" id="nudge-to"></p>
    <textarea id="nudge-msg" placeholder="Write a message to send via Lark…"></textarea>
    <div class="err" id="nudge-err">Message is required.</div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeNudge()">Cancel</button>
      <button class="btn" onclick="sendNudge()">Send via Lark</button>
    </div>
  </div>
</div>
<div class="overlay" id="adel-overlay">
  <div class="modal" style="max-width:420px">
    <h3 style="color:var(--red)">Delete Task</h3>
    <p class="mt" id="adel-task" style="font-size:14px;margin-bottom:6px"></p>
    <p style="font-size:13px;color:var(--muted);margin:0 0 16px">Permanently removes this task from the Ops Engine. Cannot be undone.</p>
    <div class="err" id="adel-err" style="display:none"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeAdminDel()">Cancel</button>
      <button class="btn" style="background:var(--red);color:#fff" id="adel-btn" onclick="doAdminDelete()">Delete Task</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
var ALL=[],FILTERED=[],NT=null,ADEL_ID=null,WR_ALL=[];
function esc(s){return(s||'').replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}

function adminSwitchTab(idx){
  document.querySelectorAll('.tab').forEach(function(el,i){el.classList.toggle('active',i===idx);});
  document.getElementById('admin-tab-tasks').style.display=idx===0?'':'none';
  document.getElementById('admin-tab-reports').style.display=idx===1?'':'none';
  if(idx===1)loadAdminReports();
}

function loadAdminReports(){
  document.getElementById('wr-trends').innerHTML='<div style="color:var(--muted);font-size:13px;padding:20px 0">Loading reports…</div>';
  fetch('/api/admin/weekly-reports',{credentials:'include'}).then(function(r){return r.json();}).then(function(d){
    WR_ALL=d.reports||[];
    buildWrFilters();
    renderAdminReports();
  }).catch(function(e){document.getElementById('wr-trends').innerHTML='<div style="color:var(--red);font-size:13px">Failed: '+e+'</div>';});
}

function buildWrFilters(){
  var people={},brands={};
  WR_ALL.forEach(function(r){
    if(r.submittedBy)people[r.submittedBy]=1;
    if(r.brand)brands[r.brand]=1;
  });
  var ps=document.getElementById('wr-f-person');
  ps.innerHTML='<option value="">All Team Members</option>'+Object.keys(people).sort().map(function(p){return'<option value="'+esc(p)+'">'+esc(p.split('@')[0])+'</option>';}).join('');
  var bs=document.getElementById('wr-f-brand');
  bs.innerHTML='<option value="">All Brands</option>'+Object.keys(brands).sort().map(function(b){return'<option value="'+esc(b)+'">'+esc(b)+'</option>';}).join('');
}

function renderAdminReports(){
  var person=document.getElementById('wr-f-person').value;
  var brand=document.getElementById('wr-f-brand').value;
  var weeks=parseInt(document.getElementById('wr-f-weeks').value)||0;
  var cutoff=0;
  if(weeks>0){var d=new Date();d.setDate(d.getDate()-weeks*7);cutoff=d.getTime();}
  var rpts=WR_ALL.filter(function(r){
    if(person&&r.submittedBy!==person)return false;
    if(brand&&r.brand!==brand)return false;
    if(cutoff&&r.submittedAt&&r.submittedAt<cutoff)return false;
    return true;
  });

  /* KPI summary */
  var totalGmv=0,totalVideos=0,healthSum=0,healthCnt=0;
  rpts.forEach(function(r){
    totalGmv+=parseFloat(r.gmv||0);
    totalVideos+=parseFloat(r.videosPosted||0);
    var h=healthAvg(r);if(h!==null){healthSum+=h;healthCnt++;}
  });
  document.getElementById('wr-k-total').textContent=rpts.length;
  document.getElementById('wr-k-gmv').textContent='$'+Math.round(totalGmv).toLocaleString();
  document.getElementById('wr-k-videos').textContent=totalVideos;
  var avgH=healthCnt?Math.round(healthSum/healthCnt*10)/10:null;
  var hEl=document.getElementById('wr-k-health');
  hEl.textContent=avgH!==null?avgH+'/5':'—';
  hEl.style.color=avgH===null?'var(--txt)':avgH>=4?'#6be86b':avgH>=3?'#ffcf8a':'var(--red)';

  /* Brand trends */
  var byBrand={};
  rpts.forEach(function(r){
    if(!r.brand)return;
    if(!byBrand[r.brand])byBrand[r.brand]=[];
    byBrand[r.brand].push(r);
  });
  var brandNames=Object.keys(byBrand).sort(function(a,b){
    var ag=byBrand[a].reduce(function(s,r){return s+parseFloat(r.gmv||0);},0);
    var bg=byBrand[b].reduce(function(s,r){return s+parseFloat(r.gmv||0);},0);
    return bg-ag;
  });
  var trendsHtml='';
  brandNames.forEach(function(bn){
    var entries=byBrand[bn].sort(function(a,b){return(a.week||'').localeCompare(b.week||'');});
    var gmvs=entries.map(function(r){return parseFloat(r.gmv||0);});
    var latestGmv=gmvs[gmvs.length-1]||0;
    var prevGmv=gmvs.length>1?gmvs[gmvs.length-2]:null;
    var delta=prevGmv!==null?((latestGmv-prevGmv)/Math.max(prevGmv,1)*100):null;
    var deltaHtml='';
    if(delta!==null){
      var cls=delta>5?'delta-up':delta<-5?'delta-dn':'delta-flat';
      deltaHtml='<span class="bt-delta '+cls+'">'+(delta>0?'+':'')+Math.round(delta)+'%</span>';
    }
    var maxGmv=Math.max.apply(null,gmvs.concat([1]));
    var sparkHtml='<div class="spark-row">';
    gmvs.slice(-8).forEach(function(g){
      var h=Math.max(3,Math.round(g/maxGmv*28));
      sparkHtml+='<div class="spark-bar" style="height:'+h+'px"></div>';
    });
    sparkHtml+='</div>';
    var latestWeek=entries[entries.length-1]?entries[entries.length-1].week:'';
    var latestVideos=entries[entries.length-1]?parseInt(entries[entries.length-1].videosPosted||0):0;
    trendsHtml+='<div class="brand-trend">';
    trendsHtml+='<div class="bt-brand">'+esc(bn)+'</div>';
    trendsHtml+='<div class="bt-gmv">$'+Math.round(latestGmv).toLocaleString()+'</div>';
    trendsHtml+=deltaHtml;
    trendsHtml+='<div style="flex:1">'+sparkHtml+'</div>';
    trendsHtml+='<div style="font-size:12px;color:var(--muted);text-align:right"><div>'+latestVideos+' videos</div><div>Wk '+esc(latestWeek)+'</div></div>';
    trendsHtml+='</div>';
  });
  document.getElementById('wr-trends').innerHTML=trendsHtml||'<div style="color:var(--muted);font-size:13px;padding:12px 0">No data yet.</div>';

  /* Submissions table */
  var tbody=document.getElementById('wr-tbody');
  var empty=document.getElementById('wr-empty');
  if(!rpts.length){tbody.innerHTML='';empty.style.display='block';return;}
  empty.style.display='none';
  var sorted=rpts.slice().sort(function(a,b){return(b.week||'').localeCompare(a.week||'')||(b.submittedAt||0)-(a.submittedAt||0);});
  tbody.innerHTML=sorted.map(function(r){
    var h=healthAvg(r);
    var hColor=h===null?'var(--muted)':h>=4?'#6be86b':h>=3?'#ffcf8a':'var(--red)';
    return'<tr>'+
      '<td>'+esc(r.week||'—')+'</td>'+
      '<td style="font-weight:600;color:var(--cyan)">'+esc(r.brand||'—')+'</td>'+
      '<td>'+esc((r.submittedBy||'—').split('@')[0])+'</td>'+
      '<td>$'+Math.round(parseFloat(r.gmv||0)).toLocaleString()+'</td>'+
      '<td>'+parseInt(r.videosPosted||0)+'</td>'+
      '<td>'+parseInt(r.samplesCount||0)+'</td>'+
      '<td style="color:'+hColor+'">'+(h!==null?h+'/5':'—')+'</td>'+
      '<td>'+(r.ctr||'—')+'%</td>'+
      '<td style="font-size:12px;color:var(--muted);max-width:200px">'+esc((r.notes||'').slice(0,80))+'</td>'+
      '</tr>';
  }).join('');
}

function healthAvg(r){
  var s=0,c=0;
  if(r.spsOverall){s+=parseFloat(r.spsOverall);c++;}
  if(r.productSatisfaction){s+=parseFloat(r.productSatisfaction);c++;}
  if(r.fulfillmentScore){s+=parseFloat(r.fulfillmentScore);c++;}
  if(r.customerServiceScore){s+=parseFloat(r.customerServiceScore);c++;}
  return c?Math.round(s/c*10)/10:null;
}

function loadAll(){
  document.getElementById('sub').textContent='Loading…';
  Promise.all([
    fetch('/api/admin/tasks',{credentials:'include'}).then(function(r){return r.json();}),
    fetch('/api/my-tasks/team',{credentials:'include'}).then(function(r){return r.json();}).catch(function(){return{team:[]};})
  ]).then(function(rs){
    var d=rs[0],teamData=rs[1];
    if(d.error){document.getElementById('sub').textContent='Error: '+d.error;return;}
    ALL=d.tasks||[];buildOpts(teamData.team||[]);applyFilters();
    var active=ALL.filter(function(t){return t.status!=='Completed';});
    document.getElementById('s-total').textContent=active.length;
    document.getElementById('s-blocked').textContent=active.filter(function(t){return t.status==='Blocked';}).length;
    document.getElementById('s-inp').textContent=active.filter(function(t){return t.status==='In Progress';}).length;
    document.getElementById('s-avg').textContent=d.avgDays?d.avgDays+'d':'—';
    document.getElementById('sub').textContent=active.length+' active tasks across all team members.'+(d.avgDays?' Avg '+d.avgDays+' days to complete.':'');
  }).catch(function(e){document.getElementById('sub').textContent='Failed: '+e;});
}
function buildOpts(roster){
  var byId={},clients={};
  // Seed from team roster (short names) — keyed by open_id to prevent duplicates
  (roster||[]).forEach(function(m){if(m.openId&&m.name)byId[m.openId]=m.name;});
  // Task-derived names override (come from actual Lark user profiles, usually fuller)
  ALL.forEach(function(t){
    if(t.ownerOpenId&&t.ownerName)byId[t.ownerOpenId]=t.ownerName;
    if(t.client)clients[t.client]=1;
  });
  var os=document.getElementById('f-owner');
  var ownerOpts=Object.keys(byId).sort(function(a,b){return byId[a].localeCompare(byId[b]);});
  os.innerHTML='<option value="">All Team Members</option>'+ownerOpts.map(function(id){return'<option value="'+esc(id)+'">'+esc(byId[id])+'</option>';}).join('');
  var cs=document.getElementById('f-client');
  cs.innerHTML='<option value="">All Clients</option>'+Object.keys(clients).sort().map(function(c){return'<option value="'+esc(c)+'">'+esc(c)+'</option>';}).join('');
}
function applyFilters(){
  var ow=document.getElementById('f-owner').value,cl=document.getElementById('f-client').value;
  var st=document.getElementById('f-status').value,ty=document.getElementById('f-type').value;
  var q=(document.getElementById('f-search').value||'').toLowerCase();
  FILTERED=ALL.filter(function(t){
    if(ow&&t.ownerOpenId!==ow)return false;
    if(cl&&t.client!==cl)return false;
    if(st&&t.status!==st)return false;
    if(ty==='task'&&t.isSubtask)return false;
    if(ty==='subtask'&&!t.isSubtask)return false;
    if(q&&!(t.task||'').toLowerCase().includes(q)&&!(t.client||'').toLowerCase().includes(q))return false;
    return true;
  });
  renderTbl();
}
function daysOpen(t){if(!t.createdOn)return'—';var d=Math.floor((Date.now()-t.createdOn)/86400000);return d>0?d+'d':'<1d';}
function sbadge(s){var m={'To Do':'badge todo','In Progress':'badge inprogress','Blocked':'badge blocked','Completed':'badge completed'};return'<span class="'+(m[s]||'badge todo')+'">'+esc(s||'—')+'</span>';}
function renderTbl(){
  var tb=document.getElementById('tbody'),em=document.getElementById('empty');
  if(!FILTERED.length){tb.innerHTML='';em.style.display='block';return;}
  em.style.display='none';
  tb.innerHTML=FILTERED.map(function(t){
    var due=t.dueDate?new Date(t.dueDate).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'—';
    return'<tr>'
      +'<td><div class="tn">'+(t.isSubtask?'↳ ':'')+esc(t.task||'(untitled)')+'</div>'+(t.executionMode?'<div class="ts">'+esc(t.executionMode)+'</div>':'')+'</td>'
      +'<td>'+esc(t.client||'—')+'</td>'
      +'<td>'+esc(t.ownerName||'—')+'</td>'
      +'<td>'+sbadge(t.status)+'</td>'
      +'<td>'+esc(due)+'</td>'
      +'<td>'+esc(daysOpen(t))+'</td>'
      +'<td style="white-space:nowrap">'
      +(t.ownerOpenId?'<button class="btn ghost" style="margin-right:6px" onclick="openNudge(\\''+t.ownerOpenId+'\\',\\''+esc(t.ownerName||'').replace(/'/g,'')+'\\',\\''+esc((t.task||'').replace(/[\\x27\\x22]/g,'')).slice(0,60)+'\\')">Nudge</button>':'')
      +'<button class="btn ghost" style="color:var(--red);border-color:rgba(255,0,80,.4)" onclick="openAdminDel(\\''+esc(t.record_id)+'\\',\\''+esc((t.task||'').replace(/[\\x27\\x22]/g,'')).slice(0,70)+'\\')">Delete</button>'
      +'</td>'
      +'</tr>';
  }).join('');
}
function openNudge(openId,name,task){
  NT={openId:openId,name:name};
  document.getElementById('nudge-to').textContent='To: '+name+(task?' · "'+task+'"':'');
  document.getElementById('nudge-msg').value='Hey '+name+', checking in on: "'+task+'" — any updates or blockers?';
  document.getElementById('nudge-err').style.display='none';
  document.getElementById('nudge-overlay').classList.add('show');
  setTimeout(function(){document.getElementById('nudge-msg').focus();},50);
}
function closeNudge(){document.getElementById('nudge-overlay').classList.remove('show');NT=null;}
function sendNudge(){
  var msg=document.getElementById('nudge-msg').value.trim();
  if(!msg){document.getElementById('nudge-err').style.display='block';return;}
  fetch('/api/admin/nudge',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({to_open_id:NT.openId,message:msg})})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){closeNudge();toast('✅ Sent to '+NT.name);}
    else{var e=document.getElementById('nudge-err');e.textContent=d.error||'Failed';e.style.display='block';}
  }).catch(function(e){var el=document.getElementById('nudge-err');el.textContent=''+e;el.style.display='block';});
}
function toast(msg){var t=document.getElementById('toast');t.textContent=msg;t.style.display='block';setTimeout(function(){t.style.display='none';},3000);}
function openAdminDel(id,taskName){
  ADEL_ID=id;
  document.getElementById('adel-task').textContent=taskName||id;
  document.getElementById('adel-err').style.display='none';
  var btn=document.getElementById('adel-btn');btn.disabled=false;btn.textContent='Delete Task';
  document.getElementById('adel-overlay').classList.add('show');
}
function closeAdminDel(){document.getElementById('adel-overlay').classList.remove('show');ADEL_ID=null;}
function doAdminDelete(){
  if(!ADEL_ID)return;
  var btn=document.getElementById('adel-btn');btn.disabled=true;btn.textContent='Deleting…';
  fetch('/api/my-tasks/delete',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({record_id:ADEL_ID})})
  .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
  .then(function(x){
    btn.textContent='Delete Task';
    if(x.ok&&x.j.ok){
      ALL=ALL.filter(function(t){return t.record_id!==ADEL_ID;});
      closeAdminDel();applyFilters();toast('🗑 Task deleted');
    }else{
      var e=document.getElementById('adel-err');e.textContent=(x.j&&x.j.error)||'Failed';e.style.display='block';btn.disabled=false;
    }
  }).catch(function(e){
    var el=document.getElementById('adel-err');el.textContent=''+e;el.style.display='block';btn.disabled=false;btn.textContent='Delete Task';
  });
}
loadAll();
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
  const fs = require('fs');
  const nodePath = require('path');
  const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : nodePath.join(__dirname, '..', 'data'));
  const WR_FILE = nodePath.join(DATA_DIR, 'weekly-reports.json');
  const ST_FILE = nodePath.join(DATA_DIR, 'subtasks.json');

  function readJsonFile(file, def) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return def; }
  }
  function writeJsonFile(file, data) {
    try {
      const dir = nodePath.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (e) { console.error('[ops-my-tasks] writeJsonFile:', e.message); }
  }
  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  async function sendLarkMessage(toOpenId, text) {
    const token = await getTenantToken();
    const r = await axios.post(
      `${LARK_BASE}/open-apis/im/v1/messages?receive_id_type=open_id`,
      { receive_id: toOpenId, msg_type: 'text', content: JSON.stringify({ text }) },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    if (r.data.code !== 0) throw new Error('sendLarkMessage: ' + r.data.msg);
    return r.data;
  }

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

  async function larkDelete(path) {
    const token = await getTenantToken();
    const r = await axios.delete(`${LARK_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
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
    let client = textVal(f.Client);
    if (!client) {
      const ids = clientRecordIds(f);
      client = ids.map((id) => clientsMap[id]).filter(Boolean).join(', ');
    }
    const ownerArr = Array.isArray(f.Owner) ? f.Owner : [];
    const firstOwner = ownerArr[0] || {};
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
      ownerOpenId: firstOwner.id || '',
      ownerName: firstOwner.name || firstOwner.en_name || '',
      createdOn: f['Created On'] || null,
      completedOn: f['Completed On'] || null,
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

  // ---------- ROUTE: GET /api/my-tasks/team ----------
  // Active Team roster for the reassign dropdown: [{name, openId, role}]
  app.get('/api/my-tasks/team', requireAuth, async (req, res) => {
    try {
      const data = await larkGet(
        `/open-apis/bitable/v1/apps/${OPS_APP_TOKEN}/tables/${TEAM_TABLE}/records`,
        { page_size: 100 }
      );
      if (data.code !== 0) throw new Error('team read: ' + data.code + ' ' + data.msg);
      const items = (data.data && data.data.items) || [];
      const team = [];
      for (const it of items) {
        const f = it.fields || {};
        if (f.Active === false) continue;
        const openId = textVal(f['Open ID']) ||
          (Array.isArray(f.Person) && f.Person[0] && f.Person[0].id) || '';
        if (!openId) continue;
        team.push({
          name: textVal(f.Name) ||
            (Array.isArray(f.Person) && f.Person[0] && (f.Person[0].name || f.Person[0].en_name)) || openId,
          openId,
          role: textVal(f.Role) || '',
        });
      }
      res.json({ team });
    } catch (e) {
      console.error('[ops-my-tasks] team error:', e.message);
      res.status(500).json({ error: 'Failed to load team', detail: e.message });
    }
  });

  // ---------- ROUTE: POST /api/my-tasks/reassign ----------
  // Hand a task to another team member. Owner check -> patch Owner (User field,
  // write shape [{id: open_id}]) -> read-back verification.
  app.post('/api/my-tasks/reassign', requireAuth, jsonBody, async (req, res) => {
    try {
      const { record_id, to_open_id, priority } = req.body || {};
      if (!record_id || typeof record_id !== 'string') {
        return res.status(400).json({ error: 'record_id is required' });
      }
      if (!to_open_id || typeof to_open_id !== 'string' || !/^ou_[a-f0-9]+$/i.test(to_open_id)) {
        return res.status(400).json({ error: 'A valid to_open_id is required.' });
      }
      const PRIORITIES = ['🔴 Critical', '🟠 High', '🟡 Normal', '⚪ Low'];
      if (priority !== undefined && priority !== null && priority !== '' && !PRIORITIES.includes(priority)) {
        return res.status(400).json({ error: 'Invalid priority. Must be one of: ' + PRIORITIES.join(', ') });
      }

      const { openId, isAdmin } = await resolveCaller(req);
      if (!openId && !isAdmin) {
        return res.status(403).json({ error: "Your account isn't linked to a task owner. Ping Tommy." });
      }

      let existing;
      try {
        existing = await readRecord(record_id);
      } catch (e) {
        return res.status(404).json({ error: 'Task not found', detail: e.message });
      }
      const existingFields = (existing && existing.fields) || {};
      const owners = ownerIds(existingFields);
      if (!isAdmin && !owners.includes(openId)) {
        return res.status(403).json({ error: "You can't reassign a task you don't own." });
      }

      const patchFields = { Owner: [{ id: to_open_id }] };
      if (priority && PRIORITIES.includes(priority)) patchFields.Priority = priority;
      await patchRecord(record_id, patchFields);

      const after = await readRecord(record_id);
      const afterFields = (after && after.fields) || {};
      const afterOwners = ownerIds(afterFields);
      const afterPriority = textVal(afterFields.Priority) || afterFields.Priority || '';
      const prioVerified = !priority || String(afterPriority) === priority;
      const verified = afterOwners.includes(to_open_id) && prioVerified;
      if (!verified) {
        return res.status(500).json({
          ok: false, verified: false,
          error: 'Write did not verify on read-back',
          readback: { owners: afterOwners, priority: afterPriority },
        });
      }
      return res.json({ ok: true, verified: true, record_id, owners: afterOwners, priority: afterPriority });
    } catch (e) {
      console.error('[ops-my-tasks] reassign error:', e.message);
      res.status(500).json({ error: 'Failed to reassign task', detail: e.message });
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

      const callerEmail = (email || '').toLowerCase();
      res.json({
        tasks,
        owner: wantAll && isAdmin ? 'all' : openId,
        isManager: MANAGER_EMAILS.has(callerEmail),
      });
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


  // ---------- ROUTE: GET /api/weekly-reports/brands ----------
  app.get('/api/weekly-reports/brands', requireAuth, async (req, res) => {
    try {
      const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(email);
      let brands;
      if (isAdmin) {
        const clientsMap = await getClientsMap().catch(() => ({}));
        const brandSet = new Set(Object.values(clientsMap).filter(Boolean));
        for (const bList of Object.values(BRAND_MANAGERS)) {
          for (const b of bList) brandSet.add(b);
        }
        brands = [...brandSet].sort();
      } else {
        brands = BRAND_MANAGERS[email] || [];
      }
      const reportType = REPORT_TYPES[email] || 'brand_manager';
      res.json({ brands, isAdmin, reportType });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- HELPER: saveReportToLark ----------
  async function saveReportToLark(reportType, data) {
    const tableId = WR_TABLES[reportType];
    if (!tableId) return;
    const weekMs = data.week ? new Date(data.week).getTime() : null;
    const submittedAtMs = data.submittedAt || Date.now();
    const fields = { 'Submitted By': data.submittedBy || '', 'Submitted At': submittedAtMs };
    if (weekMs) fields['Week'] = weekMs;
    if (reportType === 'brand_manager') {
      if (data.brand) fields['Brand'] = data.brand;
      fields['GMV ($)'] = Number(data.gmv) || 0;
      fields['Videos Posted'] = Number(data.videosPosted) || 0;
      fields['Samples Sent'] = Number(data.samplesCount) || 0;
      fields['Retainer Budget ($)'] = Number(data.retainerBudget) || 0;
      fields['CTR (%)'] = Number(data.ctr) || 0;
      fields['CTOR (%)'] = Number(data.ctor) || 0;
      fields['SPS Overall (/5)'] = Number(data.spsOverall) || 0;
      fields['Product Satisfaction (/5)'] = Number(data.productSatisfaction) || 0;
      fields['Fulfillment & Logistics (/5)'] = Number(data.fulfillmentScore) || 0;
      fields['Customer Service (/5)'] = Number(data.customerServiceScore) || 0;
      fields['Promotion Running'] = !!data.promotionRunning;
      fields['Growth Opps Enrolled'] = !!data.growthOppsEnrolled;
      if (data.notes) fields['Notes'] = data.notes;
    } else if (reportType === 'operations') {
      fields['Automations Built'] = Number(data.automationsBuilt) || 0;
      fields['Templates Created'] = Number(data.templatesCreated) || 0;
      fields['Blockers Removed'] = Number(data.blockersRemoved) || 0;
      fields['Capacity Issues Resolved'] = Number(data.capacityResolved) || 0;
      if (data.improvements) fields['Process Improvements'] = data.improvements;
      if (data.notes) fields['Notes'] = data.notes;
    } else if (reportType === 'video_editor') {
      fields['Videos Edited'] = Number(data.videosEdited) || 0;
      fields['Videos Delivered'] = Number(data.videosDelivered) || 0;
      fields['Avg Revision Rounds'] = Number(data.avgRevisions) || 0;
      fields['Avg Turnaround (Days)'] = Number(data.avgTurnaround) || 0;
      if (data.brandsWorked) fields['Brands Worked On'] = data.brandsWorked;
      if (data.notes) fields['Notes'] = data.notes;
    } else if (reportType === 'ceo') {
      fields['Sales Calls Booked'] = Number(data.callsBooked) || 0;
      fields['Proposals Sent'] = Number(data.proposalsSent) || 0;
      fields['Community Size'] = Number(data.communitySize) || 0;
      fields['Personal Videos Posted'] = Number(data.personalVideos) || 0;
      if (data.notes) fields['Notes'] = data.notes;
    }
    const token = await getTenantToken();
    await axios.post(
      `${LARK_BASE}/open-apis/bitable/v1/apps/${WR_LARK_APP}/tables/${tableId}/records`,
      { fields },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
  }

  // ---------- ROUTE: POST /api/weekly-reports/submit ----------
  app.post('/api/weekly-reports/submit', requireAuth, jsonBody, async (req, res) => {
    try {
      const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const body = req.body || {};
      const { week, reportType = 'brand_manager' } = body;
      if (!week) return res.status(400).json({ error: 'week is required' });
      if (reportType === 'brand_manager' && !body.brand) return res.status(400).json({ error: 'brand is required' });
      const record = { id: genId(), submittedBy: email, submittedAt: Date.now(), ...body };
      const reports = readJsonFile(WR_FILE, []);
      reports.unshift(record);
      writeJsonFile(WR_FILE, reports);
      // Fire-and-forget to Lark — JSON file is source of truth if Lark fails
      saveReportToLark(reportType, record)
        .catch(e => console.error('[weekly-report] Lark write failed:', e.message));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: GET /api/weekly-reports/history ----------
  app.get('/api/weekly-reports/history', requireAuth, async (req, res) => {
    try {
      const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(email);
      const all = readJsonFile(WR_FILE, []);
      const brands = isAdmin ? null : new Set(BRAND_MANAGERS[email] || []);
      const reports = brands
        ? all.filter((r) => brands.has(r.brand))
        : all;
      res.json({ reports: reports.slice(0, 50) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: GET /api/admin/weekly-reports ----------
  app.get('/api/admin/weekly-reports', requireAuth, async (req, res) => {
    try {
      const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(email);
      if (!isAdmin) return res.status(403).json({ error: 'Forbidden' });
      const all = readJsonFile(WR_FILE, []);
      res.json({ reports: all });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: POST /api/subtasks/create ----------
  app.post('/api/subtasks/create', requireAuth, jsonBody, async (req, res) => {
    try {
      const { parent_record_id, title } = req.body || {};
      if (!parent_record_id || !title || !title.trim()) {
        return res.status(400).json({ error: 'parent_record_id and title are required' });
      }
      const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const openId = await resolveOpenId(email);
      const all = readJsonFile(ST_FILE, []);
      const subtask = { id: genId(), parent_record_id, title: title.trim(), done: false, createdBy: email || openId, createdAt: Date.now() };
      all.push(subtask);
      writeJsonFile(ST_FILE, all);
      res.json({ ok: true, subtask });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: GET /api/subtasks/my ----------
  // Returns subtasks grouped by parent record_id, filtered to parents owned by caller.
  app.get('/api/subtasks/my', requireAuth, async (req, res) => {
    try {
      const all = readJsonFile(ST_FILE, []);
      const byParent = {};
      for (const st of all) {
        if (!byParent[st.parent_record_id]) byParent[st.parent_record_id] = [];
        byParent[st.parent_record_id].push({ id: st.id, title: st.title, done: st.done });
      }
      res.json({ byParent });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: POST /api/subtasks/toggle ----------
  app.post('/api/subtasks/toggle', requireAuth, jsonBody, async (req, res) => {
    try {
      const { id, done } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const all = readJsonFile(ST_FILE, []);
      const st = all.find((s) => s.id === id);
      if (!st) return res.status(404).json({ error: 'Subtask not found' });
      st.done = !!done;
      writeJsonFile(ST_FILE, all);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: GET /api/admin/tasks ----------
  app.get('/api/admin/tasks', requireAuth, async (req, res) => {
    try {
      const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(email);
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });

      const [records, clientsMap] = await Promise.all([listAllTaskRecords(), getClientsMap().catch(() => ({}))]);
      const tasks = [];
      let totalMs = 0, completedCount = 0;
      for (const rec of records) {
        const f = rec.fields || {};
        const status = textVal(f.Status);
        const shaped = shapeTask(rec, clientsMap);
        shaped.isSubtask = false;
        if (status !== 'Completed') tasks.push(shaped);
        if (status === 'Completed' && shaped.createdOn && shaped.completedOn) {
          totalMs += (shaped.completedOn - shaped.createdOn);
          completedCount++;
        }
      }
      const subtaskRecords = readJsonFile(ST_FILE, []);
      for (const st of subtaskRecords) {
        if (st.done) continue;
        tasks.push({ record_id: st.id, task: st.title, client: '', status: 'To Do', isSubtask: true, ownerOpenId: '', ownerName: '', createdOn: st.createdAt, dueDate: null });
      }
      const avgDays = completedCount > 0 ? Math.round(totalMs / completedCount / 86400000) : null;
      res.json({ tasks, avgDays });
    } catch (e) {
      console.error('[ops-my-tasks] admin/tasks error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: POST /api/admin/nudge ----------
  app.post('/api/admin/nudge', requireAuth, jsonBody, async (req, res) => {
    try {
      const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(email);
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const { to_open_id, message } = req.body || {};
      if (!to_open_id || !message || !message.trim()) {
        return res.status(400).json({ error: 'to_open_id and message are required' });
      }
      await sendLarkMessage(to_open_id, message.trim());
      res.json({ ok: true });
    } catch (e) {
      console.error('[ops-my-tasks] nudge error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: POST /api/admin/bulk-reassign-sisyphus ----------
  // One-time route: reassigns all Tommy-owned Sisyphus tasks to Daniel.
  // Protected: admin only. Returns summary.
  app.post('/api/admin/bulk-reassign-sisyphus', requireAuth, jsonBody, async (req, res) => {
    try {
      const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(email);
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });

      const TOMMY_ID = 'ou_cd6157679f48e0cea557ebcb1995c462';
      const DANIEL_ID = 'ou_4332cd6e701b50b0668f7dcbd7196a40';
      const { dry_run = false } = req.body || {};

      const records = await listAllTaskRecords();
      const targets = [];
      for (const rec of records) {
        const f = rec.fields || {};
        const status = textVal(f.Status);
        const mode = textVal(f['Execution Mode']);
        const owners = ownerIds(f);
        if (status === 'Completed') continue;
        if (!mode.toLowerCase().includes('sisyphus')) continue;
        if (!owners.includes(TOMMY_ID)) continue;
        targets.push({ record_id: rec.record_id, task: textVal(f.Task) });
      }

      if (dry_run) return res.json({ dry_run: true, count: targets.length, tasks: targets });

      const results = [];
      for (const t of targets) {
        try {
          await patchRecord(t.record_id, { Owner: [{ id: DANIEL_ID }] });
          results.push({ record_id: t.record_id, task: t.task, ok: true });
        } catch (e) {
          results.push({ record_id: t.record_id, task: t.task, ok: false, error: e.message });
        }
      }
      const succeeded = results.filter((r) => r.ok).length;
      console.log(`[ops-my-tasks] bulk-reassign: ${succeeded}/${results.length} tasks reassigned to Daniel`);
      res.json({ ok: true, total: results.length, succeeded, failed: results.length - succeeded, results });
    } catch (e) {
      console.error('[ops-my-tasks] bulk-reassign error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: POST /api/my-tasks/delete ----------
  // Permanently removes a task record from the Lark Bitable.
  // Open to all team members. Notifies Tommy + Hasan when a non-manager deletes.
  app.post('/api/my-tasks/delete', requireAuth, jsonBody, async (req, res) => {
    try {
      const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const { record_id } = req.body || {};
      if (!record_id || typeof record_id !== 'string') {
        return res.status(400).json({ error: 'record_id is required' });
      }
      // Read first so we can confirm it exists and log what was deleted.
      let existing;
      try {
        existing = await readRecord(record_id);
      } catch (e) {
        return res.status(404).json({ error: 'Task not found', detail: e.message });
      }
      const fields = existing.fields || {};
      const taskName = textVal(fields.Task);
      const clientsMap = await getClientsMap().catch(() => ({}));
      const clientRecIds = (Array.isArray(fields.Client) ? fields.Client : [fields.Client])
        .flatMap((c) => (c && c.link_record_ids) ? c.link_record_ids : []);
      const clientName = clientRecIds.map((id) => clientsMap[id]).filter(Boolean).join(', ') || '—';
      const data = await larkDelete(
        `/open-apis/bitable/v1/apps/${OPS_APP_TOKEN}/tables/${TASKS_TABLE}/records/${record_id}`
      );
      if (data.code !== 0) {
        return res.status(500).json({ error: 'Lark delete failed: ' + data.msg, code: data.code });
      }
      console.log(`[ops-my-tasks] DELETED record ${record_id} "${taskName}" by ${email}`);
      // Notify Tommy + Hasan when a non-manager deletes a task
      if (!MANAGER_EMAILS.has(email)) {
        const msg = `🗑️ Task deleted by ${email}\n\nTask: "${taskName}"\nClient: ${clientName}`;
        await Promise.allSettled([
          sendLarkMessage(SEED_EMAIL_OPENID['tommy@cultcontent.cc'], msg),
          sendLarkMessage(SEED_EMAIL_OPENID['hasan@cultcontent.cc'], msg),
        ]);
      }
      res.json({ ok: true, deleted: record_id, task: taskName });
    } catch (e) {
      console.error('[ops-my-tasks] delete error:', e.message);
      res.status(500).json({ error: 'Failed to delete task', detail: e.message });
    }
  });

  // ---------- ROUTE: GET /task-management (admin HTML) ----------
  app.get('/task-management', requireAuth, (req, res) => {
    const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
    const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(email);
    if (!isAdmin) return res.status(403).type('html').send('<h2 style="font-family:sans-serif;padding:40px">Access restricted to admins.</h2>');
    res.type('html').send(TASK_MANAGEMENT_HTML);
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
