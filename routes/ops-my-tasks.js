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
  // 'gina@cultcontent.cc': 'ou_TBD',  // no Lark account yet — Tommy must provision first
  // becca / jenna: add ou_ IDs after Lark seats are provisioned
};

// Brand managers: email -> client names they own.
// Used for Weekly Report brand selector and admin brand-context display.
// Add gourab@cultcontent.cc once they're added to the Lark Team table.
const BRAND_MANAGERS = {
  'gourab@cultcontent.cc': ['Lode WTR', 'Roots by Genetic Art', 'Trip Visuals', 'Made Right', 'B NOOR', 'Elasco Skincare', 'Starlit Scribbles'],
};

// Weekly report form type per team member.
// brand_manager: per-brand GMV/content/SPS
// operations: Hasan — automations, templates, blockers removed
// video_editor: Gilbert — videos edited/delivered
// community_manager: Jina/Becca/Jenna — 1:1 calls, videos posted, creator signups
// ceo: Tommy — sales calls, proposals, community growth, strategic notes
const REPORT_TYPES = {
  'shayan@cultcontent.cc': 'brand_manager',
  'gourab@cultcontent.cc': 'brand_manager',
  'hasan@cultcontent.cc': 'operations',
  'gilbert@cultcontent.cc': 'video_editor',
  'gina@cultcontent.cc': 'community_manager',
  'becca@cultcontent.cc': 'community_manager',
  'jenna@cultcontent.cc': 'community_manager',
  'tommy@cultcontent.cc': 'ceo',
  'tommy@organicsocialmarketing.com': 'ceo',
};

// Compensation model: bonus as % of monthly net sales share.
// Tiered scoring per gate: 0 (miss) / 0.5 (floor threshold met) / 1.0 (hit threshold met)
// bonusPct = (sum of gate scores / numGates) × hitPct
// Gourab ratio uses ratioTiers [low,mid,high] → scores 0.5 / 0.75 / 1.0 → 4% / 6% / 8%
const COMP_MODEL = {
  'gina@cultcontent.cc': { base: 2750, floorPct: 0.04, hitPct: 0.08, gates: [
    { key: 'calls',   label: '1:1 Creator Calls', floor: 5,  hit: 10 },
    { key: 'videos',  label: 'Videos Posted',      floor: 5,  hit: 10 },
    { key: 'signups', label: 'Creator Signups',    floor: 15, hit: 30 },
  ]},
  'becca@cultcontent.cc': { base: 1000, floorPct: 0.05, hitPct: 0.10, gates: [
    { key: 'calls',   label: '1:1 Creator Calls', floor: 5,  hit: 10 },
    { key: 'videos',  label: 'Videos Posted',      floor: 5,  hit: 10 },
    { key: 'signups', label: 'Creator Signups',    floor: 15, hit: 30 },
  ]},
  'jenna@cultcontent.cc': { base: 1000, floorPct: 0.05, hitPct: 0.10, gates: [
    { key: 'calls',   label: '1:1 Creator Calls', floor: 5,  hit: 10 },
    { key: 'videos',  label: 'Videos Posted',      floor: 5,  hit: 10 },
    { key: 'signups', label: 'Creator Signups',    floor: 15, hit: 30 },
  ]},
  'gourab@cultcontent.cc': { base: 1350, floorPct: 0.04, hitPct: 0.08, gates: [
    { key: 'ratio',   label: 'Video/Sample Ratio', floor: 0.2, hit: 0.4 },
  ], ratioTiers: [0.2, 0.3, 0.4] },
  'gilbert@cultcontent.cc': { base: 1000, floorPct: 0.02, hitPct: 0.04, gates: [
    { key: 'videos',  label: 'Videos Edited',      floor: 30, hit: 60 },
  ]},
};

// Emails allowed to access /task-management admin view.
const ADMIN_EMAILS = new Set([
  'tommy@cultcontent.cc',
  'tommy@organicsocialmarketing.com',
  'daniel@cultcontent.cc',
  'hasan@cultcontent.cc',
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
  .chip.blocked-chip{border-color:rgba(255,0,80,.4);color:var(--red)}
  .chip.blocked-chip.active{background:rgba(255,0,80,.15);border-color:var(--red)}
  .group{margin-bottom:26px}
  .group h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 11px;display:flex;align-items:center;gap:8px}
  .dot{width:9px;height:9px;border-radius:50%}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px 15px;margin-bottom:10px;display:flex;justify-content:space-between;gap:14px;align-items:flex-start}
  .card .body{flex:1;min-width:0}
  .card .task-title{font-size:15px;font-weight:600;margin:0 0 5px;line-height:1.35;cursor:pointer}
  .card .task-title:hover{text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px}
  .card-title-input{background:var(--panel2);border:1px solid var(--cyan);border-radius:5px;color:var(--txt);padding:3px 8px;font-size:15px;font-weight:600;font-family:inherit;width:100%;margin-bottom:5px;box-sizing:border-box}
  .card-title-input:focus{outline:none}
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
  .prio-sel{background:transparent;border:none;color:var(--muted);font-size:11px;font-family:inherit;cursor:pointer;padding:2px 4px;border-radius:4px;appearance:none;-webkit-appearance:none}
  .prio-sel:hover,.prio-sel:focus{outline:none;background:var(--panel2);color:var(--txt)}
  .sop-btn{background:none;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:11px;padding:2px 9px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:4px;transition:.1s;font-family:inherit}
  .sop-btn:hover{border-color:var(--cyan);color:var(--cyan)}
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
  /* client report cards */
  .wr-week-bar{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;gap:12px}
  .cr-card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:16px}
  .cr-card-hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;gap:10px;flex-wrap:wrap}
  .cr-brand{font-size:17px;font-weight:700}
  .cr-week-lbl{font-size:12px;color:var(--muted);margin-top:3px}
  .cr-status{font-size:11px;padding:3px 10px;border-radius:10px;font-weight:600;white-space:nowrap}
  .cr-status.submitted{background:rgba(107,232,107,.15);color:#6be86b}
  .cr-status.pending{background:rgba(154,160,181,.12);color:var(--muted)}
  .cr-auto-tag{font-size:10px;background:rgba(0,242,234,.15);color:var(--cyan);padding:1px 6px;border-radius:4px;margin-left:5px;vertical-align:middle}
  .cr-tasks{margin-top:14px;padding-top:14px;border-top:1px solid var(--border)}
  .cr-tasks-hdr{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:6px}
  .cr-task-item{font-size:12.5px;padding:5px 0;border-bottom:1px solid rgba(47,51,70,.4);display:flex;align-items:flex-start;gap:7px;line-height:1.4}
  .cr-task-item:last-child{border-bottom:none}
  .cr-task-result{font-size:11.5px;color:var(--muted);margin-top:2px}
  /* Sprint planner */
  .sp-board{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-top:18px}
  .sp-col{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px;display:flex;flex-direction:column}
  .sp-col-hdr{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center}
  .sp-item{display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px solid rgba(47,51,70,.35);font-size:13px}
  .sp-item:last-child{border-bottom:none}
  .sp-status{cursor:pointer;font-size:15px;line-height:1.2;flex-shrink:0;user-select:none}
  .sp-text{flex:1;line-height:1.45}
  .sp-done .sp-text{text-decoration:line-through;opacity:.45}
  .sp-author{font-size:10.5px;color:var(--muted);white-space:nowrap;flex-shrink:0}
  .sp-del{background:none;border:none;color:var(--muted);font-size:13px;cursor:pointer;padding:0 2px;opacity:0;line-height:1;flex-shrink:0}
  .sp-item:hover .sp-del{opacity:.5}
  .sp-del:hover{opacity:1!important;color:var(--red)}
  .sp-vote{background:none;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:11px;padding:1px 7px;cursor:pointer;flex-shrink:0;transition:.1s}
  .sp-vote:hover,.sp-vote.voted{border-color:var(--cyan);color:var(--cyan)}
  .sp-input{width:100%;background:var(--panel2);border:1px solid var(--border);border-radius:8px;color:var(--txt);padding:8px 10px;font-size:13px;font-family:inherit;margin-top:10px}
  .sp-input:focus{outline:none;border-color:var(--cyan)}
  .sp-goal-input{width:100%;background:rgba(0,242,234,.05);border:1px solid rgba(0,242,234,.18);border-radius:10px;color:var(--txt);padding:10px 14px;font-size:13.5px;font-family:inherit}
  .sp-goal-input:focus{outline:none;border-color:var(--cyan)}
  .sp-goal-input::placeholder{color:var(--muted);font-style:italic}
  .sp-week-nav{display:flex;align-items:center;gap:10px;margin-top:18px;opacity:.55}
  .sp-week-nav:hover{opacity:.85;transition:opacity .2s}
  .sp-week-lbl{flex:1;text-align:center;font-size:13px;font-weight:600;color:var(--muted)}
  .sp-empty{color:var(--muted);font-size:12.5px;padding:6px 0 4px}
  .sp-type{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:1px 6px;border-radius:4px;white-space:nowrap;flex-shrink:0}
  .sp-type-suggestion{background:rgba(0,242,234,.12);color:var(--cyan)}
  .sp-type-sop{background:rgba(107,232,107,.12);color:#6be86b}
  .sp-type-recurring{background:rgba(255,207,100,.12);color:#ffcf64}
  .sp-type-note{background:rgba(154,160,181,.15);color:var(--muted)}
  .sp-type-bug{background:rgba(255,0,80,.12);color:var(--red)}
  .sp-type-feature{background:rgba(0,242,234,.12);color:var(--cyan)}
  .sp-item-notes{font-size:12px;color:var(--muted);line-height:1.45;padding:2px 0 6px 23px;display:none}
  .sp-item-notes.show{display:block}
  .sp-notes-text{cursor:pointer;min-height:14px}
  .sp-notes-text:hover{color:var(--txt)}
  .sp-notes-input{width:100%;background:var(--panel2);border:1px solid var(--border);border-radius:6px;color:var(--txt);padding:6px 9px;font-size:12px;font-family:inherit;resize:none;min-height:52px;display:none;margin-top:2px}
  .sp-notes-input:focus{outline:none;border-color:var(--cyan)}
  .sp-note-btn{background:none;border:none;color:var(--muted);font-size:12px;cursor:pointer;padding:0 2px;opacity:0;line-height:1;flex-shrink:0}
  .sp-item:hover .sp-note-btn{opacity:.45}
  .sp-note-btn.has-notes{opacity:.65!important;color:var(--cyan)}
  .sp-note-btn:hover{opacity:1!important}
  .sp-type-row{display:flex;gap:6px;margin-top:8px;align-items:center}
  .sp-type-sel{background:var(--panel2);border:1px solid var(--border);border-radius:6px;color:var(--muted);padding:5px 8px;font-size:12px;font-family:inherit;flex:1}
  .sp-type-sel:focus{outline:none;border-color:var(--cyan)}
  .sp-sisy-link{font-size:11px;color:var(--muted);text-decoration:none;display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border:1px solid var(--border);border-radius:6px;margin-bottom:10px;transition:.1s}
  .sp-sisy-link:hover{color:var(--cyan);border-color:var(--cyan)}
  .sp-product-card{border:1px solid var(--border);border-radius:10px;margin-bottom:8px;overflow:hidden;cursor:pointer;transition:border-color .15s}
  .sp-product-card:hover,.sp-product-card.open{border-color:var(--cyan)}
  .sp-product-hdr{display:flex;align-items:center;gap:8px;padding:10px 12px}
  .sp-product-emoji{font-size:18px;line-height:1;flex-shrink:0}
  .sp-product-name{flex:1;font-size:13px;font-weight:600}
  .sp-product-chevron{color:var(--muted);font-size:16px;transition:transform .15s;flex-shrink:0}
  .sp-product-card.open .sp-product-chevron{transform:rotate(90deg)}
  .sp-ps-live{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:1px 6px;border-radius:4px;background:rgba(107,232,107,.12);color:#6be86b;flex-shrink:0}
  .sp-ps-building{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:1px 6px;border-radius:4px;background:rgba(255,207,100,.12);color:#ffcf64;flex-shrink:0}
  .sp-product-detail{padding:0 12px 12px;border-top:1px solid var(--border);display:none}
  .sp-product-card.open .sp-product-detail{display:block}
  .sp-product-detail p{font-size:12.5px;color:var(--muted);margin:10px 0 8px;line-height:1.5}
  .sp-product-detail a{font-size:12px;color:var(--cyan);text-decoration:none}
  .sp-product-detail a:hover{text-decoration:underline}
  .sp-product-actions{display:flex;gap:8px;margin-top:12px}
  .sp-product-act-btn{background:none;border:1px solid var(--border);border-radius:7px;color:var(--muted);font-size:12px;padding:5px 12px;cursor:pointer;font-family:inherit;transition:.1s}
  .sp-product-act-btn:hover{border-color:var(--cyan);color:var(--txt)}
  .sp-product-form{margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}
  .sp-product-items{margin-top:10px;padding-top:8px;border-top:1px solid var(--border)}
  .sp-product-item{display:flex;align-items:center;gap:7px;padding:5px 0;border-bottom:1px solid rgba(47,51,70,.2);font-size:12.5px}
  .sp-product-item:last-child{border-bottom:none}
  .sp-col-full{grid-column:1/-1}
  .sp-placeholder{color:var(--muted);font-size:12.5px;line-height:1.6;padding:8px 0 4px}
  .sp-submit-btn{background:var(--panel2);border:1px solid var(--border);border-radius:8px;color:var(--txt);font-size:12px;font-weight:600;font-family:inherit;padding:7px 16px;cursor:pointer;white-space:nowrap;transition:.1s}
  .sp-submit-btn:hover{border-color:var(--cyan);color:var(--cyan)}
  .sp-product-tag{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:1px 6px;border-radius:4px;background:rgba(154,160,181,.12);color:var(--muted);white-space:nowrap;flex-shrink:0}
  .sp-plan-cta{margin-top:16px;display:flex;align-items:center;gap:14px;padding:14px 16px;background:rgba(0,242,234,.04);border:1px dashed rgba(0,242,234,.25);border-radius:12px}
  .sp-plan-btn{font-size:13px;padding:9px 18px;white-space:nowrap;flex-shrink:0}
  .sp-plan-sub{font-size:12px;color:var(--muted);line-height:1.4}
  .plan-progress{display:flex;gap:6px;margin-bottom:18px;align-items:center}
  .plan-dot{width:8px;height:8px;border-radius:50%;background:var(--border);flex-shrink:0}
  .plan-dot.done{background:var(--cyan);opacity:.5}
  .plan-dot.active{background:var(--cyan)}
  .plan-q-num{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}
  .plan-q{font-size:15px;font-weight:600;line-height:1.45;margin-bottom:12px}
  .plan-ans{width:100%;min-height:80px;background:var(--panel2);border:1px solid var(--border);border-radius:8px;color:var(--txt);padding:10px;font-size:14px;font-family:inherit;resize:none}
  .plan-ans:focus{outline:none;border-color:var(--cyan)}
  .plan-task-row{display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px;align-items:flex-start}
  .plan-task-num{color:var(--muted);min-width:20px;flex-shrink:0}
  .plan-task-sec{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:1px 6px;border-radius:4px;margin-top:2px}
  .plan-sec-product{background:rgba(0,242,234,.12);color:var(--cyan)}
  .plan-sec-architecture{background:rgba(154,120,255,.15);color:#b07fff}
  .plan-sec-team{background:rgba(107,232,107,.12);color:#6be86b}
  .sp-push-btn{background:none;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:11px;padding:2px 8px;cursor:pointer;transition:.1s;white-space:nowrap}
  .sp-push-btn:hover{border-color:var(--cyan);color:var(--cyan)}
  @media(max-width:720px){.sp-board{grid-template-columns:1fr}.sp-col-full{grid-column:unset}.sp-plan-cta{flex-direction:column;align-items:flex-start}}
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
  /* compensation banner */
  .cb{background:rgba(0,242,234,.06);border:1px solid rgba(0,242,234,.2);border-radius:14px;padding:16px 18px;margin-bottom:18px}
  .cb-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
  .cb-title{font-size:12px;font-weight:700;color:var(--cyan);text-transform:uppercase;letter-spacing:.06em}
  .cb-est{font-size:10px;background:rgba(255,159,10,.15);color:#ffcf8a;padding:1px 7px;border-radius:4px;font-weight:600}
  .cb-body{display:grid;grid-template-columns:140px 1fr;gap:12px 20px;align-items:start}
  .cb-payout{font-size:26px;font-weight:800;letter-spacing:-.02em}
  .cb-payout-sub{font-size:11px;color:var(--muted);margin-top:2px}
  .cb-pct{font-size:12px;color:var(--cyan);font-weight:600;margin-top:4px}
  .cb-gates{display:flex;flex-direction:column;gap:7px}
  .cb-gate-row{display:flex;flex-direction:column;gap:3px}
  .cb-gate-meta{display:flex;justify-content:space-between;font-size:11px}
  .cb-gate-lbl{color:var(--muted)}
  .cb-gate-val{font-weight:600;color:var(--txt)}
  .cb-bar-wrap{position:relative;height:6px}
  .cb-bar-bg{position:absolute;inset:0;border-radius:3px;overflow:hidden;background:var(--border)}
  .cb-bar-fill{height:100%;border-radius:3px;transition:width .5s}
  .cb-bar-fill.tier-none{background:rgba(120,120,150,.4)}
  .cb-bar-fill.tier-floor{background:linear-gradient(90deg,var(--cyan),rgba(0,242,234,.55))}
  .cb-bar-fill.tier-hit{background:linear-gradient(90deg,#c9a84c,#f0d060)}
  .cb-bar-tick{position:absolute;top:-1px;bottom:-1px;width:2px;border-radius:1px;background:var(--dark);z-index:2;transform:translateX(-50%)}
  .cb-tier-labels{display:flex;position:relative;height:14px;font-size:9px;color:var(--muted);margin-top:1px}
  .cb-net{font-size:11px;color:var(--muted);margin-top:10px;padding-top:8px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .cb-net strong{color:var(--txt)}
  .cb-update-btn{font-size:11px;background:none;border:1px solid var(--border);color:var(--muted);padding:2px 8px;border-radius:5px;cursor:pointer;font-family:inherit}
  .cb-update-btn:hover{border-color:var(--cyan);color:var(--cyan)}
  @media(max-width:540px){.cb-body{grid-template-columns:1fr}}
  /* team payroll summary (CEO/admin view) */
  .tp{background:rgba(255,0,80,.05);border:1px solid rgba(255,0,80,.22);border-radius:14px;padding:16px 18px;margin-bottom:18px}
  .tp-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
  .tp-title{font-size:12px;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:.06em}
  .tp-est{font-size:10px;background:rgba(255,159,10,.15);color:#ffcf8a;padding:1px 7px;border-radius:4px;font-weight:600}
  .tp-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}
  .tp-stat{text-align:center;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px}
  .tp-stat .n{font-size:20px;font-weight:800;letter-spacing:-.02em}
  .tp-stat .l{font-size:10px;color:var(--muted);margin-top:2px}
  .tp-bar-wrap{margin-bottom:12px}
  .tp-bar-label{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:4px}
  .tp-bar-bg{height:6px;background:var(--border);border-radius:3px;overflow:hidden}
  .tp-bar-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,var(--red),rgba(255,0,80,.4));transition:width .5s}
  .tp-members{display:flex;flex-direction:column;gap:6px}
  .tp-member{display:flex;align-items:center;gap:10px;padding:7px 10px;background:var(--panel);border:1px solid var(--border);border-radius:8px}
  .tp-member-name{font-size:12px;font-weight:700;min-width:60px}
  .tp-member-bar-bg{flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden}
  .tp-member-bar-fill{height:100%;border-radius:2px;background:linear-gradient(90deg,var(--red),rgba(255,0,80,.5));transition:width .5s}
  .tp-member-amt{font-size:12px;font-weight:600;min-width:50px;text-align:right}
  .tp-member-pct{font-size:10px;color:var(--muted);min-width:40px;text-align:right}
  .tp-net{font-size:11px;color:var(--muted);margin-top:10px;padding-top:8px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .tp-net strong{color:var(--txt)}
  @media(max-width:540px){.tp-meta{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div><h1>My Tasks</h1></div>
    <div style="display:flex;gap:8px;align-items:center">
      <a class="chip sisy" href="https://sisyphus.cultcontent.cc" target="_blank" rel="noopener">🪨 Sisyphus</a>
      <a class="chip" href="/task-management">⚙ Admin</a>
      <button class="chip" onclick="openMtAdd()">+ Add Task</button>
      <button class="chip" onclick="load()" title="Refresh">↻</button>
    </div>
  </header>
  <div class="sub" id="sub">Loading…</div>
  <div id="dev-banner" style="display:none"></div>
  <div id="comp-banner" style="display:none"></div>
  <div class="tabs">
    <button class="tab active" onclick="switchTab(0)">My Tasks</button>
    <button class="tab" onclick="switchTab(1)">Client Reports</button>
    <button class="tab" onclick="switchTab(2)">Sprint</button>
  </div>

  <div id="tab-tasks">
    <div id="unlinked" class="banner" style="display:none"></div>
    <div class="filters" id="filters" style="display:none"></div>
    <div id="board"></div>
  </div>

  <div id="tab-report" style="display:none">
    <div class="wr-week-bar">
      <div>
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Reporting Week</div>
        <div style="font-size:15px;font-weight:700" id="wr-week-display">Loading…</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        <div id="wr-sub-label" style="font-size:12px;color:var(--muted)"></div>
        <button class="btn ghost" style="font-size:12px;padding:5px 12px" onclick="wrChangeWeek()">Change</button>
      </div>
    </div>
    <div id="wr-client-container" style="display:none">
      <div id="wr-client-cards"></div>
    </div>
    <div id="wr-form-container" style="display:none">
      <div class="wr-form">
        <h2 style="margin:0 0 16px">Weekly Report</h2>
        <div id="wr-form-body"><div style="color:var(--muted);font-size:13px">Loading…</div></div>
        <div class="err" id="wr-err" style="margin-top:8px"></div>
        <div style="display:flex;justify-content:flex-end;margin-top:14px">
          <button class="btn" onclick="submitReport()">Submit Report</button>
        </div>
      </div>
    </div>
    <div class="wr-hist">
      <h3 id="wr-hist-title">Recent Reports</h3>
      <div id="wr-list"><div style="color:var(--muted);font-size:13px">Loading…</div></div>
    </div>
  </div>

  <div id="tab-sprint" style="display:none">
    <div class="sp-board">
      <div class="sp-col">
        <div class="sp-col-hdr"><span>🎯 Products</span><span style="font-size:10px;font-weight:400;color:var(--muted)">Click to expand</span></div>
        <div id="sp-products"></div>
      </div>
      <div class="sp-col">
        <div class="sp-col-hdr"><span>🤝 Team</span><span style="font-size:10px;font-weight:400;color:var(--muted)">Notes &amp; suggestions</span></div>
        <div id="sp-items-team"></div>
        <input class="sp-input" id="sp-new-team" placeholder="Add a note, suggestion, or SOP idea…" onkeydown="spAddOnEnter(event,\\'team\\')"/>
        <div class="sp-type-row">
          <select class="sp-type-sel" id="sp-type-team">
            <option value="suggestion">💡 Suggestion</option>
            <option value="sop">📋 SOP idea</option>
            <option value="recurring">🔁 Recurring task</option>
            <option value="note">📝 Note</option>
          </select>
          <select class="sp-type-sel" id="sp-product-team" style="flex:1.4">
            <option value="">No product</option>
          </select>
          <button class="sp-submit-btn" onclick="spSubmitTeam()">Add</button>
        </div>
      </div>
      <div class="sp-col">
        <div class="sp-col-hdr"><span>👥 Affiliates</span><span style="font-size:10px;font-weight:400;color:var(--muted)">Coming soon</span></div>
        <div class="sp-placeholder">Feedback and requests from the affiliate creator network will surface here — direct into the sprint board.</div>
      </div>
      <div class="sp-col">
        <div class="sp-col-hdr"><span>🧑‍💼 Consultants</span><span style="font-size:10px;font-weight:400;color:var(--muted)">Coming soon</span></div>
        <div class="sp-placeholder">Consultant onboarding feedback, blockers, and suggestions will route here from the contract management portal.</div>
      </div>
      <div class="sp-col sp-col-full">
        <div class="sp-col-hdr"><span>🏷️ Clients &amp; Brands</span><span style="font-size:10px;font-weight:400;color:var(--muted)">Coming soon</span></div>
        <div class="sp-placeholder">Brand requests, campaign feedback, and client asks will land here — linked directly to their client dashboard entries.</div>
      </div>
    </div>
    <div class="sp-plan-cta">
      <button class="btn sp-plan-btn" onclick="openSprintPlanner()">✨ Plan the next sprint</button>
      <span class="sp-plan-sub">AI-guided sprint scoping — answers 6 questions and generates a sprint spec split across product, systems, and team</span>
    </div>
    <div class="sp-week-nav">
      <button class="chip" onclick="spPrev()">← Prev</button>
      <div class="sp-week-lbl" id="sp-week-lbl">…</div>
      <button class="chip" onclick="spNext()">Next →</button>
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
    <div id="blockReassignWrap" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--txt)">
        <input type="checkbox" id="blockReassignChk" style="accent-color:var(--cyan);width:14px;height:14px" onchange="toggleBlockReassign()"/>
        Reassign this task to someone else
      </label>
      <div id="blockReassignSel" style="display:none;margin-top:10px">
        <select id="blockAssignSel" style="width:100%;margin-top:0;padding:10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border)"><option value="">Choose teammate…</option></select>
      </div>
    </div>
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
<!-- push task to sprint modal -->
<div class="overlay" id="pushOverlay">
  <div class="modal" style="max-width:460px">
    <h3>→ Send to Sprint</h3>
    <p class="mt" id="push-task-title" style="font-size:14px;font-weight:600;margin-bottom:4px"></p>
    <p id="push-task-meta" style="font-size:12px;color:var(--muted);margin:0 0 14px"></p>
    <label style="display:block;margin-bottom:6px">Product <span style="color:var(--muted);font-weight:400">(optional)</span></label>
    <select id="push-product" style="width:100%;padding:10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border);font-family:inherit;font-size:13px;margin-bottom:14px"><option value="">No product</option></select>
    <label for="push-note">Note for the sprint <span style="color:var(--muted);font-weight:400">(optional)</span></label>
    <textarea id="push-note" placeholder="What's the update, blocker, or context?" style="width:100%;min-height:70px;margin-top:6px;background:var(--panel2);border:1px solid var(--border);border-radius:8px;color:var(--txt);padding:10px;font-size:13px;font-family:inherit;resize:none"></textarea>
    <div class="err" id="push-err" style="display:none"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closePushOverlay()">Cancel</button>
      <button class="btn" onclick="doPushToSprint()">Add to sprint →</button>
    </div>
  </div>
</div>

<!-- sprint planner modal -->
<div class="overlay" id="planOverlay">
  <div class="modal" style="max-width:580px">
    <h3>✨ Plan the next sprint</h3>
    <div class="plan-progress" id="plan-progress"></div>
    <div id="plan-body"></div>
    <div class="modal-actions" id="plan-actions">
      <button class="btn ghost" onclick="closePlanOverlay()">Cancel</button>
      <button class="btn" id="plan-next-btn" onclick="planNext()">Next →</button>
    </div>
  </div>
</div>

<div class="overlay" id="msg-overlay" onclick="if(event.target===this)closeMsgModal()">
  <div class="modal" style="max-width:560px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
      <div>
        <h3 style="margin:0">Client Report Message</h3>
        <p class="mt" id="msg-modal-for" style="margin:4px 0 0">Ready to send</p>
      </div>
      <button class="btn ghost" style="padding:5px 12px" onclick="closeMsgModal()">&times;</button>
    </div>
    <div class="fg" style="margin-bottom:14px">
      <label>Message &mdash; edit before sending</label>
      <textarea id="msg-text" style="min-height:280px;font-size:12.5px;line-height:1.6"></textarea>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:space-between;align-items:center">
      <div style="display:flex;gap:8px">
        <button class="btn ghost" onclick="copyMsgText()">&#128203; Copy</button>
        <button class="btn ghost" onclick="emailMsgClient()">&#9993; Email</button>
        <button class="btn ghost" onclick="larkMsgClient()">&#128172; Lark DM</button>
      </div>
      <button class="btn ghost" onclick="closeMsgModal()">Close</button>
    </div>
    <div class="err" id="msg-err" style="margin-top:8px"></div>
  </div>
</div>

<!-- add task modal (user) -->
<div class="overlay" id="mt-add-overlay" onclick="if(event.target===this)closeMtAdd()">
  <div class="modal" style="max-width:480px">
    <h3>+ Add Task</h3>
    <p class="mt">This task will be assigned to you.</p>
    <label for="mt-add-title">Task <span style="color:var(--red)">*</span></label>
    <input type="text" id="mt-add-title" placeholder="What needs to get done?"/>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
      <div>
        <label for="mt-add-prio">Priority</label>
        <select id="mt-add-prio" style="width:100%;padding:10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border);font-family:inherit;font-size:13px">
          <option value="">Normal</option>
          <option value="Critical">🔴 Critical</option>
          <option value="High">🟠 High</option>
          <option value="Normal">🟡 Normal</option>
          <option value="Low">⚪ Low</option>
        </select>
      </div>
      <div>
        <label for="mt-add-due">Due Date</label>
        <input type="date" id="mt-add-due" style="width:100%;padding:10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border);font-family:inherit;font-size:13px"/>
      </div>
    </div>
    <div style="margin-top:12px">
      <label for="mt-add-client">Client <span style="color:var(--muted);font-weight:400">(optional)</span></label>
      <select id="mt-add-client" style="width:100%;padding:10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border);font-family:inherit;font-size:13px">
        <option value="">No client</option>
      </select>
    </div>
    <div style="margin-top:12px">
      <label for="mt-add-notes">Notes / Prompt <span style="color:var(--muted);font-weight:400">(optional)</span></label>
      <textarea id="mt-add-notes" placeholder="Any context, links, or instructions…" style="min-height:80px"></textarea>
    </div>
    <div class="err" id="mt-add-err" style="display:none"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeMtAdd()">Cancel</button>
      <button class="btn" id="mt-add-btn" onclick="doMtAdd()">Add Task</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>
<!-- Net sales update modal (admin only) -->
<div class="overlay" id="ns-overlay" onclick="if(event.target===this)closeNsModal()">
  <div class="modal">
    <h3>Update Net Sales Share</h3>
    <p class="mt">Monthly total net sales collected across all brands. ESTIMATED — settles monthly.</p>
    <div class="fg"><label>Net Sales This Month ($)</label><input type="text" id="ns-input" placeholder="e.g. 50000"/></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeNsModal()">Cancel</button>
      <button class="btn" onclick="saveNetSales()">Save</button>
    </div>
  </div>
</div>
<script>
// Dev Mode: when an admin loads /my-tasks?devAs=email, intercept all /api/ fetches
// to forward the devAs param so the server uses that email as the effective user.
var DEV_AS=(new URLSearchParams(window.location.search).get('devAs')||'').toLowerCase();
if(DEV_AS){
  var _origFetch=window.fetch;
  window.fetch=function(u,o){
    if(typeof u==='string'&&u.startsWith('/api/')){
      u+=u.includes('?')?'&devAs=':'?devAs=';
      u+=encodeURIComponent(DEV_AS);
    }
    return _origFetch.call(this,u,o);
  };
}
var ALL=[],FILTER='all',SHOW_BLOCKED=false,CURRENT=null,MODE='complete',TEAM=[],SUBTASKS={},ST_PARENT=null,IS_MANAGER=false,DEL_TARGET=null;
var MT_ADD_CLIENTS=[];
function openMtAdd(){
  document.getElementById('mt-add-title').value='';
  document.getElementById('mt-add-prio').value='';
  document.getElementById('mt-add-due').value='';
  document.getElementById('mt-add-notes').value='';
  var err=document.getElementById('mt-add-err');
  err.style.display='none';err.textContent='';
  document.getElementById('mt-add-btn').disabled=false;
  var cs=document.getElementById('mt-add-client');
  if(MT_ADD_CLIENTS.length){
    cs.innerHTML='<option value="">No client</option>'+MT_ADD_CLIENTS.map(function(c){return'<option value="'+esc(c.id)+'">'+esc(c.name)+'</option>';}).join('');
  } else {
    cs.innerHTML='<option value="">Loading…</option>';
    fetch('/api/my-tasks/clients',{credentials:'include'}).then(function(r){return r.json();}).then(function(d){
      MT_ADD_CLIENTS=d.clients||[];
      cs.innerHTML='<option value="">No client</option>'+MT_ADD_CLIENTS.map(function(c){return'<option value="'+esc(c.id)+'">'+esc(c.name)+'</option>';}).join('');
    }).catch(function(){cs.innerHTML='<option value="">No client</option>';});
  }
  document.getElementById('mt-add-overlay').classList.add('show');
  setTimeout(function(){document.getElementById('mt-add-title').focus();},60);
}
function closeMtAdd(){
  document.getElementById('mt-add-overlay').classList.remove('show');
}
function doMtAdd(){
  var task=document.getElementById('mt-add-title').value.trim();
  var err=document.getElementById('mt-add-err');
  if(!task){err.textContent='Task title is required.';err.style.display='';return;}
  var btn=document.getElementById('mt-add-btn');
  btn.disabled=true;
  var body={
    task:task,
    priority:document.getElementById('mt-add-prio').value||'',
    dueDate:document.getElementById('mt-add-due').value||'',
    promptAction:document.getElementById('mt-add-notes').value.trim(),
    clientRecordId:document.getElementById('mt-add-client').value||''
  };
  fetch('/api/my-tasks/create',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){closeMtAdd();load();toast('Task created');}
    else{err.textContent=d.error||'Failed to create task';err.style.display='';btn.disabled=false;}
  }).catch(function(e){err.textContent='Error: '+e.message;err.style.display='';btn.disabled=false;});
}
var PRIO=[
  {key:'Critical',label:'🔴 Critical',color:'var(--p1)',match:['critical','🔴 critical','p0','urgent']},
  {key:'High',label:'🟠 High',color:'var(--p2)',match:['high','🟠 high','p1']},
  {key:'Normal',label:'🟡 Normal',color:'var(--p3)',match:['normal','🟡 normal','medium','p2']},
  {key:'Low',label:'⚪ Low',color:'var(--p4)',match:['low','⚪ low','p3','']}
];
function prioBucket(p){var s=(p||'').toLowerCase().trim();for(var i=0;i<PRIO.length;i++){if(PRIO[i].match.indexOf(s)>=0)return PRIO[i];}return PRIO[2];}
function esc(s){return(s||'').replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}

function switchTab(idx){
  document.querySelectorAll('.tab').forEach(function(el,i){el.classList.toggle('active',i===idx);});
  document.getElementById('tab-tasks').style.display=idx===0?'':'none';
  document.getElementById('tab-report').style.display=idx===1?'':'none';
  document.getElementById('tab-sprint').style.display=idx===2?'':'none';
  if(idx===1)loadReportTab();
  if(idx===2)loadSprint();
}

/* ── Sprint planner ──────────────────────────────────── */
var SP_WEEK='',SP_DATA={goal:'',items:[]},SP_MY_EMAIL='',SP_IS_ADMIN=false,SP_OFFSET=0,SP_LOADED=false;
var SP_PUSH_TASK=null;
var SP_PLAN_STEP=0,SP_PLAN_ANSWERS=[],SP_PLAN_RESULT=null;

var SP_PRODUCTS=[
  {id:'inner-circle',name:'Inner Circle',emoji:'🌟',desc:'Exclusive affiliate creator portal. Growing membership community for top creators to access resources, events, and Cult Content support.',url:'https://portal.cultcontent.cc/inner-circle',status:'building'},
  {id:'client',name:'Client Dashboard',emoji:'📊',desc:'Analytics, tasks, campaign tracking, and reporting for brand clients. The client-facing window into their TikTok Shop performance.',url:'https://portal.cultcontent.cc/client',status:'live'},
  {id:'manifest',name:'Team Manifest',emoji:'⚙️',desc:'Internal ops engine. Task management, sprint planning, weekly reports, and team coordination for the Cult Content team.',url:'https://manifest.cultcontent.cc',status:'live'},
  {id:'website',name:'Website',emoji:'🌐',desc:'Marketing site, service pages, brand voice, and lead generation for the agency.',url:'https://cultcontent.cc',status:'live'},
  {id:'sisyphus',name:'Sisyphus',emoji:'🪨',desc:'AI operator — autonomous task execution, Nymph agents, sprint planning, Lark integration, and the intelligence layer across all products.',url:'https://sisyphus.cultcontent.cc',status:'live'},
  {id:'contracts',name:'Contract Management',emoji:'📋',desc:'Consultant onboarding, contract signing, and affiliate management portal for the Cult Content consultant network.',url:'https://consultants.cultcontent.cc',status:'building'},
  {id:'carnival-marketplace',name:'Carnival Marketplace',emoji:'🎪',desc:'Creator matchmaking tool for the Culture Commerce Carnival — connecting brands with creators at the event.',url:'https://ccc.cultcontent.cc/market',status:'building'}
];

var SPINE_QS=[
  'What is the feature or goal of this sprint?',
  'What does "done" look like — concrete success criteria?',
  'Which product or surface does this touch? (Inner Circle, Client Dashboard, Manifest, Website, Sisyphus, Contract Mgmt, or something new)',
  'Any external APIs or integrations needed? (TikTok API, Reacher, Meta, Stripe, GHL, Lark, none)',
  'Priority and rough timebox — how many days should this take?',
  'Any locked files that need Claude Code? (index.js, chat.js, chat.html, dashboard-server.js, or none)'
];

var SP_PRODUCT_ACTION_TYPE={};
function renderProducts(){
  var el=document.getElementById('sp-products');
  if(!el)return;
  el.innerHTML=SP_PRODUCTS.map(function(p){
    var pItems=(SP_DATA.items||[]).filter(function(i){return i.productId===p.id;});
    var itemsHtml='';
    if(pItems.length){
      itemsHtml='<div class="sp-product-items">'
        +pItems.map(function(item){
          var done=item.status==='done';
          var icon=item.type==='bug'?'🐛':'✨';
          return'<div class="sp-product-item'+(done?' sp-done':'')+'">'+icon+' <span style="flex:1'+(done?';text-decoration:line-through;opacity:.45':'')+'">'+esc(item.text)+'</span><span style="font-size:10px;color:var(--muted)">'+(item.author||'').split('@')[0]+'</span></div>';
        }).join('')
      +'</div>';
    }
    return '<div class="sp-product-card" id="sppc-'+p.id+'" onclick="spToggleProduct(this)">'
      +'<div class="sp-product-hdr">'
        +'<span class="sp-product-emoji">'+p.emoji+'</span>'
        +'<span class="sp-product-name">'+esc(p.name)+'</span>'
        +(pItems.length?'<span style="font-size:10px;color:var(--muted);font-weight:400">'+pItems.length+' item'+(pItems.length===1?'':'s')+'</span>':'')
        +'<span class="'+(p.status==='live'?'sp-ps-live':'sp-ps-building')+'">'+esc(p.status==='live'?'Live':'Building')+'</span>'
        +'<span class="sp-product-chevron">›</span>'
      +'</div>'
      +'<div class="sp-product-detail" onclick="event.stopPropagation()">'
        +'<p>'+esc(p.desc)+'</p>'
        +'<a href="'+esc(p.url)+'" target="_blank" rel="noopener">'+esc(p.url)+' ↗</a>'
        +itemsHtml
        +'<div class="sp-product-actions">'
          +'<button class="sp-product-act-btn" onclick="spShowProductForm(event,\\''+p.id+'\\',\\'bug\\')">🐛 Report Bug</button>'
          +'<button class="sp-product-act-btn" onclick="spShowProductForm(event,\\''+p.id+'\\',\\'feature\\')">✨ Add Feature</button>'
        +'</div>'
        +'<div class="sp-product-form" id="spf-'+p.id+'" style="display:none">'
          +'<textarea class="sp-input" id="spf-txt-'+p.id+'" placeholder="Describe it…" style="min-height:60px;resize:none;margin-top:0"></textarea>'
          +'<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:7px">'
            +'<button class="btn ghost" style="font-size:12px;padding:5px 12px" onclick="spHideProductForm(event,\\''+p.id+'\\')">Cancel</button>'
            +'<button class="btn" style="font-size:12px;padding:5px 12px" id="spf-btn-'+p.id+'" onclick="spSubmitProductAction(event,\\''+p.id+'\\')">Submit</button>'
          +'</div>'
        +'</div>'
      +'</div>'
    +'</div>';
  }).join('');
}

function spShowProductForm(e,pid,type){
  e.stopPropagation();
  SP_PRODUCT_ACTION_TYPE[pid]=type;
  var form=document.getElementById('spf-'+pid);form.style.display='block';
  var txt=document.getElementById('spf-txt-'+pid);
  txt.placeholder=type==='bug'?'Describe the bug — what happened and what did you expect?':'Describe the feature — what should it do?';
  txt.value='';txt.focus();
}
function spHideProductForm(e,pid){
  e.stopPropagation();
  document.getElementById('spf-'+pid).style.display='none';
  document.getElementById('spf-txt-'+pid).value='';
}
function spSubmitProductAction(e,pid){
  e.stopPropagation();
  var type=SP_PRODUCT_ACTION_TYPE[pid]||'feature';
  var txt=document.getElementById('spf-txt-'+pid);var text=txt.value.trim();if(!text)return;
  var p=SP_PRODUCTS.filter(function(x){return x.id===pid;})[0];if(!p)return;
  var btn=document.getElementById('spf-btn-'+pid);btn.disabled=true;btn.textContent='Saving…';
  fetch('/api/sprint/item',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({week:SP_WEEK,section:'product',text:text,type:type,productId:pid,productName:p.name})})
  .then(function(r){return r.json();}).then(function(d){
    btn.disabled=false;btn.textContent='Submit';
    if(d.ok){SP_DATA.items.push(d.item);spHideProductForm(e,pid);renderProducts();}
    else{toast('Submit failed');}
  }).catch(function(){btn.disabled=false;btn.textContent='Submit';toast('Network error');});
}

function spToggleProduct(card){
  var wasOpen=card.classList.contains('open');
  document.querySelectorAll('.sp-product-card').forEach(function(c){c.classList.remove('open');});
  if(!wasOpen)card.classList.add('open');
}

function spMondayStr(offset){
  var d=new Date(),day=d.getDay(),diff=d.getDate()-day+(day===0?-6:1);
  d.setDate(diff+(offset||0)*7);return d.toISOString().slice(0,10);
}
function spWeekLabel(w){
  var d=new Date(w+'T12:00:00Z'),end=new Date(d);end.setUTCDate(d.getUTCDate()+6);
  var mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return'Week of '+mo[d.getUTCMonth()]+' '+d.getUTCDate()+' – '+mo[end.getUTCMonth()]+' '+end.getUTCDate()+', '+end.getUTCFullYear();
}
function spPrev(){SP_OFFSET--;loadSprint();}
function spNext(){SP_OFFSET++;loadSprint();}

function renderTeamProductSel(){
  var sel=document.getElementById('sp-product-team');if(!sel)return;
  sel.innerHTML='<option value="">No product</option>'+SP_PRODUCTS.map(function(p){
    return'<option value="'+p.id+'">'+p.emoji+' '+esc(p.name)+'</option>';
  }).join('');
}

function loadSprint(){
  SP_WEEK=spMondayStr(SP_OFFSET);
  document.getElementById('sp-week-lbl').textContent=spWeekLabel(SP_WEEK);
  renderProducts();renderTeamProductSel();
  fetch('/api/sprint?week='+SP_WEEK,{credentials:'include'}).then(function(r){return r.json();}).then(function(d){
    SP_DATA=d;SP_MY_EMAIL=d.myEmail||'';SP_IS_ADMIN=!!d.isAdmin;SP_LOADED=true;
    renderProducts();renderSprint();
  }).catch(function(e){console.error('sprint load',e);});
}

function spSaveGoal(){
  var g=document.getElementById('sp-goal').value.trim();
  if(g===(SP_DATA.goal||''))return;
  SP_DATA.goal=g;
  fetch('/api/sprint/goal',{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({week:SP_WEEK,goal:g})});
}

var SP_TYPE_LABELS={suggestion:'💡 Suggestion',sop:'📋 SOP',recurring:'🔁 Recurring',note:'📝 Note',bug:'🐛 Bug',feature:'✨ Feature'};

function renderSprint(){
  var el=document.getElementById('sp-items-team');if(!el)return;
  var items=SP_DATA.items.filter(function(i){return i.section==='team';});
  if(!items.length){el.innerHTML='<div class="sp-empty">Nothing here yet.</div>';return;}
  el.innerHTML=items.map(function(item){
    var done=item.status==='done',inp=item.status==='inprogress';
    var icon=done?'\\u2705':inp?'\\u{1F504}':'\\u2B1C';
    var author=(item.author||'').split('@')[0];
    var canDel=(item.author===SP_MY_EMAIL||SP_IS_ADMIN);
    var votes=(item.votes||[]).length,voted=(item.votes||[]).indexOf(SP_MY_EMAIL)>-1;
    var hasNotes=!!(item.notes&&item.notes.trim());
    var html='<div class="sp-item'+(done?' sp-done':'')+'" data-id="'+esc(item.id)+'">';
    html+='<span class="sp-status" onclick="spCycleStatus(this)" title="Cycle status">'+icon+'</span>';
    html+='<div class="sp-text">'+esc(item.text)+'</div>';
    if(item.type&&SP_TYPE_LABELS[item.type]){
      html+='<span class="sp-type sp-type-'+esc(item.type)+'">'+SP_TYPE_LABELS[item.type]+'</span>';
    }
    if(item.productName){
      var pp=SP_PRODUCTS.filter(function(x){return x.id===item.productId;})[0];
      html+='<span class="sp-product-tag">'+(pp?pp.emoji+' ':'')+esc(item.productName)+'</span>';
    }
    html+='<span class="sp-author">'+esc(author)+'</span>';
    html+='<button class="sp-vote'+(voted?' voted':'')+'" onclick="spVote(this)">▲ '+votes+'</button>';
    html+='<button class="sp-note-btn'+(hasNotes?' has-notes':'')+'" onclick="spToggleNotes(this)" title="'+(hasNotes?'Notes':'Add note')+'">📝</button>';
    if(canDel){html+='<button class="sp-del" onclick="spDel(this)" title="Delete">✕</button>';}
    html+='</div>';
    html+='<div class="sp-item-notes'+(hasNotes?' show':'')+'" data-notes-id="'+esc(item.id)+'">';
    if(hasNotes){html+='<div class="sp-notes-text" onclick="spEditNotes(this)">'+esc(item.notes)+'</div>';}
    html+='<textarea class="sp-notes-input" placeholder="Add a note…" onblur="spSaveNotes(this)">'+(hasNotes?esc(item.notes):'')+'</textarea>';
    html+='</div>';
    return html;
  }).join('');
}

function spSubmitItem(sec){
  var inp=document.getElementById('sp-new-'+sec);var text=(inp.value||'').trim();if(!text)return;
  var typeSel=document.getElementById('sp-type-'+sec);var itemType=typeSel?typeSel.value:null;
  var productSel=document.getElementById('sp-product-'+sec);var productId=productSel?productSel.value:'';
  var p=productId?SP_PRODUCTS.filter(function(x){return x.id===productId;})[0]:null;
  inp.value='';inp.disabled=true;
  var body={week:SP_WEEK,section:sec,text:text};
  if(itemType)body.type=itemType;
  if(productId&&p){body.productId=productId;body.productName=p.name;}
  fetch('/api/sprint/item',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  .then(function(r){return r.json();}).then(function(d){inp.disabled=false;if(d.ok){SP_DATA.items.push(d.item);renderSprint();}})
  .catch(function(){inp.disabled=false;});
}
function spAddOnEnter(e,sec){if(e.key!=='Enter')return;spSubmitItem(sec);}
function spSubmitTeam(){spSubmitItem('team');}

function spToggleNotes(btn){
  var row=btn.closest('.sp-item'),id=row.getAttribute('data-id');
  var notesEl=row.nextElementSibling;
  if(!notesEl||!notesEl.classList.contains('sp-item-notes'))return;
  var showing=notesEl.classList.contains('show');
  notesEl.classList.toggle('show');
  if(!showing){
    var ta=notesEl.querySelector('.sp-notes-input');
    if(ta){ta.style.display='block';ta.focus();}
  }
}

function spEditNotes(textEl){
  var notesEl=textEl.closest('.sp-item-notes');
  var ta=notesEl.querySelector('.sp-notes-input');
  if(ta){textEl.style.display='none';ta.style.display='block';ta.focus();}
}

function spSaveNotes(ta){
  var notesEl=ta.closest('.sp-item-notes');
  if(!notesEl)return;
  var id=notesEl.getAttribute('data-notes-id');
  var notes=ta.value.trim();
  var item=SP_DATA.items.filter(function(i){return i.id===id;})[0];
  if(!item)return;
  if(notes===(item.notes||''))return;
  item.notes=notes;
  ta.style.display='none';
  renderSprint();
  fetch('/api/sprint/item/'+id,{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({week:SP_WEEK,notes:notes})});
}

function spCycleStatus(el){
  var row=el.closest('.sp-item'),id=row.getAttribute('data-id');
  var item=SP_DATA.items.filter(function(i){return i.id===id;})[0];if(!item)return;
  var next={open:'inprogress',inprogress:'done',done:'open'}[item.status]||'open';
  item.status=next;renderSprint();
  fetch('/api/sprint/item/'+id,{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({week:SP_WEEK,status:next})});
}

function spVote(btn){
  var id=btn.closest('.sp-item').getAttribute('data-id');
  fetch('/api/sprint/item/'+id+'/vote',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({week:SP_WEEK})})
  .then(function(r){return r.json();}).then(function(d){
    var item=SP_DATA.items.filter(function(i){return i.id===id;})[0];
    if(item&&d.votes)item.votes=d.votes;renderSprint();
  });
}

function spDel(btn){
  var id=btn.closest('.sp-item').getAttribute('data-id');
  SP_DATA.items=SP_DATA.items.filter(function(i){return i.id!==id;});renderSprint();
  fetch('/api/sprint/item/'+id,{method:'DELETE',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({week:SP_WEEK})});
}

/* ── Push task to sprint ──────────────────────────────── */
function openPushOverlay(recordId){
  var t=ALL.filter(function(x){return x.record_id===recordId;})[0];if(!t)return;
  SP_PUSH_TASK=t;
  document.getElementById('push-task-title').textContent=t.task||'(untitled)';
  var meta=[];
  if(t.client)meta.push(t.client);
  if(t.status)meta.push(t.status);
  if(t.status==='Blocked'&&t.blockedReason)meta.push('⛔ '+t.blockedReason);
  document.getElementById('push-task-meta').textContent=meta.join(' · ');
  document.getElementById('push-note').value='';
  document.getElementById('push-err').style.display='none';
  var psel=document.getElementById('push-product');
  psel.innerHTML='<option value="">No product</option>'+SP_PRODUCTS.map(function(p){return'<option value="'+p.id+'">'+p.emoji+' '+esc(p.name)+'</option>';}).join('');
  psel.value='';
  document.getElementById('pushOverlay').classList.add('show');
  setTimeout(function(){document.getElementById('push-note').focus();},50);
}
function closePushOverlay(){document.getElementById('pushOverlay').classList.remove('show');SP_PUSH_TASK=null;}
function doPushToSprint(){
  if(!SP_PUSH_TASK)return;
  var note=document.getElementById('push-note').value.trim();
  var productId=document.getElementById('push-product').value;
  var p=productId?SP_PRODUCTS.filter(function(x){return x.id===productId;})[0]:null;
  var t=SP_PUSH_TASK;
  var parts=[t.task||'(untitled)'];
  if(t.client)parts.push('('+t.client+')');
  var text=parts.join(' ');
  var body={week:SP_WEEK,section:'team',text:text,type:'note'};
  if(note)body.notes=note;
  else if(t.status==='Blocked'&&t.blockedReason)body.notes='⛔ '+t.blockedReason;
  if(productId&&p){body.productId=productId;body.productName=p.name;}
  fetch('/api/sprint/item',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok&&d.item)SP_DATA.items.push(d.item);
    closePushOverlay();
    if(!SP_LOADED){loadSprint();}else{renderSprint();}
    toast('Added to sprint →');
  }).catch(function(e){
    document.getElementById('push-err').textContent=''+e;document.getElementById('push-err').style.display='block';
  });
}

/* ── Sprint planner (SPINE interview) ────────────────── */
function openSprintPlanner(){
  SP_PLAN_STEP=0;SP_PLAN_ANSWERS=[];SP_PLAN_RESULT=null;
  document.getElementById('planOverlay').classList.add('show');
  renderPlanStep();
}
function closePlanOverlay(){document.getElementById('planOverlay').classList.remove('show');}
function renderPlanStep(){
  var prog=document.getElementById('plan-progress');
  var body=document.getElementById('plan-body');
  var btn=document.getElementById('plan-next-btn');
  if(SP_PLAN_RESULT){renderPlanResult();return;}
  prog.innerHTML=SPINE_QS.map(function(_,i){
    return '<span class="plan-dot'+(i<SP_PLAN_STEP?' done':i===SP_PLAN_STEP?' active':'')+'">';
  }).join('');
  body.innerHTML='<div class="plan-q-num">Question '+(SP_PLAN_STEP+1)+' of '+SPINE_QS.length+'</div>'
    +'<div class="plan-q">'+esc(SPINE_QS[SP_PLAN_STEP])+'</div>'
    +'<textarea class="plan-ans" id="plan-ans" placeholder="Your answer…"></textarea>';
  btn.textContent=SP_PLAN_STEP===SPINE_QS.length-1?'Generate sprint →':'Next →';
  btn.disabled=false;
  setTimeout(function(){var el=document.getElementById('plan-ans');if(el)el.focus();},50);
}
function planNext(){
  if(SP_PLAN_RESULT){approveSprintPlan();return;}
  var ans=(document.getElementById('plan-ans')||{}).value||'';
  SP_PLAN_ANSWERS.push({q:SPINE_QS[SP_PLAN_STEP],a:ans.trim()});
  SP_PLAN_STEP++;
  if(SP_PLAN_STEP>=SPINE_QS.length){
    var btn=document.getElementById('plan-next-btn');
    btn.textContent='Generating…';btn.disabled=true;
    document.getElementById('plan-body').innerHTML='<div style="color:var(--muted);font-size:13px;padding:20px 0 10px;text-align:center">🤖 Generating sprint spec…</div>';
    document.getElementById('plan-progress').innerHTML='';
    generateSprintSpec();
  } else {
    renderPlanStep();
  }
}
function generateSprintSpec(){
  fetch('/api/sprint/plan/generate',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({week:SP_WEEK,answers:SP_PLAN_ANSWERS})})
  .then(function(r){return r.json();})
  .then(function(d){
    if(d.error){document.getElementById('plan-body').innerHTML='<div style="color:var(--red)">Error: '+esc(d.error)+'</div>';document.getElementById('plan-next-btn').textContent='Retry';document.getElementById('plan-next-btn').disabled=false;return;}
    SP_PLAN_RESULT=d;renderPlanResult();
  })
  .catch(function(e){document.getElementById('plan-body').innerHTML='<div style="color:var(--red)">'+esc(''+e)+'</div>';});
}
function renderPlanResult(){
  var r=SP_PLAN_RESULT;if(!r)return;
  var secMeta={product:{label:'Product',cls:'plan-sec-product'},architecture:{label:'Systems',cls:'plan-sec-architecture'},team:{label:'Team',cls:'plan-sec-team'}};
  var body=document.getElementById('plan-body');
  var html='<div style="margin-bottom:16px"><div style="font-size:16px;font-weight:700;margin-bottom:6px">'+esc(r.title||'Sprint')+'</div>';
  if(r.goal)html+='<p style="font-size:13px;color:var(--muted);margin:0">'+esc(r.goal)+'</p></div>';
  if(r.tasks&&r.tasks.length){
    html+='<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">'+r.tasks.length+' tasks to add</div>';
    r.tasks.forEach(function(t,i){
      var sm=secMeta[t.section]||secMeta.team;
      html+='<div class="plan-task-row"><span class="plan-task-num">'+(i+1)+'.</span>'
        +'<div style="flex:1"><div>'+esc(t.text||t.title||'')+'</div>'
        +'<span class="plan-task-sec '+sm.cls+'">'+sm.label+'</span></div></div>';
    });
  }
  html+='</div>';
  body.innerHTML=html;
  var btn=document.getElementById('plan-next-btn');
  btn.textContent='Add '+(r.tasks||[]).length+' items to sprint →';
  btn.disabled=false;
  document.getElementById('plan-progress').innerHTML='';
}
function approveSprintPlan(){
  if(!SP_PLAN_RESULT||!SP_PLAN_RESULT.tasks)return;
  var btn=document.getElementById('plan-next-btn');btn.disabled=true;btn.textContent='Adding…';
  var proms=SP_PLAN_RESULT.tasks.map(function(t){
    return fetch('/api/sprint/item',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({week:SP_WEEK,section:t.section||'architecture',text:t.text||t.title})})
      .then(function(r){return r.json();});
  });
  Promise.all(proms).then(function(results){
    results.forEach(function(d){if(d.ok&&d.item)SP_DATA.items.push(d.item);});
    renderSprint();closePlanOverlay();toast('Sprint items added!');
  }).catch(function(){btn.disabled=false;btn.textContent='Retry';});
}

function load(){
  if(DEV_AS){
    var db=document.getElementById('dev-banner');
    if(db){
      db.style.cssText='display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:rgba(255,0,80,.1);border:1px solid rgba(255,0,80,.35);border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:12.5px;color:var(--red)';
      db.innerHTML='<strong>Dev Mode</strong> — viewing as <strong>'+DEV_AS+'</strong>. Read-only.<button onclick="window.close();setTimeout(function(){window.location.href=\\'/task-management\\';},200);" style="margin-left:auto;padding:4px 12px;border-radius:6px;border:1px solid rgba(255,0,80,.5);background:rgba(255,0,80,.12);color:var(--red);cursor:pointer;font-size:12px;font-weight:600">✕ Exit Dev Mode</button>';
    }
  }
  document.getElementById('sub').textContent='Loading your Ops Engine tasks…';
  fetch('/api/my-tasks/list',{credentials:'include'}).then(function(r){return r.json();}).then(function(d){
    if(d.unlinked){document.getElementById('unlinked').style.display='block';document.getElementById('unlinked').textContent=d.message||'Account not linked.';document.getElementById('sub').textContent='';return;}
    ALL=d.tasks||[];
    IS_MANAGER=!!d.isManager;
    var who=d.devAs||'you';
    document.getElementById('sub').textContent=ALL.length+' active task'+(ALL.length===1?'':'s')+(DEV_AS?' assigned to '+who:'.'+(ALL.length?'':''));
    loadSubtasks();renderFilters();render();
  }).catch(function(e){document.getElementById('sub').textContent='Failed: '+e;});
  loadCompBanner();
}

function loadSubtasks(){
  fetch('/api/subtasks/my',{credentials:'include'}).then(function(r){return r.json();}).then(function(d){SUBTASKS=d.byParent||{};render();}).catch(function(){});
}

function renderFilters(){
  var pillars={};var blockedCount=0;
  ALL.forEach(function(t){if(t.pillar)pillars[t.pillar]=1;if(t.status==='Blocked')blockedCount++;});
  var keys=Object.keys(pillars).sort();
  var el=document.getElementById('filters');el.style.display='flex';
  var html='<div class="chip'+(FILTER==='all'?' active':'')+'" onclick="setFilter(\\'all\\')">All Pillars</div>';
  keys.forEach(function(k){html+='<div class="chip'+(FILTER===k?' active':'')+'" onclick="setFilter(\\''+k.replace(/[^\w\s-]/g,'')+'\\')">'+esc(k)+'</div>';});
  if(blockedCount>0){
    html+='<div class="chip blocked-chip'+(SHOW_BLOCKED?' active':'')+'" onclick="toggleBlocked()">⛔ Blocked ('+blockedCount+')</div>';
  }
  el.innerHTML=html;
}
function setFilter(f){FILTER=f;renderFilters();render();}
function toggleBlocked(){SHOW_BLOCKED=!SHOW_BLOCKED;renderFilters();render();}

function render(){
  var board=document.getElementById('board');
  var list=ALL.filter(function(t){
    if(t.status==='Blocked'&&!SHOW_BLOCKED)return false;
    return FILTER==='all'||t.pillar===FILTER;
  });
  if(!list.length){
    var bHidden=!SHOW_BLOCKED?ALL.filter(function(t){return t.status==='Blocked';}).length:0;
    board.innerHTML=bHidden?'<div class="empty"><div class="big">✓</div>All clear — <span style="color:var(--red);cursor:pointer;text-decoration:underline;text-underline-offset:2px" onclick="toggleBlocked()">'+bHidden+' blocked task'+(bHidden===1?'':'s')+'</span> hidden.</div>':'<div class="empty"><div class="big">✓</div>Nothing here. All caught up.</div>';
    return;
  }
  var html='';
  PRIO.forEach(function(P){
    var g=list.filter(function(t){return prioBucket(t.priority).key===P.key;});
    if(!g.length)return;
    html+='<div class="group"><h2><span class="dot" style="background:'+P.color+'"></span>'+P.label+' · '+g.length+'</h2>';
    g.forEach(function(t){
      var subs=SUBTASKS[t.record_id]||[];
      html+='<div class="card" id="card-'+t.record_id+'"><div class="body">';
      html+='<div class="task-title" id="ttl-'+t.record_id+'" onclick="startEditCardTitle(\\''+t.record_id+'\\')">'+esc(t.task||'(untitled)')+'</div>';
      html+='<div class="meta">';
      if(t.client)html+='<span class="tag client">'+esc(t.client)+'</span>';
      if(t.pillar)html+='<span class="tag">'+esc(t.pillar)+'</span>';
      if(t.status)html+='<span class="tag">'+esc(t.status)+'</span>';
      if(t.executionMode)html+='<span class="tag">'+esc(t.executionMode)+'</span>';
      html+='<select class="prio-sel" title="Priority" onchange="savePriority(this,\\''+t.record_id+'\\')"><option value="🔴 Critical"'+(t.priority==='🔴 Critical'?' selected':'')+'>🔴 Critical</option><option value="🟠 High"'+(t.priority==='🟠 High'?' selected':'')+'>🟠 High</option><option value="🟡 Normal"'+(!t.priority||t.priority==='🟡 Normal'?' selected':'')+'>🟡 Normal</option><option value="⚪ Low"'+(t.priority==='⚪ Low'?' selected':'')+'>⚪ Low</option></select>';
      html+='</div>';
      if(t.promptAction)html+='<div class="prompt">'+esc(t.promptAction)+'</div>';
      if(t.status==='Blocked'&&t.blockedReason)html+='<div class="prompt" style="color:var(--red)">⛔ '+esc(t.blockedReason)+'</div>';
      if(t.sopLink)html+='<div style="margin-top:8px"><a class="sop-btn" href="'+esc(t.sopLink)+'" target="_blank" rel="noopener">📋 SOP ↗</a></div>';
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
      html+='<button class="sp-push-btn" onclick="openPushOverlay(\\''+t.record_id+'\\')">→ Sprint</button>';
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

function savePriority(sel,recordId){
  var val=sel.value;
  var t=ALL.filter(function(x){return x.record_id===recordId;})[0];
  if(t)t.priority=val;
  fetch('/api/my-tasks/priority',{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({record_id:recordId,priority:val})})
    .catch(function(e){toast('Priority save failed');});
}

function startEditCardTitle(recordId){
  var el=document.getElementById('ttl-'+recordId);
  if(!el||el.parentNode.querySelector('.card-title-input'))return;
  var t=ALL.filter(function(x){return x.record_id===recordId;})[0];if(!t)return;
  var inp=document.createElement('input');
  inp.className='card-title-input';inp.value=t.task||'';
  el.style.display='none';
  el.parentNode.insertBefore(inp,el);
  inp.focus();inp.select();
  var saved=false;
  function save(){
    if(saved)return;saved=true;
    var v=inp.value.trim();
    if(v&&v!==(t.task||'')){
      t.task=v;
      el.textContent=v;
      fetch('/api/admin/tasks/'+recordId,{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({task:v})})
        .then(function(r){return r.json();}).then(function(d){if(d.error)toast('Save failed: '+d.error);})
        .catch(function(e){toast(''+e);});
    }
    inp.remove();el.style.display='';
  }
  inp.addEventListener('blur',save);
  inp.addEventListener('keydown',function(e){
    if(e.key==='Enter'){e.preventDefault();inp.blur();}
    if(e.key==='Escape'){saved=true;inp.remove();el.style.display='';}
  });
}

/* client reports */
var WR_REPORT_TYPE='brand_manager';
var WR_BRANDS=[],WR_WEEK_START='',WR_WEEK_END='',MSG_EMAIL='',MSG_BRAND_NAME='';
var COMP_DATA=null,CB_IS_ADMIN=false;

function loadCompBanner(){
  fetch('/api/comp/summary',{credentials:'include'}).then(function(r){return r.json();}).then(function(d){
    COMP_DATA=d;
    CB_IS_ADMIN=!!d.isAdmin;
    if(!d.hasComp&&CB_IS_ADMIN&&!DEV_AS){
      // Admin with no personal comp: show team payroll summary
      loadTeamSummaryBanner();
    } else if(d.hasComp&&CB_IS_ADMIN&&!DEV_AS&&(!d.netSales||d.netSales===0)){
      // Has personal comp but no net sales set: auto-calculate
      fetch('/api/admin/comp/net-sales-auto',{credentials:'include'}).then(function(r){return r.json();}).then(function(auto){
        if(auto.ok&&auto.netSales>0){d.netSales=auto.netSales;d.autoSource=auto.source;COMP_DATA=d;}
        renderCompBanner(d);
      }).catch(function(){renderCompBanner(d);});
    } else {
      renderCompBanner(d);
    }
  }).catch(function(){});
}
function loadTeamSummaryBanner(){
  var el=document.getElementById('comp-banner');
  if(el)el.innerHTML='<div class="tp"><div class="tp-hdr"><span class="tp-title">Team Payroll</span><span class="tp-est">ESTIMATED — settles monthly</span></div><div style="color:var(--muted);font-size:12px">Loading…</div></div>';
  if(el)el.style.display='';
  fetch('/api/admin/comp/net-sales-auto',{credentials:'include'}).then(function(r){return r.json();}).catch(function(){return{};}).then(function(){
    return fetch('/api/admin/comp/team-summary',{credentials:'include'}).then(function(r){return r.json();});
  }).then(function(d){
    renderTeamSummaryBanner(d);
  }).catch(function(e){
    var el2=document.getElementById('comp-banner');
    if(el2)el2.innerHTML='';
  });
}
function renderCompBanner(d){
  var el=document.getElementById('comp-banner');
  if(!d||!d.hasComp){el.style.display='none';return;}
  var bonus=Math.round((d.netSales||0)*(d.bonusPct||0));
  var pct=Math.round((d.bonusPct||0)*1000)/10;
  var netSales=(d.netSales||0).toLocaleString();
  var sourceTag=d.autoSource?'<span style="font-size:10px;background:rgba(0,242,234,.1);color:var(--cyan);padding:1px 6px;border-radius:4px;margin-left:4px">auto</span>':'';
  var gd=d.gateDetails||[];
  var gHtml='';
  gd.forEach(function(g){
    var raw=g.value||0;
    var isRatio=g.key==='ratio';
    var maxVal=isRatio?(d.ratioTiers&&d.ratioTiers[2]||g.hit||1):(g.hit||1);
    var dispVal=isRatio?(Math.round(raw*10)/10)+'×':Math.round(raw);
    var dispFloor=isRatio?g.floor+'×':g.floor;
    var dispHit=isRatio?g.hit+'×':g.hit;
    var prog=Math.min(1,raw/maxVal);
    var floorPos=Math.round((g.floor/maxVal)*100);
    var fillPct=Math.round(prog*100);
    var tierCls=g.score>=1.0?'tier-hit':g.score>=0.5?'tier-floor':'tier-none';
    var tierBonusTxt=g.score>=1.0?('+'+(Math.round((d.hitPct||0)*1000)/10)+'%'):g.score>=0.5?('+'+(Math.round((d.floorPct||0)*1000)/10)+'%'):'no bonus';
    gHtml+='<div class="cb-gate-row">';
    gHtml+='<div class="cb-gate-meta"><span class="cb-gate-lbl">'+esc(g.label)+'</span>';
    gHtml+='<span class="cb-gate-val">'+dispVal+'<span style="opacity:.35;font-size:10px;margin-left:5px">'+dispFloor+' / '+dispHit+'</span></span></div>';
    gHtml+='<div class="cb-bar-wrap">';
    gHtml+='<div class="cb-bar-bg"><div class="cb-bar-fill '+tierCls+'" style="width:'+fillPct+'%"></div></div>';
    gHtml+='<div class="cb-bar-tick" style="left:'+floorPos+'%"></div>';
    gHtml+='</div>';
    gHtml+='<div class="cb-tier-labels">';
    gHtml+='<span style="position:absolute;left:'+floorPos+'%;transform:translateX(-50%)">'+dispFloor+'</span>';
    gHtml+='<span style="position:absolute;right:0">'+dispHit+'</span>';
    gHtml+='<span style="position:absolute;right:0;top:7px;font-size:8px;opacity:.6">'+tierBonusTxt+'</span>';
    gHtml+='</div>';
    gHtml+='</div>';
  });
  var adminBtn=CB_IS_ADMIN&&!DEV_AS?'<button class="cb-update-btn" onclick="openNsModal()">Override</button>':'';
  var html='<div class="cb">';
  html+='<div class="cb-hdr"><span class="cb-title">My Compensation</span><span class="cb-est">ESTIMATED — settles monthly</span></div>';
  html+='<div class="cb-body">';
  html+='<div><div class="cb-payout">$'+bonus.toLocaleString()+'</div>';
  html+='<div class="cb-payout-sub">bonus this month</div>';
  html+='<div class="cb-pct">'+pct+'% of net sales</div></div>';
  html+='<div class="cb-gates">'+gHtml+'</div>';
  html+='</div>';
  html+='<div class="cb-net">Net sales this month: <strong>$'+netSales+'</strong>'+sourceTag+' '+adminBtn+'</div>';
  html+='</div>';
  el.innerHTML=html;el.style.display='';
}
function openNsModal(){
  document.getElementById('ns-input').value=COMP_DATA&&COMP_DATA.netSales?COMP_DATA.netSales:'';
  document.getElementById('ns-overlay').classList.add('show');
}
function closeNsModal(){document.getElementById('ns-overlay').classList.remove('show');}
function saveNetSales(){
  var v=parseFloat(document.getElementById('ns-input').value);
  if(isNaN(v)||v<0){toast('Invalid amount');return;}
  fetch('/api/admin/comp/net-sales',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({netSales:v})})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){closeNsModal();if(CB_IS_ADMIN&&!COMP_DATA.hasComp)loadTeamSummaryBanner();else loadCompBanner();toast('Net sales updated');}
    else toast('Error: '+(d.error||'Failed'));
  }).catch(function(e){toast(''+e);});
}

function renderTeamSummaryBanner(d){
  var el=document.getElementById('comp-banner');
  if(!el)return;
  if(!d||d.error){el.style.display='none';return;}
  var ns=d.netSales||0;
  var nsStr=ns?'$'+ns.toLocaleString():'Not set';
  var currBonus=Math.round(d.totalCurrentBonus||0);
  var maxBonus=Math.round(d.totalMaxBonus||0);
  var currPct=Math.round((d.totalCurrentPct||0)*1000)/10;
  var maxPct=Math.round((d.totalMaxPct||0)*100);
  var cultShare=Math.round(d.cultContentShare||ns);
  var earnedOfMax=maxBonus>0?Math.min(100,Math.round(currBonus/maxBonus*100)):0;
  var sourceTag=d.netSalesSource==='stripe'?'<span style="font-size:10px;background:rgba(0,242,234,.1);color:var(--cyan);padding:1px 6px;border-radius:4px;margin-left:4px">stripe</span>':d.netSalesSource==='weekly_reports'?'<span style="font-size:10px;background:rgba(154,160,181,.1);color:var(--muted);padding:1px 6px;border-radius:4px;margin-left:4px">est.</span>':'';
  var html='<div class="tp">';
  html+='<div class="tp-hdr"><span class="tp-title">Team Payroll</span><span class="tp-est">ESTIMATED — settles monthly</span></div>';
  html+='<div class="tp-meta">';
  html+='<div class="tp-stat"><div class="n">$'+currBonus.toLocaleString()+'</div><div class="l">Current bonus payout</div></div>';
  html+='<div class="tp-stat"><div class="n" style="color:var(--red)">'+maxPct+'%</div><div class="l">Max of net sales (all gates hit)</div></div>';
  html+='<div class="tp-stat"><div class="n" style="color:var(--cyan)">$'+cultShare.toLocaleString()+'</div><div class="l">Cult Content keeps</div></div>';
  html+='</div>';
  html+='<div class="tp-bar-wrap">';
  html+='<div class="tp-bar-label"><span>Earned: '+currPct+'% of net sales ('+earnedOfMax+'% of max)</span><span>Max: '+maxPct+'%</span></div>';
  html+='<div class="tp-bar-bg"><div class="tp-bar-fill" style="width:'+earnedOfMax+'%"></div></div>';
  html+='</div>';
  html+='<div class="tp-members">';
  (d.members||[]).forEach(function(m){
    var mMax=Math.round(ns*(m.maxPct||0));
    var mCurr=Math.round(m.bonusDollars||0);
    var prog=mMax>0?Math.min(100,Math.round(mCurr/mMax*100)):0;
    html+='<div class="tp-member">';
    html+='<div class="tp-member-name">'+esc(m.name)+'</div>';
    html+='<div class="tp-member-bar-bg"><div class="tp-member-bar-fill" style="width:'+prog+'%"></div></div>';
    html+='<div class="tp-member-amt">$'+mCurr.toLocaleString()+'</div>';
    html+='<div class="tp-member-pct" style="font-size:10px;color:var(--muted)">/ $'+mMax.toLocaleString()+'</div>';
    html+='</div>';
  });
  html+='</div>';
  html+='<div class="tp-net">Net sales this month: <strong>'+nsStr+'</strong>'+sourceTag;
  html+=' &nbsp;<button class="cb-update-btn" onclick="openNsModal()">Override</button></div>';
  html+='</div>';
  el.innerHTML=html;el.style.display='';
}

function wrPrevWeekRange(){
  var d=new Date(),day=d.getDay();
  var dss=(day===6)?0:(day+1);
  var sat=new Date(d);sat.setDate(d.getDate()-dss);
  var sun=new Date(sat);sun.setDate(sat.getDate()-6);
  function fmt(dt){return dt.toISOString().slice(0,10);}
  return{start:fmt(sun),end:fmt(sat)};
}
function wrFmtRange(s,e){
  var sd=new Date(s+'T12:00:00Z'),ed=new Date(e+'T12:00:00Z');
  var mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return'Sun '+mo[sd.getUTCMonth()]+' '+sd.getUTCDate()+' – Sat '+mo[ed.getUTCMonth()]+' '+ed.getUTCDate()+', '+ed.getUTCFullYear();
}
function wrSlug(name){return name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');}

function renderClientCards(brands){
  var c=document.getElementById('wr-client-cards');
  if(!brands.length){c.innerHTML='<div style="color:var(--muted);font-size:13px;padding:20px 0">No clients assigned.</div>';return;}
  var html='';
  brands.forEach(function(b){
    var sl=wrSlug(b);
    function eid(n){return'cr-'+n+'-'+sl;}
    html+='<div class="cr-card" id="cr-card-'+sl+'">'
      +'<div class="cr-card-hdr">'
        +'<div><div class="cr-brand">'+esc(b)+'</div><div class="cr-week-lbl" id="'+eid('wlbl')+'">'+wrFmtRange(WR_WEEK_START,WR_WEEK_END)+'</div></div>'
        +'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
          +'<span class="cr-status pending" id="'+eid('status')+'">Not submitted</span>'
          +'<button class="btn ghost" style="font-size:12px;padding:5px 10px" data-brand="'+esc(b)+'" data-sl="'+sl+'" onclick="fetchReacherStats(this.dataset.brand,this.dataset.sl)">↻ Reacher</button>'
        +'</div>'
      +'</div>'
      +'<div class="fr">'
        +'<div class="fg"><label>GMV ($) <span class="cr-auto-tag" id="'+eid('gmvsrc')+'" style="display:none">auto</span></label>'
          +'<input type="number" id="'+eid('gmv')+'" step="0.01" placeholder="0.00" style="font-size:15px"/></div>'
        +'<div class="fg"><label>Net Sales — Seller Center ($)</label>'
          +'<input type="number" id="'+eid('sellerNetSales')+'" step="0.01" placeholder="0.00" style="font-size:15px"/></div>'
      +'</div>'
      +'<div class="fr">'
        +'<div class="fg"><label>Videos Posted</label><input type="number" id="'+eid('videos')+'" placeholder="0"/></div>'
        +'<div class="fg"><label>Samples Sent</label><input type="number" id="'+eid('samples')+'" placeholder="0"/></div>'
      +'</div>'
      +'<div class="fr">'
        +'<div class="fg"><label>CTR (%)</label><input type="number" id="'+eid('ctr')+'" step="0.01" placeholder="0.00"/></div>'
        +'<div class="fg"><label>GMV Conversion Rate (%)</label><input type="number" id="'+eid('conv')+'" step="0.01" placeholder="0.00"/></div>'
      +'</div>'
      +'<div class="fr">'
        +'<div class="fg"><label>Shop Perf Score (/5)</label><input type="number" id="'+eid('sps')+'" step="0.1" max="5" placeholder="0.0"/></div>'
      +'</div>'
      +'<div class="fr full"><div class="fg"><label>Notes for client</label>'
        +'<textarea id="'+eid('notes')+'" style="min-height:60px" placeholder="Wins, next steps, context…"></textarea>'
      +'</div></div>'
      +'<div class="cr-tasks" id="'+eid('tasks')+'">'
        +'<div style="color:var(--muted);font-size:12px">Loading tasks…</div>'
      +'</div>'
      +'<div class="err" id="'+eid('err')+'" style="margin-top:6px"></div>'
      +'<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">'
        +'<button class="btn ghost" data-brand="'+esc(b)+'" data-sl="'+sl+'" onclick="generateClientMsg(this.dataset.brand,this.dataset.sl)">📝 Generate Message</button>'
        +'<button class="btn" data-brand="'+esc(b)+'" data-sl="'+sl+'" onclick="submitClientReport(this.dataset.brand,this.dataset.sl)">Submit Report</button>'
      +'</div>'
    +'</div>';
  });
  c.innerHTML=html;
  // auto-load tasks for every card
  brands.forEach(function(b){loadClientTasks(b,wrSlug(b));});
}

var CR_TASKS={};
function loadClientTasks(brand,sl){
  fetch('/api/weekly-reports/client-tasks?brand='+encodeURIComponent(brand)+'&weekStart='+WR_WEEK_START+'&weekEnd='+WR_WEEK_END,{credentials:'include'})
  .then(function(r){return r.json();}).then(function(d){
    CR_TASKS[sl]=d;
    var el=document.getElementById('cr-tasks-'+sl);if(!el)return;
    var html='';
    if(d.completed&&d.completed.length){
      html+='<div class="cr-tasks-hdr">✅ Completed this week <span style="background:rgba(107,232,107,.15);color:#6be86b;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:700">'+d.completed.length+'</span></div>';
      d.completed.forEach(function(t){
        html+='<div class="cr-task-item"><span style="color:#6be86b;flex-shrink:0">✓</span><div>'
          +'<div>'+esc(t.task)+(t.owner?'<span style="color:var(--muted);font-size:11px"> · '+esc(t.owner)+'</span>':'')+'</div>'
          +(t.result?'<div class="cr-task-result">'+esc(t.result)+'</div>':'')
        +'</div></div>';
      });
    }
    if(d.pending&&d.pending.length){
      if(html)html+='<div style="margin-top:10px"></div>';
      html+='<div class="cr-tasks-hdr">🔄 In progress / pending <span style="background:rgba(154,160,181,.15);color:var(--muted);padding:1px 7px;border-radius:10px;font-size:10px;font-weight:700">'+d.pending.length+'</span></div>';
      d.pending.forEach(function(t){
        var sc=t.status==='Blocked'?'var(--red)':t.status==='In Progress'?'var(--cyan)':'var(--muted)';
        html+='<div class="cr-task-item"><span style="color:'+sc+';flex-shrink:0;font-size:11px">●</span><div>'
          +'<div>'+esc(t.task)+(t.owner?'<span style="color:var(--muted);font-size:11px"> · '+esc(t.owner)+'</span>':'')+'</div>'
          +'<div class="cr-task-result" style="color:'+sc+'">'+esc(t.status||'')+(t.priority?' · '+esc(t.priority):'')+'</div>'
        +'</div></div>';
      });
    }
    if(!html)html='<div style="color:var(--muted);font-size:12px">No tasks found for this client in Lark.</div>';
    el.innerHTML=html;
  }).catch(function(){
    var el=document.getElementById('cr-tasks-'+sl);
    if(el)el.innerHTML='<div style="color:var(--muted);font-size:12px">Could not load tasks.</div>';
  });
}

function fetchReacherStats(brand,sl){
  var btn=document.querySelector('#cr-card-'+sl+' [data-sl="'+sl+'"].btn.ghost');
  if(btn){btn.textContent='Loading…';btn.disabled=true;}
  fetch('/api/weekly-reports/reacher-stats?brand='+encodeURIComponent(brand)+'&weekStart='+WR_WEEK_START+'&weekEnd='+WR_WEEK_END,{credentials:'include'})
  .then(function(r){return r.json();}).then(function(d){
    if(btn){btn.textContent='↻ Reacher';btn.disabled=false;}
    if(d.gmv!=null){
      var el=document.getElementById('cr-gmv-'+sl);if(el)el.value=d.gmv.toFixed(2);
      var src=document.getElementById('cr-gmvsrc-'+sl);if(src)src.style.display='';
    }
    if(d.videos_posted!=null){var v=document.getElementById('cr-videos-'+sl);if(v&&!v.value)v.value=d.videos_posted;}
    if(d.samples_sent!=null){var s=document.getElementById('cr-samples-'+sl);if(s&&!s.value)s.value=d.samples_sent;}
    if(d.ctr!=null){var ct=document.getElementById('cr-ctr-'+sl);if(ct&&!ct.value)ct.value=d.ctr;}
    toast('✓ Reacher data loaded for '+brand);
  }).catch(function(){
    if(btn){btn.textContent='↻ Reacher';btn.disabled=false;}
    toast('⚠ Could not load Reacher data');
  });
}

function crNum(id){var el=document.getElementById(id);return el?parseFloat(el.value)||0:0;}
function crVal(id){var el=document.getElementById(id);return el?el.value.trim():'';}

function submitClientReport(brand,sl){
  var errEl=document.getElementById('cr-err-'+sl);errEl.style.display='none';
  var payload={week:WR_WEEK_START,weekEnd:WR_WEEK_END,reportType:'brand_manager',brand:brand,
    gmv:crNum('cr-gmv-'+sl),sellerNetSales:crNum('cr-sellerNetSales-'+sl),
    videosPosted:crNum('cr-videos-'+sl),samplesCount:crNum('cr-samples-'+sl),
    ctr:crNum('cr-ctr-'+sl),ctor:crNum('cr-conv-'+sl),spsOverall:crNum('cr-sps-'+sl),
    promotionRunning:false,growthOppsEnrolled:false,notes:crVal('cr-notes-'+sl)};
  fetch('/api/weekly-reports/submit',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){
      var s=document.getElementById('cr-status-'+sl);
      if(s){s.textContent='Submitted ✓';s.className='cr-status submitted';}
      loadReportHistory();toast('✅ Report submitted for '+brand+'!');
    } else {errEl.textContent=d.error||'Failed';errEl.style.display='block';}
  }).catch(function(e){errEl.textContent=''+e;errEl.style.display='block';});
}

function generateClientMsg(brand,sl){
  var gmv=crNum('cr-gmv-'+sl),videos=crNum('cr-videos-'+sl),samples=crNum('cr-samples-'+sl);
  var ctr=crNum('cr-ctr-'+sl),conv=crNum('cr-conv-'+sl),sps=crNum('cr-sps-'+sl);
  var notes=crVal('cr-notes-'+sl),range=wrFmtRange(WR_WEEK_START,WR_WEEK_END);
  var fmtGmv='$'+gmv.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  var msg='Hi '+brand+' team 👋\\n\\n'
    +'Here\\'s your TikTok Shop performance update for '+range+':\\n\\n'
    +'📊 This Week\\'s Metrics\\n'
    +'• GMV: '+fmtGmv+'\\n'
    +'• Videos Posted: '+videos+'\\n'
    +'• Samples Sent: '+samples+'\\n'
    +(ctr?'• Click-Through Rate: '+ctr+'%\\n':'')
    +(conv?'• GMV Conversion Rate: '+conv+'%\\n':'')
    +(sps?'\\n⭐ Shop Performance Score: '+sps+' / 5\\n':'');

  // tasks section
  var td=CR_TASKS[sl]||{};
  if(td.completed&&td.completed.length){
    msg+='\\n✅ Completed This Week\\n';
    td.completed.forEach(function(t){
      msg+='• '+t.task+(t.result?' — '+t.result:'')+'\\n';
    });
  }
  if(td.pending&&td.pending.length){
    msg+='\\n🔄 In Progress\\n';
    td.pending.forEach(function(t){
      msg+='• '+t.task+(t.status&&t.status!=='To Do'?' ('+t.status+')':'')+'\\n';
    });
  }

  if(notes)msg+='\\n'+notes+'\\n';
  msg+='\\nLet us know if you have any questions!\\n\\nBest,\\nCult Content';
  MSG_BRAND_NAME=brand;MSG_EMAIL='';
  document.getElementById('msg-modal-for').textContent='For: '+brand;
  document.getElementById('msg-text').value=msg;
  document.getElementById('msg-err').style.display='none';
  fetch('/api/weekly-reports/client-email?brand='+encodeURIComponent(brand),{credentials:'include'})
  .then(function(r){return r.json();}).then(function(d){MSG_EMAIL=d.email||'';}).catch(function(){});
  document.getElementById('msg-overlay').classList.add('show');
}

function closeMsgModal(){document.getElementById('msg-overlay').classList.remove('show');}
function copyMsgText(){
  var t=document.getElementById('msg-text').value;
  if(navigator.clipboard){navigator.clipboard.writeText(t).then(function(){toast('✅ Copied!');});}
  else{var ta=document.getElementById('msg-text');ta.select();document.execCommand('copy');toast('✅ Copied!');}
}
function emailMsgClient(){
  var t=document.getElementById('msg-text').value;
  var subj='TikTok Shop Weekly Update — '+MSG_BRAND_NAME;
  window.open('mailto:'+encodeURIComponent(MSG_EMAIL||'')+'?subject='+encodeURIComponent(subj)+'&body='+encodeURIComponent(t));
}
function larkMsgClient(){
  var t=document.getElementById('msg-text').value;
  var errEl=document.getElementById('msg-err');errEl.style.display='none';
  fetch('/api/weekly-reports/send-lark',{method:'POST',credentials:'include',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({brand:MSG_BRAND_NAME,message:t})})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok)toast('✅ Sent to your Lark!');
    else{errEl.textContent=d.error||'Failed to send';errEl.style.display='block';}
  }).catch(function(e){errEl.textContent=''+e;errEl.style.display='block';});
}

/* old form helpers for non-brand-manager roles */
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
  } else if(type==='community_manager'){
    h+=weekRow();
    h+=sectionLabel('Creator Relations');
    h+='<div class="fr">'+numFg('wr-calls','1:1 Creator Calls')+numFg('wr-videos','Videos Posted (by creators)')+'</div>';
    h+='<div class="fr">'+numFg('wr-signups','New Creator Signups')+numFg('wr-samples','Samples Facilitated')+'</div>';
    h+=notesFg('Wins, blockers, or anything notable this week…');
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
  var rng=wrPrevWeekRange();
  WR_WEEK_START=rng.start;WR_WEEK_END=rng.end;
  document.getElementById('wr-week-display').textContent=wrFmtRange(rng.start,rng.end);
  fetch('/api/weekly-reports/brands',{credentials:'include'}).then(function(r){return r.json();}).then(function(d){
    WR_REPORT_TYPE=d.reportType||'brand_manager';
    WR_BRANDS=d.brands||[];
    CB_IS_ADMIN=!!d.isAdmin;
    if(WR_REPORT_TYPE==='brand_manager'){
      document.getElementById('wr-client-container').style.display='';
      document.getElementById('wr-form-container').style.display='none';
      renderClientCards(WR_BRANDS);
    } else {
      document.getElementById('wr-client-container').style.display='none';
      document.getElementById('wr-form-container').style.display='';
      renderFormForType(WR_REPORT_TYPE,WR_BRANDS);
    }
    if(d.isAdmin){
      document.getElementById('wr-sub-label').textContent='Admin';
      document.getElementById('wr-hist-title').textContent='All Team Reports';
    }
  }).catch(function(){document.getElementById('wr-week-display').textContent='Failed to load';});
  loadReportHistory();
}
function wrChangeWeek(){
  var ns=prompt('Enter week start date (Sunday, YYYY-MM-DD):',WR_WEEK_START);
  if(!ns)return;
  var d=new Date(ns+'T12:00:00Z');
  if(isNaN(d.getTime())){toast('⚠ Invalid date');return;}
  var ne=new Date(d);ne.setUTCDate(d.getUTCDate()+6);
  WR_WEEK_START=ns;WR_WEEK_END=ne.toISOString().slice(0,10);
  document.getElementById('wr-week-display').textContent=wrFmtRange(WR_WEEK_START,WR_WEEK_END);
  if(WR_REPORT_TYPE==='brand_manager'){
    renderClientCards(WR_BRANDS);
  }
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
      } else if(rt==='community_manager'){
        html+='<div class="wr-stat"><div class="n">'+(r.calls||0)+'</div><div class="l">1:1 Calls</div></div>';
        html+='<div class="wr-stat"><div class="n">'+(r.videos||0)+'</div><div class="l">Videos Posted</div></div>';
        html+='<div class="wr-stat"><div class="n">'+(r.signups||0)+'</div><div class="l">Signups</div></div>';
        html+='<div class="wr-stat"><div class="n">'+(r.samples||0)+'</div><div class="l">Samples</div></div>';
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
  } else if(WR_REPORT_TYPE==='community_manager'){
    payload.calls=numVal('wr-calls');payload.videos=numVal('wr-videos');
    payload.signups=numVal('wr-signups');payload.samples=numVal('wr-samples');
    payload.notes=val('wr-notes');
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
  document.getElementById('blockReassignWrap').style.display='none';
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
  var box=document.getElementById('resultBox');box.value='';document.getElementById('modalErr').style.display='none';document.getElementById('confirmBtn').disabled=true;
  var brw=document.getElementById('blockReassignWrap');brw.style.display='block';
  var chk=document.getElementById('blockReassignChk');chk.checked=false;
  document.getElementById('blockReassignSel').style.display='none';
  var fillTeam=function(){
    var sel=document.getElementById('blockAssignSel');
    sel.innerHTML='<option value="">Choose teammate…</option>'+TEAM.map(function(m){return'<option value="'+m.openId+'">'+esc(m.name)+(m.role?' — '+esc(m.role):'')+'</option>';}).join('');
  };
  if(TEAM.length){fillTeam();}else{fetch('/api/my-tasks/team',{credentials:'include'}).then(function(r){return r.json();}).then(function(d){TEAM=d.team||[];fillTeam();}).catch(function(){});}
  document.getElementById('overlay').classList.add('show');setTimeout(function(){box.focus();},50);
}
function toggleBlockReassign(){
  var on=document.getElementById('blockReassignChk').checked;
  document.getElementById('blockReassignSel').style.display=on?'block':'none';
}
function doBlock(){
  if(!CURRENT)return;var reason=document.getElementById('resultBox').value.trim();if(!reason){document.getElementById('modalErr').style.display='block';return;}
  var reassignTo=document.getElementById('blockReassignChk').checked?document.getElementById('blockAssignSel').value:'';
  if(document.getElementById('blockReassignChk').checked&&!reassignTo){document.getElementById('modalErr').style.display='block';document.getElementById('modalErr').textContent='Choose a teammate to reassign to, or uncheck the option.';return;}
  var btn=document.getElementById('confirmBtn');btn.disabled=true;btn.textContent='Saving…';
  fetch('/api/my-tasks/block',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({record_id:CURRENT.record_id,reason:reason})})
  .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});}).then(function(x){
    btn.textContent='Mark blocked';
    if(x.ok&&x.j.verified){
      var rid=CURRENT.record_id;
      ALL=ALL.map(function(t){if(t.record_id===rid){t.status='Blocked';t.blockedReason=x.j.reason;}return t;});
      if(reassignTo){
        fetch('/api/my-tasks/reassign',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({record_id:rid,to_open_id:reassignTo,priority:(CURRENT.priority||'🟡 Normal')})})
        .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});}).then(function(rx){
          if(rx.ok&&rx.j.verified){ALL=ALL.filter(function(t){return t.record_id!==rid;});document.getElementById('sub').textContent=ALL.length+' active task'+(ALL.length===1?'':'s')+' assigned to you.';}
          closeModal();renderFilters();render();toast('⛔ Blocked & reassigned');
        }).catch(function(){closeModal();renderFilters();render();toast('⛔ Blocked');});
      } else {
        closeModal();renderFilters();render();toast('⛔ Blocked');
      }
    }
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
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px;transition:grid-template-columns .2s}
  .sc{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center;transition:background .2s,border-color .2s}
  .sc .n{font-size:30px;font-weight:700}
  .sc .l{font-size:11px;color:var(--muted);text-transform:uppercase;margin-top:4px}
  .sc.highlight-blocked{background:rgba(255,0,80,.1)!important;border-color:var(--red)!important}
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
  /* dev mode overlay */
  .dev-overlay{position:fixed;inset:0;background:rgba(6,7,12,.82);backdrop-filter:blur(4px);display:none;align-items:flex-start;justify-content:center;padding:24px 16px;z-index:60;overflow-y:auto}
  .dev-overlay.show{display:flex}
  .dev-panel{background:var(--panel);border:1px solid var(--border);border-radius:16px;width:100%;max-width:520px;overflow:hidden;flex-shrink:0}
  .dev-panel-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border)}
  .dev-panel-header h3{margin:0;font-size:16px;font-weight:700}
  .dev-close-btn{background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer;line-height:1;padding:0 2px}
  .dev-close-btn:hover{color:var(--txt)}
  .dev-member-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:16px 20px 20px}
  .dev-member-card{background:var(--panel2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;cursor:pointer;transition:.15s}
  .dev-member-card:hover{border-color:var(--cyan);background:rgba(0,242,234,.05)}
  .dev-member-name{font-weight:700;font-size:14px;margin-bottom:2px}
  .dev-member-role{font-size:11px;color:var(--muted)}
  .dev-member-email{font-size:11px;color:var(--cyan);margin-top:4px;opacity:.7}
  /* dev iframe modal */
  .dev-iframe-overlay{position:fixed;inset:0;background:rgba(6,7,12,.95);display:none;flex-direction:column;z-index:70}
  .dev-iframe-overlay.show{display:flex}
  .dev-iframe-bar{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:rgba(255,0,80,.08);border-bottom:1px solid var(--border);flex-shrink:0}
  .dev-iframe-label{font-size:12px;color:var(--red);font-weight:700}
  .dev-iframe-back{background:none;border:1px solid var(--border);color:var(--muted);padding:4px 12px;border-radius:5px;font-size:12px;cursor:pointer;font-family:inherit}
  .dev-iframe-back:hover{border-color:var(--cyan);color:var(--cyan)}
  .dev-iframe-el{flex:1;border:none;background:var(--bg)}
  .prio-badge{display:inline-block;font-size:10px;padding:2px 8px;border-radius:4px;font-weight:700;cursor:pointer;user-select:none;transition:.12s;white-space:nowrap}
  .prio-badge:hover{filter:brightness(1.2)}
  .prio-c{background:rgba(255,0,80,.15);color:var(--red)}
  .prio-h{background:rgba(255,120,50,.15);color:#ff8040}
  .prio-n{background:rgba(255,207,100,.15);color:#ffcf64}
  .prio-l{background:rgba(154,160,181,.15);color:var(--muted)}
  .admin-prio-sel{border:none;border-radius:4px;font-size:10px;font-weight:700;font-family:inherit;padding:2px 6px;cursor:pointer;appearance:none;-webkit-appearance:none}
  .admin-prio-sel:focus{outline:none}
  .tn-editable{cursor:pointer}
  .tn-editable:hover .tn{text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px}
  .tn-input{background:var(--panel2);border:1px solid var(--cyan);border-radius:5px;color:var(--txt);padding:3px 8px;font-size:13px;font-weight:600;font-family:inherit;width:100%;min-width:180px}
  .tn-input:focus{outline:none}
  /* bulk selection */
  .chk-col{width:36px;padding-left:12px!important;padding-right:4px!important}
  tr.row-sel td{background:rgba(0,242,234,.05)!important}
  .bulk-bar{background:linear-gradient(90deg,rgba(0,242,234,.06),rgba(255,0,80,.04));border:1px solid rgba(0,242,234,.3);border-radius:10px;padding:10px 16px;margin-bottom:12px;display:none;align-items:center;gap:10px;flex-wrap:wrap}
  .bulk-bar.show{display:flex}
  .bulk-count{font-size:13px;font-weight:700;color:var(--cyan);min-width:80px;white-space:nowrap}
  .bulk-sep{width:1px;height:22px;background:var(--border);flex-shrink:0}
  .bulk-group{display:flex;align-items:center;gap:6px}
  .bulk-sel{background:var(--panel);border:1px solid var(--border);border-radius:6px;color:var(--txt);padding:5px 9px;font-size:12px;font-family:inherit;cursor:pointer}
  .bulk-sel:focus{outline:none;border-color:var(--cyan)}
  .bulk-btn{background:var(--panel2);border:1px solid var(--border);color:var(--txt);padding:5px 11px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap}
  .bulk-btn:hover{border-color:var(--cyan);color:var(--cyan)}
  .bulk-btn.danger{color:var(--red);border-color:rgba(255,0,80,.35)}
  .bulk-btn.danger:hover{background:rgba(255,0,80,.08)}
  /* clickable stat cards */
  .sc.clickable{cursor:pointer}
  .sc.clickable:hover{border-color:var(--cyan);background:rgba(0,242,234,.06)}
  .sc.card-active{border-color:var(--cyan)!important;background:rgba(0,242,234,.1)!important}
  /* breakdown panel */
  #breakdown-panel{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:16px;display:none}
  #breakdown-panel.show{display:block}
  .breakdown-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
  .breakdown-header h3{margin:0;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600}
  .breakdown-close{background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;padding:0 4px;border-radius:4px;font-family:inherit;line-height:1}
  .breakdown-close:hover{color:var(--txt)}
  .chart-pair{display:flex;gap:24px;flex-wrap:wrap}
  .chart-section{flex:1;min-width:220px}
  .chart-section-title{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;font-weight:600;margin-bottom:10px}
  .chart-inner{display:flex;gap:14px;align-items:center}
  .chart-legend{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
  .chart-legend li{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--txt);white-space:nowrap}
  .legend-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
</style>
</head>
<body>
<div class="wrap">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
    <h1>Task Management</h1>
    <div style="display:flex;gap:8px">
      <a href="/my-tasks" class="chip">← My Tasks</a>
      <button class="chip" onclick="openDevMode()" id="dev-mode-btn" title="Preview any team member's My Tasks view">👁 Dev Mode</button>
      <button class="btn" onclick="openAddTask()" style="font-size:13px;padding:7px 14px">+ Add Task</button>
      <button class="chip" onclick="loadAll()">↻ Refresh</button>
    </div>
  </div>
  <div class="sub" id="sub">Loading all tasks…</div>
  <div class="tabs">
    <button class="tab active" onclick="adminSwitchTab(0)">Tasks</button>
    <button class="tab" onclick="adminSwitchTab(1)">Weekly Reports</button>
  </div>

  <div id="admin-tab-tasks">
    <div class="stats" id="stats-row">
      <div class="sc clickable" id="sc-total" onclick="toggleCard('total','')"><div class="n" id="s-total">—</div><div class="l">Total Active</div></div>
      <div class="sc clickable" id="sc-blocked" onclick="toggleCard('blocked','Blocked')"><div class="n" id="s-blocked" style="color:var(--red)">—</div><div class="l">Blocked</div></div>
      <div class="sc clickable" id="sc-inp" onclick="toggleCard('inp','In Progress')"><div class="n" id="s-inp" style="color:var(--cyan)">—</div><div class="l">In Progress</div></div>
      <div class="sc"><div class="n" id="s-avg">—</div><div class="l" id="s-avg-l">Avg Days to Complete</div></div>
      <div class="sc" id="sc-completed" style="display:none"><div class="n" id="s-completed" style="color:#6be86b">—</div><div class="l" id="s-completed-l">Completed (30d)</div></div>
    </div>
    <div id="breakdown-panel">
      <div class="breakdown-header">
        <h3 id="breakdown-title">Breakdown</h3>
        <button class="breakdown-close" onclick="closeBreakdown()" title="Close">&#x2715;</button>
      </div>
      <div class="chart-pair">
        <div class="chart-section">
          <div class="chart-section-title">By Owner</div>
          <div class="chart-inner" id="chart-owner"></div>
        </div>
        <div class="chart-section">
          <div class="chart-section-title">By Client</div>
          <div class="chart-inner" id="chart-client"></div>
        </div>
      </div>
    </div>
    <div class="fb">
      <select id="f-owner" onchange="applyFilters()"><option value="">All Team Members</option></select>
      <select id="f-client" onchange="applyFilters()"><option value="">All Clients</option></select>
      <select id="f-status" onchange="applyFilters()">
        <option value="">All Statuses</option>
        <option value="To Do">To Do</option>
        <option value="In Progress">In Progress</option>
        <option value="Blocked">Blocked</option>
        <option value="Completed">Completed</option>
      </select>
      <select id="f-type" onchange="applyFilters()">
        <option value="">Tasks + Subtasks</option>
        <option value="task">Tasks only</option>
        <option value="subtask">Subtasks only</option>
      </select>
      <input id="f-search" placeholder="Search tasks…" oninput="applyFilters()" style="min-width:180px"/>
      <input type="date" id="f-date-from" onchange="applyFilters()" title="Created from" style="min-width:130px"/>
      <input type="date" id="f-date-to" onchange="applyFilters()" title="Created to" style="min-width:130px"/>
      <button class="chip" onclick="clearDates()" id="clear-dates-btn" style="display:none">✕ Clear dates</button>
    </div>
    <div class="bulk-bar" id="bulk-bar">
      <span class="bulk-count" id="bulk-count">0 selected</span>
      <button class="bulk-btn" onclick="SELECTED.clear();updateBulkBar();renderTbl()">✕ Clear</button>
      <div class="bulk-sep"></div>
      <div class="bulk-group">
        <select class="bulk-sel" id="bulk-status">
          <option value="">Set Status…</option>
          <option value="To Do">To Do</option>
          <option value="In Progress">In Progress</option>
          <option value="Blocked">Blocked</option>
          <option value="Completed">Completed</option>
        </select>
        <button class="bulk-btn" onclick="doBulkStatus()">Apply</button>
      </div>
      <div class="bulk-group">
        <select class="bulk-sel" id="bulk-owner"><option value="">Set Owner…</option></select>
        <button class="bulk-btn" onclick="doBulkOwner()">Apply</button>
      </div>
      <div class="bulk-group">
        <select class="bulk-sel" id="bulk-client"><option value="">Set Client…</option></select>
        <button class="bulk-btn" onclick="doBulkClient()">Apply</button>
      </div>
      <div class="bulk-sep"></div>
      <button class="bulk-btn" onclick="doBulkDuplicate()">⧉ Duplicate</button>
      <button class="bulk-btn danger" onclick="doBulkDelete()">🗑 Delete Selected</button>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr>
          <th class="chk-col"><input type="checkbox" id="sel-all" onclick="toggleSelectAll(this)" style="accent-color:var(--cyan);cursor:pointer;width:14px;height:14px"/></th>
          <th>Task</th><th>Client</th><th>Owner</th><th>Priority</th><th>Status</th><th>Due</th><th>Days Open</th><th>Action</th>
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
      <select id="wr-f-weeks" onchange="wrQuickRange()">
        <option value="8">Last 8 weeks</option>
        <option value="4">Last 4 weeks</option>
        <option value="12">Last 12 weeks</option>
        <option value="0">All time</option>
        <option value="custom">Custom range…</option>
      </select>
      <input type="date" id="wr-f-from" onchange="renderAdminReports()" style="display:none"/>
      <input type="date" id="wr-f-to" onchange="renderAdminReports()" style="display:none"/>
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

<div class="overlay" id="add-task-overlay">
  <div class="modal" style="max-width:520px">
    <h3>+ Add Task</h3>
    <p class="mt">Create a new task in the Ops Engine Lark table.</p>
    <label for="at-task">Task title <span style="color:var(--red)">*</span></label>
    <input type="text" id="at-task" placeholder="What needs to happen?" style="width:100%;background:var(--panel2);border:1px solid var(--border);border-radius:8px;color:var(--txt);padding:9px 12px;font-size:14px;font-family:inherit;margin-top:6px;margin-bottom:12px"/>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <div>
        <label for="at-owner">Assign to</label>
        <select id="at-owner" style="width:100%;margin-top:6px;padding:9px 10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border);font-family:inherit;font-size:13px">
          <option value="">Unassigned</option>
        </select>
      </div>
      <div>
        <label for="at-client">Client</label>
        <select id="at-client" style="width:100%;margin-top:6px;padding:9px 10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border);font-family:inherit;font-size:13px">
          <option value="">No client</option>
        </select>
      </div>
      <div>
        <label for="at-status">Status</label>
        <select id="at-status" style="width:100%;margin-top:6px;padding:9px 10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border);font-family:inherit;font-size:13px">
          <option value="To Do">To Do</option>
          <option value="In Progress">In Progress</option>
          <option value="Blocked">Blocked</option>
        </select>
      </div>
      <div>
        <label for="at-priority">Priority</label>
        <select id="at-priority" style="width:100%;margin-top:6px;padding:9px 10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border);font-family:inherit;font-size:13px">
          <option value="🟡 Normal">🟡 Normal</option>
          <option value="🔴 Critical">🔴 Critical</option>
          <option value="🟠 High">🟠 High</option>
          <option value="⚪ Low">⚪ Low</option>
        </select>
      </div>
      <div>
        <label for="at-pillar">Pillar</label>
        <input type="text" id="at-pillar" placeholder="e.g. Affiliate Management" style="width:100%;margin-top:6px;padding:9px 10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border);font-family:inherit;font-size:13px"/>
      </div>
      <div>
        <label for="at-due">Due date</label>
        <input type="date" id="at-due" style="width:100%;margin-top:6px;padding:9px 10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border);font-family:inherit;font-size:13px"/>
      </div>
    </div>
    <label for="at-prompt">Prompt / Action notes</label>
    <textarea id="at-prompt" placeholder="Specific instructions, context, or SOP reference…" style="width:100%;min-height:72px;margin-top:6px;background:var(--panel2);border:1px solid var(--border);border-radius:8px;color:var(--txt);padding:10px;font-size:13px;font-family:inherit;resize:vertical"></textarea>
    <div class="err" id="at-err" style="display:none"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeAddTask()">Cancel</button>
      <button class="btn" id="at-submit" onclick="doAddTask()">Create Task</button>
    </div>
  </div>
</div>
<!-- edit task modal (admin) -->
<div class="overlay" id="edit-task-overlay" onclick="if(event.target===this)closeEditTask()">
  <div class="modal" style="max-width:520px">
    <h3>Edit Task</h3>
    <div style="margin-bottom:12px">
      <label for="et-task">Task <span style="color:var(--red)">*</span></label>
      <input type="text" id="et-task" placeholder="What needs to get done?" style="width:100%;margin-top:6px;padding:9px 10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border);font-family:inherit;font-size:13px"/>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <div>
        <label for="et-owner">Assign to</label>
        <select id="et-owner" style="width:100%;margin-top:6px;padding:9px 10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border);font-family:inherit;font-size:13px"></select>
      </div>
      <div>
        <label for="et-client">Client</label>
        <select id="et-client" style="width:100%;margin-top:6px;padding:9px 10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border);font-family:inherit;font-size:13px"></select>
      </div>
      <div>
        <label for="et-status">Status</label>
        <select id="et-status" style="width:100%;margin-top:6px;padding:9px 10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border);font-family:inherit;font-size:13px">
          <option value="To Do">To Do</option>
          <option value="In Progress">In Progress</option>
          <option value="Blocked">Blocked</option>
          <option value="Completed">Completed</option>
        </select>
      </div>
      <div>
        <label for="et-priority">Priority</label>
        <select id="et-priority" style="width:100%;margin-top:6px;padding:9px 10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border);font-family:inherit;font-size:13px">
          <option value="🔴 Critical">🔴 Critical</option>
          <option value="🟠 High">🟠 High</option>
          <option value="🟡 Normal">🟡 Normal</option>
          <option value="⚪ Low">⚪ Low</option>
        </select>
      </div>
      <div>
        <label for="et-due">Due date</label>
        <input type="date" id="et-due" style="width:100%;margin-top:6px;padding:9px 10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border);font-family:inherit;font-size:13px"/>
      </div>
    </div>
    <div class="err" id="et-err" style="display:none"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeEditTask()">Cancel</button>
      <button class="btn" id="et-submit" onclick="doEditTask()">Update Task</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>
<script>
var ALL=[],FILTERED=[],NT=null,ADEL_ID=null,WR_ALL=[],CLIENTS_LIST=[],OWNER_MAP={},SELECTED=new Set();
var ACTIVE_CARD=null;
var EDIT_RID=null;
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

function wrQuickRange(){
  var v=document.getElementById('wr-f-weeks').value;
  var fromEl=document.getElementById('wr-f-from'),toEl=document.getElementById('wr-f-to');
  if(v==='custom'){fromEl.style.display='';toEl.style.display='';}
  else{fromEl.style.display='none';toEl.style.display='none';}
  renderAdminReports();
}
function renderAdminReports(){
  var person=document.getElementById('wr-f-person').value;
  var brand=document.getElementById('wr-f-brand').value;
  var weeks=document.getElementById('wr-f-weeks').value;
  var cutoff=0,cutoffEnd=0;
  if(weeks==='custom'){
    var fromVal=document.getElementById('wr-f-from').value;
    var toVal=document.getElementById('wr-f-to').value;
    cutoff=fromVal?new Date(fromVal).getTime():0;
    cutoffEnd=toVal?new Date(toVal).getTime()+86400000:0;
  } else {
    var w=parseInt(weeks)||0;
    if(w>0){var d=new Date();d.setDate(d.getDate()-w*7);cutoff=d.getTime();}
  }
  var rpts=WR_ALL.filter(function(r){
    if(person&&r.submittedBy!==person)return false;
    if(brand&&r.brand!==brand)return false;
    if(cutoff&&r.submittedAt&&r.submittedAt<cutoff)return false;
    if(cutoffEnd&&r.submittedAt&&r.submittedAt>cutoffEnd)return false;
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
  Promise.all([
    fetch('/api/admin/tasks',{credentials:'include'}).then(function(r){return r.json();}),
    fetch('/api/my-tasks/team',{credentials:'include'}).then(function(r){return r.json();}).catch(function(){return{team:[]};})
  ]).then(function(rs){
    var d=rs[0],teamData=rs[1];
    if(d.error){document.getElementById('sub').textContent='Error: '+d.error;return;}
    ALL=d.tasks||[];CLIENTS_LIST=d.clientsList||[];buildOpts(teamData.team||[]);applyFilters();
    document.getElementById('s-avg').textContent=d.avgDays?d.avgDays+'d':'—';
    var activeTotal=ALL.filter(function(t){return t.status!=='Completed';}).length;
    document.getElementById('sub').textContent=activeTotal+' active tasks across all team members.'+(d.avgDays?' Avg '+d.avgDays+' days to complete.':'');
  }).catch(function(e){document.getElementById('sub').textContent='Failed: '+e;});
}

function openAddTask(){
  document.getElementById('at-task').value='';
  document.getElementById('at-prompt').value='';
  document.getElementById('at-pillar').value='';
  document.getElementById('at-due').value='';
  document.getElementById('at-status').value='To Do';
  document.getElementById('at-priority').value='🟡 Normal';
  document.getElementById('at-err').style.display='none';
  document.getElementById('at-submit').disabled=false;
  document.getElementById('at-submit').textContent='Create Task';
  var ownerSel=document.getElementById('at-owner');
  var ownerOpts=Object.keys(OWNER_MAP).sort(function(a,b){return OWNER_MAP[a].localeCompare(OWNER_MAP[b]);});
  ownerSel.innerHTML='<option value="">Unassigned</option>'+ownerOpts.map(function(id){return'<option value="'+esc(id)+'">'+esc(OWNER_MAP[id])+'</option>';}).join('');
  var clientSel=document.getElementById('at-client');
  clientSel.innerHTML='<option value="">No client</option>'+(CLIENTS_LIST||[]).map(function(c){return'<option value="'+esc(c.id)+'">'+esc(c.name)+'</option>';}).join('');
  document.getElementById('add-task-overlay').classList.add('show');
  setTimeout(function(){document.getElementById('at-task').focus();},50);
}
function closeAddTask(){document.getElementById('add-task-overlay').classList.remove('show');}
function doAddTask(){
  var title=document.getElementById('at-task').value.trim();
  if(!title){
    var e=document.getElementById('at-err');e.textContent='Task title is required.';e.style.display='block';return;
  }
  var btn=document.getElementById('at-submit');btn.disabled=true;btn.textContent='Creating…';
  var body={
    task:title,
    status:document.getElementById('at-status').value,
    priority:document.getElementById('at-priority').value,
    ownerOpenId:document.getElementById('at-owner').value,
    clientRecordId:document.getElementById('at-client').value,
    pillar:document.getElementById('at-pillar').value.trim(),
    promptAction:document.getElementById('at-prompt').value.trim(),
    dueDate:document.getElementById('at-due').value
  };
  fetch('/api/admin/tasks/create',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  .then(function(r){return r.json();}).then(function(d){
    if(d.error){var e=document.getElementById('at-err');e.textContent=d.error;e.style.display='block';btn.disabled=false;btn.textContent='Create Task';return;}
    closeAddTask();
    toast('Task created!');
    loadAll();
  }).catch(function(e){var el=document.getElementById('at-err');el.textContent=''+e;el.style.display='block';btn.disabled=false;btn.textContent='Create Task';});
}

function openEditTask(rid){
  var t=ALL.find(function(x){return x.record_id===rid;});
  if(!t)return;
  EDIT_RID=rid;
  document.getElementById('et-task').value=t.task||'';
  document.getElementById('et-status').value=t.status||'To Do';
  document.getElementById('et-priority').value=t.priority||'🟡 Normal';
  var dueDt=t.dueDate?new Date(t.dueDate).toISOString().slice(0,10):'';
  document.getElementById('et-due').value=dueDt;
  var err=document.getElementById('et-err');err.style.display='none';err.textContent='';
  var btn=document.getElementById('et-submit');btn.disabled=false;btn.textContent='Update Task';
  var ownerOpts=Object.keys(OWNER_MAP).sort(function(a,b){return OWNER_MAP[a].localeCompare(OWNER_MAP[b]);});
  var ownerSel=document.getElementById('et-owner');
  ownerSel.innerHTML='<option value="">Unassigned</option>'+ownerOpts.map(function(id){return'<option value="'+esc(id)+'">'+esc(OWNER_MAP[id])+'</option>';}).join('');
  ownerSel.value=t.ownerOpenId||'';
  var clientSel=document.getElementById('et-client');
  clientSel.innerHTML='<option value="">No client</option>'+(CLIENTS_LIST||[]).map(function(c){return'<option value="'+esc(c.id)+'">'+esc(c.name)+'</option>';}).join('');
  clientSel.value=t.clientRecordId||'';
  document.getElementById('edit-task-overlay').classList.add('show');
  setTimeout(function(){document.getElementById('et-task').focus();},50);
}
function closeEditTask(){
  document.getElementById('edit-task-overlay').classList.remove('show');
  EDIT_RID=null;
}
function doEditTask(){
  if(!EDIT_RID)return;
  var task=document.getElementById('et-task').value.trim();
  var err=document.getElementById('et-err');
  if(!task){err.textContent='Task title is required.';err.style.display='';return;}
  var btn=document.getElementById('et-submit');
  btn.disabled=true;btn.textContent='Saving...';
  var ownerVal=document.getElementById('et-owner').value;
  var clientVal=document.getElementById('et-client').value;
  var dueVal=document.getElementById('et-due').value;
  var body={task:task,status:document.getElementById('et-status').value,priority:document.getElementById('et-priority').value,ownerOpenId:ownerVal,clientRecordId:clientVal};
  if(dueVal)body.dueDate=dueVal;
  fetch('/api/admin/tasks/'+encodeURIComponent(EDIT_RID),{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  .then(function(r){return r.json();}).then(function(d){
    if(d.error){err.textContent=d.error;err.style.display='';btn.disabled=false;btn.textContent='Update Task';return;}
    var t=ALL.find(function(x){return x.record_id===EDIT_RID;});
    if(t){
      t.task=body.task;t.status=body.status;t.priority=body.priority;
      t.ownerOpenId=ownerVal;t.ownerName=ownerVal?OWNER_MAP[ownerVal]||ownerVal:'';
      if(clientVal){var cl=CLIENTS_LIST.find(function(c){return c.id===clientVal;});if(cl){t.client=cl.name;t.clientRecordId=cl.id;}}
      else{t.client='';t.clientRecordId='';}
      if(dueVal)t.dueDate=new Date(dueVal+'T12:00:00.000Z').getTime();
    }
    closeEditTask();applyFilters();toast('Task updated');
  }).catch(function(e){err.textContent=''+e;err.style.display='';btn.disabled=false;btn.textContent='Update Task';});
}

function buildOpts(roster){
  var byId={},clients={};
  (roster||[]).forEach(function(m){if(m.openId&&m.name&&/^ou_[a-f0-9]+$/i.test(m.openId))byId[m.openId]=m.name;});
  ALL.forEach(function(t){
    if(t.ownerOpenId&&t.ownerName&&/^ou_[a-f0-9]+$/i.test(t.ownerOpenId))byId[t.ownerOpenId]=t.ownerName;
    if(t.client)clients[t.client]=1;
  });
  OWNER_MAP=byId;
  var ownerOpts=Object.keys(byId).sort(function(a,b){return byId[a].localeCompare(byId[b]);});
  var ownerHtml='<option value="">All Team Members</option>'+ownerOpts.map(function(id){return'<option value="'+esc(id)+'">'+esc(byId[id])+'</option>';}).join('');
  document.getElementById('f-owner').innerHTML=ownerHtml;
  var cs=document.getElementById('f-client');
  cs.innerHTML='<option value="">All Clients</option>'+Object.keys(clients).sort().map(function(c){return'<option value="'+esc(c)+'">'+esc(c)+'</option>';}).join('');
}
function applyFilters(){
  var ow=document.getElementById('f-owner').value,cl=document.getElementById('f-client').value;
  var st=document.getElementById('f-status').value,ty=document.getElementById('f-type').value;
  var q=(document.getElementById('f-search').value||'').toLowerCase();
  var dateFrom=document.getElementById('f-date-from').value;
  var dateTo=document.getElementById('f-date-to').value;
  var fromMs=dateFrom?new Date(dateFrom).getTime():0;
  var toMs=dateTo?new Date(dateTo).getTime()+86400000:0;
  document.getElementById('clear-dates-btn').style.display=(dateFrom||dateTo)?'':'none';
  var ADMIN_PRIO_ORDER={'🔴 Critical':0,'🟠 High':1,'🟡 Normal':2,'⚪ Low':3};
  FILTERED=ALL.filter(function(t){
    if(ow&&t.ownerOpenId!==ow)return false;
    if(cl&&t.client!==cl)return false;
    if(st&&t.status!==st)return false;
    if(ty==='task'&&t.isSubtask)return false;
    if(ty==='subtask'&&!t.isSubtask)return false;
    if(q&&!(t.task||'').toLowerCase().includes(q)&&!(t.client||'').toLowerCase().includes(q))return false;
    if(fromMs&&t.createdOn&&t.createdOn<fromMs)return false;
    if(toMs&&t.createdOn&&t.createdOn>toMs)return false;
    return true;
  }).sort(function(a,b){
    var pa=(ADMIN_PRIO_ORDER[a.priority]!=null?ADMIN_PRIO_ORDER[a.priority]:2);
    var pb=(ADMIN_PRIO_ORDER[b.priority]!=null?ADMIN_PRIO_ORDER[b.priority]:2);
    if(pa!==pb)return pa-pb;
    return(a.dueDate||9999999999999)-(b.dueDate||9999999999999);
  });
  updateStats(ow,cl,dateFrom,dateTo);
  renderTbl();
  if(ACTIVE_CARD){
    var _brkStatus=ACTIVE_CARD.status;
    var _brkData=FILTERED.filter(function(t){return _brkStatus===''?t.status!=='Completed':t.status===_brkStatus;});
    renderCharts(_brkStatus,_brkData);
  }
}
function clearDates(){
  document.getElementById('f-date-from').value='';
  document.getElementById('f-date-to').value='';
  applyFilters();
}
function updateStats(ownerFilter,clientFilter,dateFrom,dateTo){
  var active=FILTERED.filter(function(t){return t.status!=='Completed';});
  var blocked=active.filter(function(t){return t.status==='Blocked';});
  var inProg=active.filter(function(t){return t.status==='In Progress';});
  document.getElementById('s-total').textContent=active.length;
  document.getElementById('s-blocked').textContent=blocked.length;
  document.getElementById('s-inp').textContent=inProg.length;
  /* highlight blocked card when a client is selected and there are blocks */
  var scBlock=document.getElementById('sc-blocked');
  if(clientFilter&&blocked.length>0){scBlock.classList.add('highlight-blocked');}
  else{scBlock.classList.remove('highlight-blocked');}
  /* 5th card: completed-in-timeframe — show only when owner is selected */
  var scComp=document.getElementById('sc-completed');
  var statsRow=document.getElementById('stats-row');
  if(ownerFilter){
    scComp.style.display='';
    statsRow.style.gridTemplateColumns='repeat(5,1fr)';
    var fromMs=dateFrom?new Date(dateFrom).getTime():Date.now()-30*86400000;
    var toMs=dateTo?new Date(dateTo).getTime()+86400000:Date.now();
    var rangeLabel=dateFrom||dateTo?Math.round((toMs-fromMs)/86400000)+'d range':'30d';
    var cnt=ALL.filter(function(t){return t.status==='Completed'&&t.ownerOpenId===ownerFilter&&t.completedOn&&t.completedOn>=fromMs&&t.completedOn<=toMs;}).length;
    document.getElementById('s-completed').textContent=cnt;
    document.getElementById('s-completed-l').textContent='Completed ('+rangeLabel+')';
  } else {
    scComp.style.display='none';
    statsRow.style.gridTemplateColumns='repeat(4,1fr)';
  }
}
/* ---- breakdown panel ---- */
var CHART_PALETTE=['#00f2ea','#ff7b29','#a78bfa','#34d399','#f472b6','#fbbf24'];
function toggleCard(cardId,statusFilter){
  if(ACTIVE_CARD&&ACTIVE_CARD.id===cardId){closeBreakdown();return;}
  ACTIVE_CARD={id:cardId,status:statusFilter};
  ['sc-total','sc-blocked','sc-inp'].forEach(function(id){
    var el=document.getElementById(id);
    if(el)el.classList.remove('card-active');
  });
  var activeEl=document.getElementById('sc-'+cardId);
  if(activeEl)activeEl.classList.add('card-active');
  var panel=document.getElementById('breakdown-panel');
  var titleEl=document.getElementById('breakdown-title');
  var labels={'total':'All Active Tasks','blocked':'Blocked Tasks','inp':'In Progress Tasks'};
  titleEl.textContent=(labels[cardId]||'Breakdown')+' — Breakdown';
  var data=FILTERED.filter(function(t){
    if(statusFilter==='')return t.status!=='Completed';
    return t.status===statusFilter;
  });
  renderCharts(statusFilter,data);
  panel.classList.add('show');
}
function closeBreakdown(){
  ACTIVE_CARD=null;
  document.getElementById('breakdown-panel').classList.remove('show');
  ['sc-total','sc-blocked','sc-inp'].forEach(function(id){
    var el=document.getElementById(id);
    if(el)el.classList.remove('card-active');
  });
}
function renderCharts(statusFilter,data){
  var ownerCounts={},clientCounts={};
  data.forEach(function(t){
    var o=t.ownerName||'Unassigned';
    ownerCounts[o]=(ownerCounts[o]||0)+1;
    var c=t.client||'No Client';
    clientCounts[c]=(clientCounts[c]||0)+1;
  });
  document.getElementById('chart-owner').innerHTML=buildDonut(ownerCounts,data.length);
  document.getElementById('chart-client').innerHTML=buildDonut(clientCounts,data.length);
}
function buildDonut(countsObj,total){
  var entries=Object.keys(countsObj).map(function(k){return{name:k,count:countsObj[k]};});
  entries.sort(function(a,b){return b.count-a.count;});
  var MAX_SEG=8;
  var shown=entries.slice(0,MAX_SEG);
  var otherCount=entries.slice(MAX_SEG).reduce(function(s,e){return s+e.count;},0);
  if(otherCount>0)shown.push({name:'Other',count:otherCount});
  if(!shown.length||!total)return '<span style="color:var(--muted);font-size:12px">No data</span>';
  var SIZE=160,R=55,r=32,CX=80,CY=80;
  var arcs='';
  var angle=-Math.PI/2;
  shown.forEach(function(seg,i){
    var frac=seg.count/total;
    var sweep=frac*2*Math.PI;
    var x1=CX+R*Math.cos(angle),y1=CY+R*Math.sin(angle);
    var x2=CX+R*Math.cos(angle+sweep),y2=CY+R*Math.sin(angle+sweep);
    var xi1=CX+r*Math.cos(angle),yi1=CY+r*Math.sin(angle);
    var xi2=CX+r*Math.cos(angle+sweep),yi2=CY+r*Math.sin(angle+sweep);
    var lg=sweep>Math.PI?1:0;
    var col=CHART_PALETTE[i%CHART_PALETTE.length];
    arcs+='<path d="M '+xi1+' '+yi1+' L '+x1+' '+y1+' A '+R+' '+R+' 0 '+lg+' 1 '+x2+' '+y2+' L '+xi2+' '+yi2+' A '+r+' '+r+' 0 '+lg+' 0 '+xi1+' '+yi1+' Z" fill="'+col+'" opacity="0.9"/>';
    angle+=sweep;
  });
  var svg='<svg width="'+SIZE+'" height="'+SIZE+'" viewBox="0 0 '+SIZE+' '+SIZE+'" style="flex-shrink:0">'
    +arcs
    +'<text x="'+CX+'" y="'+(CY-7)+'" text-anchor="middle" fill="#e8eaf2" font-size="20" font-weight="700" font-family="inherit">'+total+'</text>'
    +'<text x="'+CX+'" y="'+(CY+11)+'" text-anchor="middle" fill="#9aa0b5" font-size="10" font-family="inherit">total</text>'
    +'</svg>';
  var legend='<ul class="chart-legend">';
  shown.forEach(function(seg,i){
    var col=CHART_PALETTE[i%CHART_PALETTE.length];
    var pct=total>0?Math.round(seg.count/total*100):0;
    legend+='<li><span class="legend-dot" style="background:'+col+'"></span>'
      +'<span>'+esc(seg.name)+' <span style="color:#9aa0b5">('+seg.count+')</span></span></li>';
  });
  legend+='</ul>';
  return svg+legend;
}
var PRIO_VALS=['🔴 Critical','🟠 High','🟡 Normal','⚪ Low'];
var PRIO_CLS={'🔴 Critical':'prio-c','🟠 High':'prio-h','🟡 Normal':'prio-n','⚪ Low':'prio-l'};
function prioSelectHtml(t){
  var pv=t.priority||'🟡 Normal';
  var opts=PRIO_VALS.map(function(v){return'<option value="'+esc(v)+'"'+(v===pv?' selected':'')+'>'+esc(v)+'</option>';}).join('');
  return'<select class="prio-sel admin-prio-sel '+(PRIO_CLS[pv]||'prio-n')+'" data-rid="'+esc(t.record_id)+'" onchange="adminChangePrio(this)">'+opts+'</select>';
}
function adminChangePrio(sel){
  var rid=sel.getAttribute('data-rid');
  var val=sel.value;
  sel.className='prio-sel admin-prio-sel '+(PRIO_CLS[val]||'prio-n');
  var t=ALL.filter(function(x){return x.record_id===rid;})[0];
  if(t)t.priority=val;
  fetch('/api/admin/tasks/'+rid,{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({priority:val})})
    .catch(function(){});
}
function startEditTitle(td,rid){
  if(td.querySelector('.tn-input'))return;
  var t=ALL.filter(function(x){return x.record_id===rid;})[0];if(!t||t.isSubtask)return;
  var wrap=td.querySelector('.tn-wrap');if(!wrap)return;
  var inp=document.createElement('input');
  inp.className='tn-input';inp.value=t.task||'';
  wrap.style.display='none';
  td.insertBefore(inp,wrap);
  inp.focus();inp.select();
  var saved=false;
  function save(){
    if(saved)return;saved=true;
    var v=inp.value.trim();
    if(v&&v!==(t.task||'')){
      t.task=v;
      wrap.querySelector('.tn').firstChild.textContent=(t.isSubtask?'↳ ':'')+v;
      fetch('/api/admin/tasks/'+rid,{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({task:v,isSubtask:!!t.isSubtask})})
        .then(function(r){return r.json();}).then(function(d){if(d.error)toast('Save failed: '+d.error);})
        .catch(function(e){toast(''+e);});
    }
    inp.remove();wrap.style.display='';
  }
  inp.addEventListener('blur',save);
  inp.addEventListener('keydown',function(e){
    if(e.key==='Enter'){e.preventDefault();inp.blur();}
    if(e.key==='Escape'){saved=true;inp.remove();wrap.style.display='';}
  });
}

function daysOpen(t){
  if(!t.createdOn)return'—';
  var end=(t.status==='Completed'&&t.completedOn)?t.completedOn:Date.now();
  var d=Math.floor((end-t.createdOn)/86400000);
  return d>0?d+'d':'<1d';
}
function sbadge(s){var m={'To Do':'badge todo','In Progress':'badge inprogress','Blocked':'badge blocked','Completed':'badge completed'};return'<span class="'+(m[s]||'badge todo')+'">'+esc(s||'—')+'</span>';}
function renderTbl(){
  var tb=document.getElementById('tbody'),em=document.getElementById('empty');
  if(!FILTERED.length){tb.innerHTML='';em.style.display='block';return;}
  em.style.display='none';
  tb.innerHTML=FILTERED.map(function(t){
    var due=t.dueDate?new Date(t.dueDate).toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}):'—';
    var isOverdue=t.dueDate&&t.status!=='Completed'&&t.dueDate<Date.now();
    var rid=esc(t.record_id);
    var sel=SELECTED.has(t.record_id);
    return'<tr class="'+(sel?'row-sel':'')+'">'
      +'<td class="chk-col" onclick="event.stopPropagation()"><input type="checkbox"'+(sel?' checked':'')+' onchange="toggleSelect(\\''+rid+'\\',this)" style="accent-color:var(--cyan);width:14px;height:14px;cursor:pointer"/></td>'
      +'<td class="tn-editable" onclick="startEditTitle(this,\\''+rid+'\\')"><div class="tn-wrap"><div class="tn">'+(t.isSubtask?'↳ ':'')+esc(t.task||'(untitled)')+'</div>'+(t.executionMode?'<div class="ts">'+esc(t.executionMode)+'</div>':'')+(t.sopLink?'<div style="margin-top:4px"><a href="'+esc(t.sopLink)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="font-size:11px;color:var(--cyan);text-decoration:none">📋 SOP ↗</a></div>':'')+'</div></td>'
      +'<td>'+esc(t.client||'—')+'</td>'
      +'<td>'+esc(t.ownerName||'—')+'</td>'
      +'<td>'+(t.isSubtask?'—':prioSelectHtml(t))+'</td>'
      +'<td>'+sbadge(t.status)+'</td>'
      +'<td>'+(isOverdue?'<span style="color:var(--red)">⚠ '+esc(due)+'</span>':esc(due))+'</td>'
      +'<td>'+esc(daysOpen(t))+'</td>'
      +'<td style="white-space:nowrap">'
      +'<button class="btn ghost" style="margin-right:6px" onclick="openEditTask(\\''+rid+'\\')">Edit</button>'
      +(t.ownerOpenId?'<button class="btn ghost" style="margin-right:6px" onclick="openNudge(\\''+t.ownerOpenId+'\\',\\''+esc(t.ownerName||'').replace(/'/g,'')+'\\',\\''+esc((t.task||'').replace(/[\\x27\\x22]/g,'')).slice(0,60)+'\\')">Nudge</button>':'')
      +'<button class="btn ghost" style="color:var(--red);border-color:rgba(255,0,80,.4)" onclick="openAdminDel(\\''+rid+'\\',\\''+esc((t.task||'').replace(/[\\x27\\x22]/g,'')).slice(0,70)+'\\')">Delete</button>'
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
      SELECTED.delete(ADEL_ID);
      closeAdminDel();applyFilters();toast('🗑 Task deleted');
    }else{
      var e=document.getElementById('adel-err');e.textContent=(x.j&&x.j.error)||'Failed';e.style.display='block';btn.disabled=false;
    }
  }).catch(function(e){
    var el=document.getElementById('adel-err');el.textContent=''+e;el.style.display='block';btn.disabled=false;btn.textContent='Delete Task';
  });
}

/* ── Bulk selection ─────────────────────────────────────────────────── */
function toggleSelect(rid,chk){
  if(chk.checked)SELECTED.add(rid);else SELECTED.delete(rid);
  updateBulkBar();
  var sa=document.getElementById('sel-all');
  if(sa){
    var allChk=FILTERED.length>0&&FILTERED.every(function(t){return SELECTED.has(t.record_id);});
    sa.checked=allChk;
    sa.indeterminate=SELECTED.size>0&&!allChk;
  }
}
function toggleSelectAll(chk){
  if(chk.checked)FILTERED.forEach(function(t){SELECTED.add(t.record_id);});
  else SELECTED.clear();
  updateBulkBar();renderTbl();
}
function updateBulkBar(){
  var n=SELECTED.size;
  document.getElementById('bulk-count').textContent=n+' selected';
  document.getElementById('bulk-bar').classList.toggle('show',n>0);
  if(n>0){
    var ownerSel=document.getElementById('bulk-owner');
    var clientSel=document.getElementById('bulk-client');
    var prevOwner=ownerSel.value,prevClient=clientSel.value;
    var ownerOpts=Object.keys(OWNER_MAP).sort(function(a,b){return OWNER_MAP[a].localeCompare(OWNER_MAP[b]);});
    ownerSel.innerHTML='<option value="">Set Owner…</option>'+ownerOpts.map(function(id){return'<option value="'+esc(id)+'">'+esc(OWNER_MAP[id])+'</option>';}).join('');
    clientSel.innerHTML='<option value="">Set Client…</option>'+(CLIENTS_LIST||[]).map(function(c){return'<option value="'+esc(c.id)+'">'+esc(c.name)+'</option>';}).join('');
    if(prevOwner)ownerSel.value=prevOwner;
    if(prevClient)clientSel.value=prevClient;
  }
}
function _bulkPatch(ids,body,label){
  var done=0,total=ids.length,errs=[];
  ids.forEach(function(rid){
    fetch('/api/admin/tasks/'+encodeURIComponent(rid),{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
    .then(function(x){
      if(!x.ok)errs.push((x.j&&x.j.error)||'unknown error');
      if(++done===total){
        if(errs.length)toast('⚠ Failed: '+errs[0]);
        else toast('✅ '+label+' for '+total+' task'+(total>1?'s':''));
        SELECTED.clear();applyFilters();
      }
    })
    .catch(function(e){errs.push(e.message);if(++done===total){toast('⚠ '+errs[0]);SELECTED.clear();applyFilters();}});
  });
}
function doBulkStatus(){
  var val=document.getElementById('bulk-status').value;
  if(!val)return toast('Pick a status first');
  var ids=Array.from(SELECTED);if(!ids.length)return;
  ids.forEach(function(rid){var t=ALL.find(function(x){return x.record_id===rid;});if(t)t.status=val;});
  _bulkPatch(ids,{status:val},'Status updated');
}
function doBulkOwner(){
  var val=document.getElementById('bulk-owner').value;
  if(!val)return toast('Pick an owner first');
  var name=OWNER_MAP[val]||val;
  var ids=Array.from(SELECTED);if(!ids.length)return;
  ids.forEach(function(rid){var t=ALL.find(function(x){return x.record_id===rid;});if(t){t.ownerOpenId=val;t.ownerName=name;}});
  _bulkPatch(ids,{ownerOpenId:val},'Owner updated');
}
function doBulkClient(){
  var val=document.getElementById('bulk-client').value;
  if(!val)return toast('Pick a client first');
  var cl=CLIENTS_LIST.find(function(c){return c.id===val;});
  var ids=Array.from(SELECTED);if(!ids.length)return;
  ids.forEach(function(rid){var t=ALL.find(function(x){return x.record_id===rid;});if(t&&cl){t.client=cl.name;t.clientRecordId=cl.id;}});
  _bulkPatch(ids,{clientRecordId:val},'Client updated');
}
function doBulkDuplicate(){
  var ids=Array.from(SELECTED);if(!ids.length)return;
  if(!confirm('Duplicate '+ids.length+' task'+(ids.length>1?'s':'')+' as new "To Do" tasks?'))return;
  var done=0,total=ids.length;
  ids.forEach(function(rid){
    var t=ALL.find(function(x){return x.record_id===rid;});
    if(!t){if(++done===total){toast('Done');loadAll();}return;}
    var body={task:'Copy: '+(t.task||'Untitled'),status:'To Do',priority:t.priority||'🟡 Normal',ownerOpenId:t.ownerOpenId||'',clientRecordId:t.clientRecordId||'',pillar:t.pillar||''};
    fetch('/api/admin/tasks/create',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(){if(++done===total){toast('✅ Duplicated '+total+' task'+(total>1?'s':''));SELECTED.clear();loadAll();}})
    .catch(function(){if(++done===total){toast('⚠ Some duplicates may have failed');SELECTED.clear();loadAll();}});
  });
}
function doBulkDelete(){
  var ids=Array.from(SELECTED);if(!ids.length)return;
  if(!confirm('Delete '+ids.length+' task'+(ids.length>1?'s':'')+' permanently? This cannot be undone.'))return;
  var done=0,total=ids.length;
  ids.forEach(function(rid){
    fetch('/api/my-tasks/delete',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({record_id:rid})})
    .then(function(){
      ALL=ALL.filter(function(t){return t.record_id!==rid;});
      if(++done===total){toast('🗑 Deleted '+total+' task'+(total>1?'s':''));SELECTED.clear();applyFilters();}
    })
    .catch(function(){if(++done===total){toast('⚠ Some deletes may have failed');SELECTED.clear();applyFilters();}});
  });
}

loadAll();

// ---------- DEV MODE ----------
var DEV_MEMBERS=[
  {name:'Gourab',email:'gourab@cultcontent.cc',role:'Brand Manager'},
  {name:'Gilbert',email:'gilbert@cultcontent.cc',role:'Video Editor'},
  {name:'Jina',email:'gina@cultcontent.cc',role:'Community Manager'},
  {name:'Becca',email:'becca@cultcontent.cc',role:'Community Manager'},
  {name:'Jenna',email:'jenna@cultcontent.cc',role:'Community Manager'},
  {name:'Daniel',email:'daniel@cultcontent.cc',role:'Developer'},
];
function openDevMode(){
  var grid=document.getElementById('dev-member-grid');
  grid.innerHTML=DEV_MEMBERS.map(function(m){
    return '<div class="dev-member-card" onclick="devLoadMember(\\''+m.email+'\\',\\''+m.name+'\\')">'
      +'<div class="dev-member-name">'+m.name+'</div>'
      +'<div class="dev-member-role">'+m.role+'</div>'
      +'<div class="dev-member-email">'+m.email+'</div>'
      +'</div>';
  }).join('');
  document.getElementById('dev-overlay').classList.add('show');
}
function closeDevMode(){document.getElementById('dev-overlay').classList.remove('show');}
function devLoadMember(email,name){
  closeDevMode();
  window.open('/my-tasks?devAs='+encodeURIComponent(email),'_blank');
}
function closeDevIframe(){
  document.getElementById('dev-iframe-overlay').classList.remove('show');
  document.getElementById('dev-iframe-el').src='';
}
</script>

<!-- Dev Mode: member picker overlay -->
<div class="dev-overlay" id="dev-overlay" onclick="if(event.target===this)closeDevMode()">
  <div class="dev-panel">
    <div class="dev-panel-header">
      <h3>👁 Developer Mode</h3>
      <button class="dev-close-btn" onclick="closeDevMode()">×</button>
    </div>
    <p style="margin:12px 20px 0;color:var(--muted);font-size:13px">Select a team member to preview their exact My Tasks view — comp banner, report form, and tasks.</p>
    <div class="dev-member-grid" id="dev-member-grid"></div>
  </div>
</div>

<!-- Dev Mode: iframe overlay -->
<div class="dev-iframe-overlay" id="dev-iframe-overlay">
  <div class="dev-iframe-bar">
    <span class="dev-iframe-label" id="dev-iframe-label"></span>
    <button class="dev-iframe-back" onclick="closeDevIframe()">✕ Exit Dev Mode</button>
  </div>
  <iframe class="dev-iframe-el" id="dev-iframe-el" src="" allowfullscreen></iframe>
</div>

</body>
</html>`;

module.exports = function registerOpsMyTasks(app, deps = {}) {
  const axios = deps.axios || require('axios');
  const express = deps.express || require('express');
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
  const BRANDS_FILE_PATH = nodePath.join(DATA_DIR, 'brands.json');
  function loadBrands() {
    try { return JSON.parse(fs.readFileSync(BRANDS_FILE_PATH, 'utf8')); }
    catch (_) { return { clients: [] }; }
  }
  const WR_FILE = nodePath.join(DATA_DIR, 'weekly-reports.json');
  const ST_FILE = nodePath.join(DATA_DIR, 'subtasks.json');
  const NET_SALES_FILE = nodePath.join(DATA_DIR, 'net-sales.json');

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
  async function larkPost(path, body) {
    const token = await getTenantToken();
    const r = await axios.post(`${LARK_BASE}${path}`, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    });
    return r.data;
  }

  // ---------- (b) list all task records (paginate fully) ----------
  let _tasksCache = { records: null, exp: 0 };
  async function listAllTaskRecords({ bustCache = false } = {}) {
    const now = Date.now();
    if (!bustCache && _tasksCache.records && now < _tasksCache.exp) return _tasksCache.records;
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
    _tasksCache = { records: out, exp: now + 60_000 };
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
    if (data.code !== 0) {
      console.error('[patchRecord]', recordId, 'code:', data.code, 'msg:', data.msg, 'fields:', JSON.stringify(fieldsByName));
      throw new Error('patchRecord: ' + data.code + ' ' + data.msg);
    }
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
    const clientIds = clientRecordIds(f);
    let client = textVal(f.Client);
    if (!client) {
      client = clientIds.map((id) => clientsMap[id]).filter(Boolean).join(', ');
    }
    const ownerArr = Array.isArray(f.Owner) ? f.Owner : [];
    const firstOwner = ownerArr[0] || {};
    return {
      record_id: rec.record_id,
      task: textVal(f.Task),
      client,
      clientRecordId: clientIds[0] || '',
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


  // ---------- ROUTE: PATCH /api/my-tasks/priority ----------
  app.patch('/api/my-tasks/priority', requireAuth, jsonBody, async (req, res) => {
    try {
      const { record_id, priority } = req.body || {};
      if (!record_id || !priority) return res.status(400).json({ error: 'record_id and priority required' });
      await patchRecord(record_id, { 'Priority': priority });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

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
  app.get('/api/my-tasks/team/debug', requireAuth, async (req, res) => {
    const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
    if (!ADMIN_EMAILS.has(email)) return res.status(403).json({ error: 'admin only' });
    const data = await larkGet(`/open-apis/bitable/v1/apps/${OPS_APP_TOKEN}/tables/${TEAM_TABLE}/records`, { page_size: 100 });
    res.json(data);
  });

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
        // Try every known field shape Lark might use for a user ID
        const openId = textVal(f['Open ID']) || textVal(f['open_id']) || textVal(f['OpenID']) ||
          (Array.isArray(f.Person) && f.Person[0] && f.Person[0].id) ||
          (Array.isArray(f['Lark User']) && f['Lark User'][0] && f['Lark User'][0].id) || '';
        if (!openId) continue;
        team.push({
          name: textVal(f.Name) || textVal(f.name) ||
            (Array.isArray(f.Person) && f.Person[0] && (f.Person[0].name || f.Person[0].en_name)) ||
            (Array.isArray(f['Lark User']) && f['Lark User'][0] && (f['Lark User'][0].name || f['Lark User'][0].en_name)) || openId,
          openId,
          role: textVal(f.Role) || textVal(f.role) || '',
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

  // ---------- HELPER: effectiveEmail ----------
  // Allows admin users to impersonate another team member via ?devAs=email query param.
  // Used by Dev Mode to preview My Tasks as any team member — read-only routes only.
  function effectiveEmail(req) {
    const caller = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
    const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(caller);
    const devAs = ((req.query && req.query.devAs) || '').toLowerCase();
    return (isAdmin && devAs) ? devAs : caller;
  }

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
      const callerEmail = req.userEmail || (req.session && req.session.userEmail) || null;
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has((callerEmail||'').toLowerCase());
      const email = effectiveEmail(req) || callerEmail;

      // Team View hook: ?owner=all only for portal admins (devAs overrides this).
      const wantAll = req.query.owner === 'all' && !req.query.devAs;
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

      res.json({
        tasks,
        owner: wantAll && isAdmin ? 'all' : openId,
        isManager: MANAGER_EMAILS.has((callerEmail||'').toLowerCase()),
        devAs: req.query.devAs ? email : undefined,
      });
    } catch (e) {
      console.error('[ops-my-tasks] list error:', e.message);
      res.status(500).json({ error: 'Failed to load tasks', detail: e.message });
    }
  });

  // Ceiling for the optional per-completion point award (Phase 8) — this is
  // a lightweight internal incentive/leaderboard, not a free-form score, so
  // a client can't hand itself an arbitrary total. Chosen conservatively;
  // raise it if a real priority-to-points mapping is ever introduced.
  const MAX_POINTS_PER_COMPLETION = 10;

  // ---------- ROUTE: POST /api/my-tasks/complete ----------
  // Body: { record_id, result, points? }
  //  - 400 if result missing/empty/whitespace (server-side guard, cannot be
  //    bypassed by the client).
  //  - 400 if points is supplied but not a positive number <= MAX_POINTS_PER_COMPLETION.
  //  - 403 if the caller's open_id is not in the task's Owner field
  //    (you cannot complete someone else's task).
  //  - 409 if the task is already Completed (also closes the points-farming
  //    path — a task can only ever award points once).
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

      // Validate points up front (before any Lark I/O) rather than silently
      // swallowing a bad value at award-time — a client sending an invalid
      // points value is worth a clear error, not a completion that quietly
      // doesn't award what was expected.
      const rawPoints = req.body && req.body.points;
      let requestedPoints = null;
      if (rawPoints != null) {
        requestedPoints = Number(rawPoints);
        if (!(requestedPoints > 0)) {
          return res.status(400).json({ error: 'points must be a positive number.' });
        }
        if (requestedPoints > MAX_POINTS_PER_COMPLETION) {
          return res.status(400).json({ error: `points cannot exceed ${MAX_POINTS_PER_COMPLETION} per task.` });
        }
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
      // A task can only be completed (and points-awarded) once. Without
      // this, re-sending the same completion request re-patches Status
      // (Lark write is idempotent either way) and re-awards points every
      // time, since nothing else here checks prior state.
      if (textVal(existingFields.Status) === STATUS.COMPLETED) {
        return res.status(409).json({ error: 'This task is already completed.' });
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

      // Optional point award (Phase 8: point-based task management) — a NEW
      // local ledger (db/staff-points.js), layered on top of this already-
      // verified Lark completion, not a change to the Lark schema itself.
      // requestedPoints was already validated (positive, <= the cap) before
      // any Lark I/O above; a ledger-insert failure here is still non-fatal
      // to the completion response (the task IS completed either way), but
      // an invalid points value was already rejected with 400 up front.
      let pointsAwarded = null;
      if (requestedPoints != null && req.userEmail) {
        try {
          const { awardPoints } = require('../db/staff-points');
          const taskTitle = textVal(afterFields.Task) || null;
          awardPoints({ staffEmail: req.userEmail, taskRecordId: record_id, taskTitle, points: requestedPoints });
          pointsAwarded = Math.round(requestedPoints);
        } catch (e) {
          console.error('[ops-my-tasks] points award failed (non-fatal):', e.message);
        }
      }

      return res.json({
        ok: true,
        verified: true,
        record_id,
        status: afterStatus,
        result: afterResult,
        pointsAwarded,
      });
    } catch (e) {
      console.error('[ops-my-tasks] complete error:', e.message);
      res.status(500).json({ error: 'Failed to complete task', detail: e.message });
    }
  });


  // ---------- ROUTE: GET /api/weekly-reports/brands ----------
  app.get('/api/weekly-reports/brands', requireAuth, async (req, res) => {
    try {
      const callerEmail = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(callerEmail);
      const email = effectiveEmail(req);
      const isDevMode = email !== callerEmail;
      let brands;
      if (isAdmin && !isDevMode) {
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
    } else if (reportType === 'community_manager') {
      fields['1:1 Creator Calls'] = Number(data.calls) || 0;
      fields['Videos Posted'] = Number(data.videos) || 0;
      fields['Creator Signups'] = Number(data.signups) || 0;
      fields['Samples Facilitated'] = Number(data.samples) || 0;
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
      const callerEmail = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(callerEmail);
      const email = effectiveEmail(req);
      const isDevMode = email !== callerEmail;
      const all = readJsonFile(WR_FILE, []);
      let reports;
      if (isAdmin && !isDevMode) {
        reports = all;
      } else {
        // Show only this person's submitted reports
        reports = all.filter((r) => (r.submittedBy || '').toLowerCase() === email);
      }
      res.json({ reports: reports.slice(0, 50) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: GET /api/weekly-reports/client-tasks ----------
  // Returns tasks for a client split into completed-this-week vs pending.
  // Uses a short cache so multiple cards loading simultaneously don't hammer Lark.
  let _allTasksCache = { records: null, clientsMap: null, exp: 0 };
  app.get('/api/weekly-reports/client-tasks', requireAuth, async (req, res) => {
    const { brand, weekStart, weekEnd } = req.query;
    if (!brand) return res.status(400).json({ error: 'brand required' });
    try {
      const now = Date.now();
      let records, clientsMap;
      if (_allTasksCache.records && now < _allTasksCache.exp) {
        ({ records, clientsMap } = _allTasksCache);
      } else {
        [records, clientsMap] = await Promise.all([
          listAllTaskRecords(),
          getClientsMap().catch(() => ({})),
        ]);
        _allTasksCache = { records, clientsMap, exp: now + 5 * 60 * 1000 };
      }

      const weekStartMs = weekStart ? new Date(weekStart + 'T00:00:00.000Z').getTime() : 0;
      const weekEndMs   = weekEnd   ? new Date(weekEnd   + 'T23:59:59.999Z').getTime() : Infinity;
      const brandLower  = brand.toLowerCase().trim();

      const completed = [], pending = [];
      for (const rec of records) {
        const t = shapeTask(rec, clientsMap);
        if (!t.client) continue;
        if (t.client.toLowerCase().trim() !== brandLower) continue;
        if (t.status === 'Completed') {
          const co = t.completedOn;
          if (co && co >= weekStartMs && co <= weekEndMs) {
            completed.push({ task: t.task, owner: t.ownerName, result: textVal((rec.fields || {})['Result / Output']) });
          }
        } else {
          pending.push({ task: t.task, status: t.status, priority: t.priority, owner: t.ownerName });
        }
      }

      res.json({ completed, pending });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: GET /api/weekly-reports/reacher-stats ----------
  app.get('/api/weekly-reports/reacher-stats', requireAuth, async (req, res) => {
    const { brand, weekStart, weekEnd } = req.query;
    if (!brand) return res.status(400).json({ error: 'brand required' });
    try {
      const RAILWAY_URL = process.env.RAILWAY_URL || 'https://cultcontent-server-production.up.railway.app';

      // Try brands.json first, fall back to Reacher shop list by name
      const brands = loadBrands();
      const b = (brands.clients || []).find(c => (c.name || '').toLowerCase() === brand.toLowerCase());
      let shopId = b && b.shopId;

      if (!shopId) {
        try {
          const shopsRes = await axios.get(`${RAILWAY_URL}/affiliate/shops`, { timeout: 8000 });
          const shops = shopsRes.data?.data || shopsRes.data || [];
          const bl = brand.toLowerCase();
          const match = shops.find(s => {
            const sn = (s.shop_name || '').toLowerCase();
            return sn === bl || sn.includes(bl) || bl.includes(sn);
          });
          if (match) shopId = match.shop_id;
        } catch (e) {
          console.error('[reacher-stats] shop list error:', e.message);
        }
      }

      if (!shopId) {
        return res.json({ gmv: null, videos_posted: null, samples_sent: null, ctr: null, note: 'No matching Reacher shop found for "' + brand + '"' });
      }

      // Fetch summary metrics with date range
      const params = {};
      if (weekStart) params.start_date = weekStart;
      if (weekEnd) params.end_date = weekEnd;

      let gmv = null, videos_posted = null, samples_sent = null, ctr = null;
      try {
        const r = await axios.get(`${RAILWAY_URL}/affiliate/shops/${shopId}/summary`, { params, timeout: 10000 });
        // Reacher may wrap the body in a `data` envelope or return fields at the top level
        const body = r.data || {};
        const m = (body.data && typeof body.data === 'object') ? body.data : body;
        console.log('[reacher-stats]', brand, 'shopId:', shopId, 'keys:', Object.keys(m), 'raw:', JSON.stringify(m));
        // Try both naming conventions (total_gmv is the confirmed field from live data)
        const rawGmv = m.total_gmv ?? m.gmv;
        const rawVideos = m.total_videos_posted ?? m.videos_posted ?? m.total_videos;
        const rawSamples = m.total_samples ?? m.sample_requests ?? m.total_sample_requests;
        const rawCtr = m.ctr ?? m.total_ctr;
        if (rawGmv != null) gmv = parseFloat(rawGmv) || 0;
        if (rawVideos != null) videos_posted = parseInt(rawVideos, 10) || 0;
        if (rawSamples != null) samples_sent = parseInt(rawSamples, 10) || 0;
        if (rawCtr != null) ctr = parseFloat(rawCtr) || null;
      } catch (e) {
        console.error('[reacher-stats] summary error:', brand, shopId, e.message);
      }

      res.json({ gmv, videos_posted, samples_sent, ctr });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: GET /api/weekly-reports/client-email ----------
  app.get('/api/weekly-reports/client-email', requireAuth, async (req, res) => {
    const { brand } = req.query;
    if (!brand) return res.json({ email: '' });
    try {
      const brands = loadBrands();
      const b = (brands.clients || []).find(c => (c.name || '').toLowerCase() === brand.toLowerCase());
      const email = (b && (b.billingEmail || b.loginEmail)) || '';
      res.json({ email });
    } catch (_) { res.json({ email: '' }); }
  });

  // ---------- ROUTE: POST /api/weekly-reports/send-lark ----------
  // Sends the generated client message to the submitter's own Lark DM so they
  // can review and forward it to the client's Lark group.
  app.post('/api/weekly-reports/send-lark', requireAuth, jsonBody, async (req, res) => {
    const { brand, message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    try {
      const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const openId = SEED_EMAIL_OPENID[email];

      // Check if brand has a dedicated Lark chat ID
      const brands = loadBrands();
      const b = brand ? (brands.clients || []).find(c => (c.name || '').toLowerCase() === brand.toLowerCase()) : null;
      const chatId = b && b.larkChatId;

      const token = await getTenantToken();
      if (chatId) {
        await axios.post(
          `${LARK_BASE}/open-apis/im/v1/messages?receive_id_type=chat_id`,
          { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: message }) },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
      } else if (openId) {
        const wrapped = `[Report ready to send — ${brand || 'client'}]\n\n${message}\n\n---\nCopy and paste this into your Lark conversation with the client.`;
        await sendLarkMessage(openId, wrapped);
      } else {
        return res.json({ ok: false, error: 'No Lark target found — ask Tommy to set larkChatId on this brand' });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
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
        tasks.push(shaped);
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
      const clientsList = Object.entries(clientsMap).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
      res.json({ tasks, avgDays, clientsList });
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

  // ---------- SPRINT PLANNER ROUTES ----------
  const SP_FILE = nodePath.join(DATA_DIR, 'sprints.json');

  function mondayOf(d) {
    const day = d.getDay(), diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const mon = new Date(d); mon.setDate(diff);
    return mon.toISOString().slice(0, 10);
  }

  app.get('/api/sprint', requireAuth, async (req, res) => {
    try {
      const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(email);
      const week = req.query.week || mondayOf(new Date());
      const sprints = readJsonFile(SP_FILE, {});
      const sprint = sprints[week] || { goal: '', items: [] };
      res.json({ week, goal: sprint.goal || '', items: sprint.items || [], myEmail: email, isAdmin });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/sprint/item', requireAuth, jsonBody, async (req, res) => {
    try {
      const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const { week, section, text } = req.body || {};
      if (!week || !['product','architecture','team'].includes(section) || !(text||'').trim())
        return res.status(400).json({ error: 'week, section, and text are required' });
      const sprints = readJsonFile(SP_FILE, {});
      if (!sprints[week]) sprints[week] = { goal: '', items: [] };
      const type = (req.body.type && ['suggestion','sop','recurring','note','bug','feature'].includes(req.body.type)) ? req.body.type : null;
      const item = { id: genId(), section, text: text.trim(), status: 'open', author: email, votes: [], createdAt: Date.now() };
      if (type) item.type = type;
      if (req.body.productId) item.productId = String(req.body.productId).slice(0, 64);
      if (req.body.productName) item.productName = String(req.body.productName).slice(0, 128);
      sprints[week].items.push(item);
      writeJsonFile(SP_FILE, sprints);
      res.json({ ok: true, item });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/sprint/item/:id', requireAuth, jsonBody, async (req, res) => {
    try {
      const { week, status, text, notes } = req.body || {};
      const sprints = readJsonFile(SP_FILE, {});
      const sprint = sprints[week]; if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
      const item = sprint.items.find(i => i.id === req.params.id);
      if (!item) return res.status(404).json({ error: 'Item not found' });
      if (status) item.status = status;
      if (text) item.text = text.trim();
      if (notes !== undefined) item.notes = notes;
      writeJsonFile(SP_FILE, sprints);
      res.json({ ok: true, item });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/sprint/item/:id', requireAuth, jsonBody, async (req, res) => {
    try {
      const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(email);
      const { week } = req.body || {};
      const sprints = readJsonFile(SP_FILE, {});
      const sprint = sprints[week]; if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
      const idx = sprint.items.findIndex(i => i.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Item not found' });
      if (!isAdmin && sprint.items[idx].author !== email)
        return res.status(403).json({ error: 'Not your item' });
      sprint.items.splice(idx, 1);
      writeJsonFile(SP_FILE, sprints);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/sprint/item/:id/vote', requireAuth, jsonBody, async (req, res) => {
    try {
      const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const { week } = req.body || {};
      const sprints = readJsonFile(SP_FILE, {});
      const sprint = sprints[week]; if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
      const item = sprint.items.find(i => i.id === req.params.id);
      if (!item) return res.status(404).json({ error: 'Item not found' });
      item.votes = item.votes || [];
      const idx = item.votes.indexOf(email);
      if (idx === -1) item.votes.push(email); else item.votes.splice(idx, 1);
      writeJsonFile(SP_FILE, sprints);
      res.json({ ok: true, votes: item.votes });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/sprint/goal', requireAuth, jsonBody, async (req, res) => {
    try {
      const { week, goal } = req.body || {};
      if (!week) return res.status(400).json({ error: 'week required' });
      const sprints = readJsonFile(SP_FILE, {});
      if (!sprints[week]) sprints[week] = { goal: '', items: [] };
      sprints[week].goal = goal || '';
      writeJsonFile(SP_FILE, sprints);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/sprint/plan/generate', requireAuth, jsonBody, async (req, res) => {
    try {
      const { answers } = req.body || {};
      if (!answers || !answers.length) return res.status(400).json({ error: 'answers required' });
      const transcriptText = answers.map((a, i) => `Q${i + 1}: ${a.q}\nA${i + 1}: ${a.a || '(no answer)'}`).join('\n\n');
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: `You are a sprint planning assistant for Cult Content, a TikTok Shop agency. Convert a planning interview into a structured sprint spec.

Respond ONLY with valid JSON (no markdown fence):
{
  "title": "short sprint title (5-10 words)",
  "goal": "one paragraph sprint goal",
  "tasks": [
    { "text": "short actionable task title (under 80 chars)", "section": "product|architecture|team" }
  ]
}

"product" = vision, UX, strategy, roadmap decisions (Tommy's work)
"architecture" = technical implementation, systems, APIs (Daniel's work)
"team" = SOPs, processes, documentation, recurring workflows

Produce 4-8 tasks split across relevant sections. Keep task titles short and actionable.`,
        messages: [{ role: 'user', content: `Sprint planning interview:\n\n${transcriptText}\n\nGenerate sprint spec as JSON.` }]
      });
      const text = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      let parsed;
      try {
        const clean = text.replace(/^```(?:json)?\n?/,'').replace(/\n?```$/,'');
        const start = clean.search(/[{[]/);
        parsed = JSON.parse(start >= 0 ? clean.slice(start) : clean);
      } catch { return res.status(500).json({ error: 'Failed to parse model response', raw: text.slice(0,300) }); }
      res.json(parsed);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/admin/tasks/:recordId', requireAuth, jsonBody, async (req, res) => {
    try {
      const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(email);
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const { task, priority, isSubtask, status, ownerOpenId, clientRecordId, dueDate } = req.body || {};
      const hasChange = task || priority || status || ownerOpenId !== undefined || clientRecordId !== undefined || dueDate;
      if (!hasChange) return res.status(400).json({ error: 'at least one field required' });
      if (isSubtask) {
        const sts = readJsonFile(ST_FILE, []);
        const st = sts.find(s => s.id === req.params.recordId);
        if (!st) return res.status(404).json({ error: 'Subtask not found' });
        if (task) st.title = task.trim();
        writeJsonFile(ST_FILE, sts);
        return res.json({ ok: true });
      }
      if (ownerOpenId && !/^ou_[a-f0-9]+$/i.test(ownerOpenId)) {
        return res.status(400).json({ error: `Invalid owner ID format: "${ownerOpenId}" — expected ou_... Lark open_id` });
      }
      const fields = {};
      if (task) fields['Task'] = task.trim();
      if (priority) fields['Priority'] = priority;
      if (status) fields['Status'] = status;
      if (ownerOpenId !== undefined) fields['Owner'] = ownerOpenId ? [{ id: ownerOpenId }] : [];
      if (clientRecordId !== undefined) fields['Client'] = clientRecordId ? [clientRecordId] : [];
      if (dueDate) fields['Due Date'] = new Date(dueDate + 'T12:00:00.000Z').getTime();
      console.log('[admin/tasks PATCH]', req.params.recordId, 'fields:', JSON.stringify(fields));
      await patchRecord(req.params.recordId, fields);
      _tasksCache.exp = 0; // bust so next GET re-fetches
      res.json({ ok: true });
    } catch (e) {
      console.error('[admin/tasks PATCH]', req.params.recordId, e.message, e.response && JSON.stringify(e.response.data));
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/tasks/create', requireAuth, jsonBody, async (req, res) => {
    try {
      const email = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(email);
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
      const { task, status, priority, ownerOpenId, pillar, promptAction, dueDate, clientRecordId } = req.body || {};
      if (!(task || '').trim()) return res.status(400).json({ error: 'task is required' });
      const fields = { 'Task': task.trim(), 'Status': status || 'To Do', 'Created On': Date.now() };
      if (priority) fields['Priority'] = priority;
      if (ownerOpenId) fields['Owner'] = [{ id: ownerOpenId }];
      if (pillar) fields['Pillar'] = pillar;
      if (promptAction) fields['Prompt / Action'] = promptAction;
      // Store at noon UTC so local-timezone display never drifts to the wrong day
      if (dueDate) fields['Due Date'] = new Date(dueDate + 'T12:00:00.000Z').getTime();
      if (clientRecordId) fields['Client'] = [clientRecordId];
      const data = await larkPost(
        `/open-apis/bitable/v1/apps/${OPS_APP_TOKEN}/tables/${TASKS_TABLE}/records`,
        { fields }
      );
      if (data.code !== 0) {
        console.error('[admin/tasks/create] Lark error', data.code, data.msg, 'fields:', JSON.stringify(fields));
        return res.status(500).json({ error: `Lark error ${data.code}: ${data.msg}` });
      }
      _tasksCache.exp = 0; // bust so next GET re-fetches
      res.json({ ok: true, record: data.data && data.data.record });
    } catch (e) {
      console.error('[admin/tasks/create]', e.message, e.response && JSON.stringify(e.response.data));
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: GET /api/my-tasks/clients ----------
  app.get('/api/my-tasks/clients', requireAuth, async (req, res) => {
    try {
      const clientsMap = await getClientsMap();
      const clients = Object.entries(clientsMap)
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ clients });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- ROUTE: POST /api/my-tasks/create ----------
  app.post('/api/my-tasks/create', requireAuth, jsonBody, async (req, res) => {
    try {
      const { openId } = await resolveCaller(req);
      if (!openId) return res.status(403).json({ error: 'Could not resolve your Lark user. Make sure your account is linked.' });
      const { task, priority, dueDate, promptAction, clientRecordId } = req.body || {};
      if (!(task || '').trim()) return res.status(400).json({ error: 'task is required' });
      const fields = { 'Task': task.trim(), 'Status': 'To Do', 'Created On': Date.now() };
      fields['Owner'] = [{ id: openId }];
      if (priority) fields['Priority'] = priority;
      if (dueDate) fields['Due Date'] = new Date(dueDate + 'T12:00:00.000Z').getTime();
      if (promptAction) fields['Prompt / Action'] = promptAction;
      if (clientRecordId) fields['Client'] = [clientRecordId];
      const data = await larkPost(
        `/open-apis/bitable/v1/apps/${OPS_APP_TOKEN}/tables/${TASKS_TABLE}/records`,
        { fields }
      );
      if (data.code !== 0) return res.status(500).json({ error: `Lark error ${data.code}: ${data.msg}` });
      res.json({ ok: true, record: data.data && data.data.record });
    } catch (e) { console.error('[my-tasks/create]', e.message, e.response && e.response.data); res.status(500).json({ error: e.message }); }
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
  // ---------- SERVER-SIDE COMP TIER HELPER ----------
  function computeCompTierSrv(model, kpis) {
    const { gates, hitPct, ratioTiers } = model;
    const gateDetails = gates.map(g => {
      let value = kpis[g.key] || 0;
      let score = 0;
      if (ratioTiers && g.key === 'ratio') {
        if (value >= ratioTiers[2]) score = 1.0;
        else if (value >= ratioTiers[1]) score = 0.75;
        else if (value >= ratioTiers[0]) score = 0.5;
      } else {
        if (value >= g.hit) score = 1.0;
        else if (value >= g.floor) score = 0.5;
      }
      return { key: g.key, label: g.label, floor: g.floor, hit: g.hit, value, score };
    });
    const totalScore = gateDetails.reduce((s, g) => s + g.score, 0);
    const bonusPct = gates.length ? (totalScore / gates.length) * hitPct : 0;
    return { bonusPct, gateDetails };
  }

  // ---------- ROUTE: GET /api/comp/summary ----------
  app.get('/api/comp/summary', requireAuth, async (req, res) => {
    try {
      const callerForAdmin = (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const isAdminCaller = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(callerForAdmin);
      const email = effectiveEmail(req);
      const model = COMP_MODEL[email];
      if (!model) return res.json({ hasComp: false, isAdmin: isAdminCaller });

      const now = new Date();
      const monthKey = now.toISOString().slice(0, 7);
      const monthStartMs = new Date(monthKey + '-01T00:00:00.000Z').getTime();
      const nextMonth = new Date(monthKey + '-01T00:00:00.000Z');
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
      const monthEndMs = nextMonth.getTime();

      const netSalesData = readJsonFile(NET_SALES_FILE, {});
      const netSales = (netSalesData[monthKey] && netSalesData[monthKey].netSales) || 0;

      const all = readJsonFile(WR_FILE, []);
      const myReports = all.filter(r =>
        (r.submittedBy || '').toLowerCase() === email &&
        r.submittedAt >= monthStartMs &&
        r.submittedAt < monthEndMs
      );

      const reportType = REPORT_TYPES[email] || 'brand_manager';
      const kpis = {};
      if (reportType === 'community_manager') {
        kpis.calls   = myReports.reduce((s, r) => s + (Number(r.calls)   || 0), 0);
        kpis.videos  = myReports.reduce((s, r) => s + (Number(r.videos)  || 0), 0);
        kpis.signups = myReports.reduce((s, r) => s + (Number(r.signups) || 0), 0);
      } else if (reportType === 'video_editor') {
        kpis.videos = myReports.reduce((s, r) => s + (Number(r.videosEdited) || 0), 0);
      } else if (reportType === 'brand_manager') {
        // Accumulate videos and samples per brand across all reports this month
        const brandTotals = {};
        for (const r of myReports) {
          if (!r.brand) continue;
          if (!brandTotals[r.brand]) brandTotals[r.brand] = { videos: 0, samples: 0 };
          brandTotals[r.brand].videos  += Number(r.videosPosted) || 0;
          brandTotals[r.brand].samples += Number(r.samplesCount) || 0;
        }
        // Per-brand ratio (skip brands with 0 samples), then average
        const brandRatios = Object.values(brandTotals)
          .filter(b => b.samples > 0)
          .map(b => b.videos / b.samples);
        kpis.ratio = brandRatios.length > 0
          ? brandRatios.reduce((s, v) => s + v, 0) / brandRatios.length
          : 0;

        // Net sales from Gourab's Seller Center entries: sum latest per brand
        const latestByBrand = {};
        for (const r of myReports) {
          if (!r.brand) continue;
          if (!latestByBrand[r.brand] || r.submittedAt > latestByBrand[r.brand].submittedAt) {
            latestByBrand[r.brand] = r;
          }
        }
        kpis.sellerNetSales = Object.values(latestByBrand)
          .reduce((s, r) => s + (Number(r.sellerNetSales) || 0), 0);
      }

      // For brand_manager: use their own Seller Center entries as net sales if available
      const effectiveNetSales = (reportType === 'brand_manager' && kpis.sellerNetSales > 0)
        ? kpis.sellerNetSales
        : netSales;

      const { bonusPct, gateDetails } = computeCompTierSrv(model, kpis);
      const bonusDollars = effectiveNetSales * bonusPct;

      res.json({
        hasComp: true, monthKey, netSales: effectiveNetSales, base: model.base,
        bonusPct, bonusDollars, floorPct: model.floorPct, hitPct: model.hitPct,
        kpis, gateDetails,
        ratioTiers: model.ratioTiers || null,
        isEstimated: true,
        isAdmin: isAdminCaller,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: POST /api/admin/comp/net-sales ----------
  app.post('/api/admin/comp/net-sales', requireAuth, jsonBody, async (req, res) => {
    try {
      const email = (req.userEmail || '').toLowerCase();
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(email);
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      const { netSales } = req.body || {};
      if (typeof netSales !== 'number' || netSales < 0) return res.status(400).json({ error: 'Invalid netSales' });
      const now = new Date();
      const monthKey = now.toISOString().slice(0, 7);
      const data = readJsonFile(NET_SALES_FILE, {});
      data[monthKey] = { netSales, updatedAt: Date.now(), updatedBy: email };
      writeJsonFile(NET_SALES_FILE, data);
      res.json({ ok: true, monthKey, netSales });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: GET /api/admin/comp/net-sales ----------
  app.get('/api/admin/comp/net-sales', requireAuth, async (req, res) => {
    try {
      const email = (req.userEmail || '').toLowerCase();
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(email);
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      const data = readJsonFile(NET_SALES_FILE, {});
      res.json({ data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: GET /api/admin/comp/team-summary ----------
  // Returns team-wide payroll summary: current bonus per person, max possible,
  // % of net sales committed, and what Cult Content keeps.
  const COMP_NAMES = {
    'gourab@cultcontent.cc': 'Gourab',
    'gilbert@cultcontent.cc': 'Gilbert',
    'gina@cultcontent.cc': 'Jina',
    'becca@cultcontent.cc': 'Becca',
    'jenna@cultcontent.cc': 'Jenna',
  };
  app.get('/api/admin/comp/team-summary', requireAuth, async (req, res) => {
    try {
      const callerEmail = (req.userEmail || '').toLowerCase();
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(callerEmail);
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });

      const now = new Date();
      const monthKey = now.toISOString().slice(0, 7);
      const monthStartMs = new Date(monthKey + '-01T00:00:00.000Z').getTime();
      const nextMonth = new Date(monthKey + '-01T00:00:00.000Z');
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
      const monthEndMs = nextMonth.getTime();

      const netSalesData = readJsonFile(NET_SALES_FILE, {});
      const netSales = (netSalesData[monthKey] && netSalesData[monthKey].netSales) || 0;
      const netSalesSource = (netSalesData[monthKey] && netSalesData[monthKey].source) || null;
      const all = readJsonFile(WR_FILE, []);

      const members = [];
      let totalCurrentBonus = 0, totalMaxBonus = 0;

      for (const [email, model] of Object.entries(COMP_MODEL)) {
        const reportType = REPORT_TYPES[email] || 'brand_manager';
        const myReports = all.filter(r =>
          (r.submittedBy || '').toLowerCase() === email &&
          r.submittedAt >= monthStartMs && r.submittedAt < monthEndMs
        );
        const kpis = {};
        if (reportType === 'community_manager') {
          kpis.calls   = myReports.reduce((s, r) => s + (Number(r.calls)   || 0), 0);
          kpis.videos  = myReports.reduce((s, r) => s + (Number(r.videos)  || 0), 0);
          kpis.signups = myReports.reduce((s, r) => s + (Number(r.signups) || 0), 0);
        } else if (reportType === 'video_editor') {
          kpis.videos = myReports.reduce((s, r) => s + (Number(r.videosEdited) || 0), 0);
        } else if (reportType === 'brand_manager') {
          const vids = myReports.reduce((s, r) => s + (Number(r.videosPosted) || 0), 0);
          const samps = myReports.reduce((s, r) => s + (Number(r.samplesCount) || 0), 0);
          kpis.ratio = samps > 0 ? vids / samps : 0;
        }
        const { bonusPct, gateDetails } = computeCompTierSrv(model, kpis);
        const bonusDollars = Math.round(netSales * bonusPct);
        const maxDollars = Math.round(netSales * model.hitPct);
        totalCurrentBonus += bonusDollars;
        totalMaxBonus += maxDollars;
        members.push({
          email, name: COMP_NAMES[email] || email.split('@')[0],
          base: model.base, bonusPct, bonusDollars, maxPct: model.hitPct, maxDollars,
          gateDetails, reportType, hasReports: myReports.length > 0,
        });
      }

      const totalMaxPct = Object.values(COMP_MODEL).reduce((s, m) => s + m.hitPct, 0);
      const totalCurrentPct = netSales > 0 ? totalCurrentBonus / netSales : 0;
      const cultContentShare = Math.round(netSales - totalCurrentBonus);

      res.json({
        monthKey, netSales, netSalesSource,
        members, totalCurrentBonus, totalCurrentPct,
        totalMaxBonus, totalMaxPct,
        cultContentShare,
        membersOnKpi: members.length,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: GET /api/admin/comp/net-sales-auto ----------
  // Auto-calculates current month net sales from Stripe (calendar month charges)
  // or falls back to summing retainerBudget from this month's brand_manager reports.
  app.get('/api/admin/comp/net-sales-auto', requireAuth, async (req, res) => {
    try {
      const callerEmail = (req.userEmail || '').toLowerCase();
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(callerEmail);
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });

      const now = new Date();
      const monthKey = now.toISOString().slice(0, 7);
      const monthStartSec = Math.floor(new Date(monthKey + '-01T00:00:00.000Z').getTime() / 1000);

      let netSales = 0;
      let source = 'weekly_reports';

      // 1. Sum sellerNetSales from brand_manager weekly reports (latest entry per brand this month)
      const monthStartMs = monthStartSec * 1000;
      const all = readJsonFile(WR_FILE, []);
      const thisMonth = all.filter(r => r.submittedAt >= monthStartMs && r.reportType === 'brand_manager');
      const latestPerBrand = {};
      for (const r of thisMonth) {
        if (!r.brand) continue;
        if (!latestPerBrand[r.brand] || r.submittedAt > latestPerBrand[r.brand].submittedAt) {
          latestPerBrand[r.brand] = r;
        }
      }
      const sellerTotal = Math.round(Object.values(latestPerBrand).reduce((s, r) => s + (Number(r.sellerNetSales) || 0), 0));
      if (sellerTotal > 0) {
        netSales = sellerTotal;
        source = 'weekly_reports';
      }

      // 2. Fall back to retainerBudget if no sellerNetSales entered yet
      if (netSales === 0) {
        netSales = Math.round(Object.values(latestPerBrand).reduce((s, r) => s + (Number(r.retainerBudget) || 0), 0));
      }

      // Persist the auto-calculated value (only if not already manually overridden today)
      if (netSales > 0) {
        const data = readJsonFile(NET_SALES_FILE, {});
        const existing = data[monthKey];
        if (!existing || existing.updatedBy === 'auto') {
          data[monthKey] = { netSales, updatedAt: Date.now(), updatedBy: 'auto', source };
          writeJsonFile(NET_SALES_FILE, data);
        }
      }

      res.json({ ok: true, monthKey, netSales, source });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
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
  // Real, already-maintained staff-to-brand knowledge (see the "Trip Visuals
  // and Made Right" commit for evidence this list is actively kept current) —
  // exposed the same way _helpers already is, so db/seed-team.js can seed
  // brand_assignments from the single source of truth instead of duplicating
  // this list somewhere that could drift out of sync with it.
  registerOpsMyTasks.BRAND_MANAGERS = BRAND_MANAGERS;

  return app;
};
