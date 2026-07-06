'use strict';

/**
 * ops-mytasks.js  (cult-command-center)
 *
 * Mounted route powering the Ops Engine "My Tasks" UI on manifest/portal.
 * Pairs with routes/ops-mytasks-lib.js (open_id resolve + Bitable read/write).
 *
 * MOUNT (explicit — cult-command-center has NO dynamic loader):
 *   const opsMyTasks = require('./routes/ops-mytasks');
 *   opsMyTasks.mount(app, { requirePortalAdmin });
 * Place BEFORE app.listen(). Uses the inline `requirePortalAdmin` session gate
 * (req.session.isPortalAdmin === true) so unauth API calls return 401 JSON.
 *
 * Endpoints:
 *   GET  /ops/my-tasks               -> HTML board (gated)
 *   GET  /ops/my-tasks/api/list      -> current user's tasks JSON (gated, 401 if not)
 *   POST /ops/my-tasks/api/complete  -> {recordId, note} note MANDATORY (400 empty)
 *   POST /ops/my-tasks/api/status    -> {recordId, status[, note]} guarded transition
 *
 * TRANSITION GUARD (verified E2E against live Bitable, Jul 2026):
 *   Source status is read LIVE from Bitable (never trusted from the client, to
 *   prevent from-state spoofing). Legality checked against LEGAL_TRANSITIONS.
 *   Illegal transition -> HTTP 409 JSON, NO write. Completed is TERMINAL.
 */

const lib = require('./ops-mytasks-lib');

// Canonical legal status graph. Completed is terminal (no outbound edges).
const LEGAL_TRANSITIONS = {
  'To Do':       ['In Progress', 'Blocked', 'Completed'],
  'In Progress': ['Blocked', 'Completed', 'To Do'],
  'Blocked':     ['In Progress', 'Completed', 'To Do'],
  'Completed':   [],
};
const VALID_STATUSES = Object.keys(LEGAL_TRANSITIONS);

function checkTransition(from, to) {
  if (!LEGAL_TRANSITIONS.hasOwnProperty(from)) {
    return { ok: false, code: 409, error: `unknown source status '${from}'` };
  }
  if (!VALID_STATUSES.includes(to)) {
    return { ok: false, code: 400, error: `invalid target status '${to}'` };
  }
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    return { ok: false, code: 409, error: `illegal transition ${from} -> ${to}` };
  }
  return { ok: true };
}

// Read the live status of a record straight from Bitable (source of truth).
async function liveStatus(recordId) {
  const token = await lib._internal.larkToken();
  const app = lib._internal.OPS_APP_TOKEN, tbl = lib._internal.TASKS_TABLE_ID;
  const axios = require('axios');
  const r = await axios.get(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${app}/tables/${tbl}/records/${recordId}`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
  );
  const f = (((r.data || {}).data || {}).record || {}).fields || {};
  const s = f['Status'];
  return (s && (s.text || s)) || s || null;
}

// Read the live Owner (User field) open_ids of a record straight from Bitable.
// Owner cells come back as an array of user objects [{ id: "ou_...", name, ... }].
// Returns an array of open_id strings (may be empty).
async function ownerIds(recordId) {
  const token = await lib._internal.larkToken();
  const app = lib._internal.OPS_APP_TOKEN, tbl = lib._internal.TASKS_TABLE_ID;
  const axios = require("axios");
  const r = await axios.get(
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${app}/tables/${tbl}/records/${recordId}`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
  );
  const f = (((r.data || {}).data || {}).record || {}).fields || {};
  const owner = f["Owner"];
  const arr = Array.isArray(owner) ? owner : (owner ? [owner] : []);
  return arr
    .map((u) => (u && typeof u === "object" ? (u.id || u.open_id) : u))
    .filter((id) => typeof id === "string" && id.startsWith("ou_"));
}

function mount(app, deps = {}) {
  const requirePortalAdmin = deps.requirePortalAdmin || function (req, res, next) {
    if (req.session && req.session.isPortalAdmin === true) return next();
    return res.status(401).json({ error: 'unauthorized' });
  };

  // GET tasks list
  app.get('/ops/my-tasks/api/list', requirePortalAdmin, async (req, res) => {
    try {
      const openId = await lib.resolveOpenId(req.session || {});
      if (!openId) return res.json({ tasks: [], warning: 'no open_id resolved for user' });
      const tasks = await lib.listMyTasks(openId);
      res.json({ openId, count: tasks.length, tasks });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST complete (note mandatory)
  app.post('/ops/my-tasks/api/complete', requirePortalAdmin, async (req, res) => {
    const { recordId, note } = req.body || {};
    if (!recordId) return res.status(400).json({ error: 'recordId required' });
    if (!note || !String(note).trim()) return res.status(400).json({ error: 'A Result/Output note is required to complete a task' });
    try {
      const from = await liveStatus(recordId);
      const chk = checkTransition(from, 'Completed');
      if (!chk.ok) return res.status(chk.code).json({ ok: false, from, to: 'Completed', error: chk.error });
      const w = await lib.updateTaskStatus(recordId, { status: 'Completed', resultNote: String(note).trim() });
      if (!w.ok) return res.status(500).json({ ok: false, error: w.error });
      res.json({ ok: true, recordId, from, to: 'Completed' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST status transition (guarded + ownership-enforced)
  // Step 5 scope: one-click Start / Block transitions -> {recordId, status[, note]}.
  // status must be one of To Do | In Progress | Blocked (Completed goes via /complete).
  // Ownership: the signed-in user's open_id MUST be in the record's Owner cell -> else 403.
  // When status === Blocked and a note is present, the note is appended to
  // Result / Output prefixed with 'BLOCKED: ' so blockers are visible in the base.
  app.post('/ops/my-tasks/api/status', requirePortalAdmin, async (req, res) => {
    const { recordId, status, note } = req.body || {};
    if (!recordId) return res.status(400).json({ error: 'recordId required' });
    if (!status) return res.status(400).json({ error: 'status required' });

    // Restrict to the one-click transition set for this endpoint.
    const ALLOWED = ['To Do', 'In Progress', 'Blocked'];
    if (!ALLOWED.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${ALLOWED.join(', ')}` });
    }

    try {
      // Ownership check — resolve the caller's open_id and confirm it owns this record.
      const openId = await lib.resolveOpenId(req.session || {});
      if (!openId) return res.status(403).json({ ok: false, error: 'could not resolve your Lark open_id' });
      const owners = await ownerIds(recordId);
      if (!owners.includes(openId)) {
        return res.status(403).json({ ok: false, error: 'you are not the Owner of this task' });
      }

      const from = await liveStatus(recordId);          // live source of truth
      const chk = checkTransition(from, status);
      if (!chk.ok) return res.status(chk.code).json({ ok: false, from, to: status, error: chk.error });

      // Blocked: append the reason to Result / Output prefixed BLOCKED:. Other
      // transitions carry the note through verbatim (optional).
      const opts = { status };
      const trimmed = note && String(note).trim();
      if (trimmed) {
        opts.resultNote = status === 'Blocked' ? `BLOCKED: ${trimmed}` : trimmed;
      }

      const w = await lib.updateTaskStatus(recordId, opts);
      if (!w.ok) return res.status(500).json({ ok: false, from, to: status, error: w.error });
      res.json({ ok: true, recordId, from, to: status, noteWritten: !!opts.resultNote });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET board HTML (gated) — minimal shell; full themed board is Step 5 deliverable.
  app.get('/ops/my-tasks', requirePortalAdmin, (req, res) => {
    res.type('html').send(renderBoardShell());
  });
}

function renderBoardShell() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>My Tasks · Cult Content</title>
<style>
:root{--bg:#161823;--card:#1f2233;--cy:#00f2ea;--rd:#ff0050;--tx:#e8eaf2;--mut:#8b90a8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
header{padding:20px 24px;border-bottom:1px solid #2a2e42;background:linear-gradient(90deg,rgba(0,242,234,.08),rgba(255,0,80,.08))}
h1{margin:0;font-size:20px;background:linear-gradient(90deg,var(--cy),var(--rd));-webkit-background-clip:text;background-clip:text;color:transparent}
#tasks{padding:24px;display:grid;gap:14px;max-width:820px}
.card{background:var(--card);border:1px solid #2a2e42;border-radius:14px;padding:16px 18px}
.card h3{margin:0 0 6px;font-size:16px}
.meta{color:var(--mut);font-size:13px;margin-bottom:10px}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#2a2e42;margin-right:6px}
button{border:0;border-radius:9px;padding:8px 14px;font-weight:600;cursor:pointer;margin-right:8px;color:#fff}
.start{background:var(--cy);color:#08121a}.block{background:#3a3f57}.done{background:var(--rd)}
.empty{color:var(--mut);padding:40px;text-align:center}
</style></head><body>
<header><h1>My Tasks</h1></header>
<div id="tasks"><div class="empty">Loading…</div></div>
<script>
const STATUS_ACTIONS={'To Do':[['Start','In Progress']],'In Progress':[['Block','Blocked'],['Complete','Completed']],'Blocked':[['Resume','In Progress'],['Complete','Completed']]};
async function load(){
  const r=await fetch('/ops/my-tasks/api/list');
  if(r.status===401){document.getElementById('tasks').innerHTML='<div class="empty">Please sign in.</div>';return;}
  const d=await r.json();const el=document.getElementById('tasks');
  if(!d.tasks||!d.tasks.length){el.innerHTML='<div class="empty">No tasks assigned. 🎉</div>';return;}
  const order={'🔴 Critical':0,'🟠 High':1,'🟡 Normal':2,'⚪ Low':3};
  d.tasks.sort((a,b)=>(order[a.priority]??9)-(order[b.priority]??9));
  el.innerHTML=d.tasks.filter(t=>t.status!=='Completed').map(t=>{
    const acts=(STATUS_ACTIONS[t.status]||[]).map(([lbl,to])=>{
      const cls=to==='In Progress'?'start':to==='Blocked'?'block':'done';
      return '<button class="'+cls+'" onclick="move(\\''+t.record_id+'\\',\\''+to+'\\',\\''+t.status+'\\')">'+lbl+'</button>';
    }).join('');
    return '<div class="card"><h3>'+esc(t.task)+'</h3><div class="meta"><span class="badge">'+esc(t.clientName||'—')+'</span><span class="badge">'+esc(t.priority||'')+'</span><span class="badge">'+esc(t.status)+'</span> '+esc(t.pillar||'')+'</div>'+acts+'</div>';
  }).join('')||'<div class="empty">All caught up. 🎉</div>';
}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
async function move(recordId,to,from){
  let note;
  if(to==='Completed'){note=prompt('Result / Output (required):');if(!note||!note.trim())return;}
  else if(to==='Blocked'){note=prompt('Blocker note (optional):')||'';}
  const body={recordId,status:to};if(note&&note.trim())body.note=note.trim();
  const r=await fetch('/ops/my-tasks/api/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();
  if(!r.ok||!j.ok){alert(j.error||'Failed');return;}
  load();
}
load();
</script></body></html>`;
}

module.exports = { mount, _guard: { checkTransition, LEGAL_TRANSITIONS, liveStatus } };
