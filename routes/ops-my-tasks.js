// Claude Code queue verified and working.
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
  // 'jina@cultcontent.cc': 'ou_TBD',  // no Lark account yet — Tommy must provision first
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
  'jina@cultcontent.cc': 'community_manager',
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
  'jina@cultcontent.cc': { base: 2750, floorPct: 0.04, hitPct: 0.08, gates: [
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
    { key: 'ratio',   label: 'Video/Sample Ratio', floor: 2, hit: 4 },
  ], ratioTiers: [2, 3, 4] },
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
<title>Command Center · Cult Content</title>
<script>window.__VQ_IS_EDITOR__=false;window.__VQ_IS_ADMIN__=false;window.__USER_ROLE__="";window.__USER_MODULES__=[];</script>
<style>
  :root{--bg:#161823;--panel:#1e2030;--panel2:#252838;--border:#2f3346;--txt:#e8eaf2;--muted:#9aa0b5;--cyan:#00f2ea;--red:#ff0050;--p1:#ff0050;--p2:#ff9f0a;--p3:#ffd60a;--p4:#5a6072;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1400px;margin:0 auto;padding:28px 40px 80px}
  @media(max-width:900px){.wrap{padding:20px 20px 80px}}
  @media(max-width:540px){.wrap{padding:16px 14px 80px}}
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
  @keyframes tiktok-glow{0%{box-shadow:0 0 10px 3px rgba(254,44,85,.7),0 0 22px 6px rgba(37,244,238,.3);border-color:rgba(254,44,85,.8);}50%{box-shadow:0 0 14px 5px rgba(37,244,238,.7),0 0 28px 8px rgba(254,44,85,.3);border-color:rgba(37,244,238,.8);}100%{box-shadow:0 0 10px 3px rgba(254,44,85,.7),0 0 22px 6px rgba(37,244,238,.3);border-color:rgba(254,44,85,.8);}}
  .card.matchmaking-glow{animation:tiktok-glow 2.2s ease-in-out infinite;border-width:1.5px;}
  .tiktok-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:20px;background:linear-gradient(90deg,rgba(254,44,85,.2),rgba(37,244,238,.2));border:1px solid rgba(254,44,85,.4);color:#fe2c55;margin-left:4px;vertical-align:middle;}
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
  /* ── Team Management ─────────────────────────────────── */
  .tm-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}
  @media(max-width:900px){.tm-grid{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:540px){.tm-grid{grid-template-columns:1fr}}
  .tm-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px;cursor:pointer;transition:.15s}
  .tm-card:hover{border-color:rgba(0,242,234,.4);transform:translateY(-1px)}
  .tm-card-top{display:flex;align-items:center;gap:12px;margin-bottom:14px}
  .tm-avatar{width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;flex-shrink:0;background:linear-gradient(135deg,var(--purple),var(--cyan));color:#fff}
  .tm-name{font-size:15px;font-weight:700}
  .tm-role{font-size:11px;color:var(--muted);margin-top:1px}
  .tm-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .tm-stat{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:8px 10px;text-align:center}
  .tm-stat .n{font-size:16px;font-weight:800;letter-spacing:-.02em}
  .tm-stat .l{font-size:9px;color:var(--muted);margin-top:1px;text-transform:uppercase;letter-spacing:.05em}
  .tm-kpi-row{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:11px}
  .tm-kpi-bar-bg{flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden}
  .tm-kpi-bar-fill{height:100%;border-radius:2px;background:linear-gradient(90deg,var(--cyan),rgba(0,242,234,.4));transition:width .5s}
  /* Modal */
  .tm-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:999;padding:16px}
  .tm-modal{background:var(--bg);border:1px solid var(--border);border-radius:18px;width:100%;max-width:580px;max-height:90vh;overflow-y:auto;padding:24px}
  .tm-modal-hdr{display:flex;align-items:center;gap:14px;margin-bottom:20px}
  .tm-modal-avatar{width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800;background:linear-gradient(135deg,var(--purple),var(--cyan));color:#fff;flex-shrink:0}
  .tm-section{margin-top:18px;padding-top:16px;border-top:1px solid rgba(255,255,255,.07)}
  .tm-section-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:10px}
  .tm-call-item{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:6px}
  .tm-call-title{font-size:12px;font-weight:600;margin-bottom:2px}
  .tm-call-meta{font-size:10px;color:var(--muted)}
  .tm-ai-overview{font-size:12px;line-height:1.7;color:rgba(255,255,255,.8);white-space:pre-wrap;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px;min-height:60px}
  .tm-notes-ta{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:10px 12px;color:var(--txt);font-size:12px;font-family:inherit;resize:vertical;min-height:80px}
  .tm-contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .tm-contact-item{font-size:12px;color:var(--muted)}.tm-contact-item strong{color:var(--txt);display:block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px}
  /* ── Video Queue ──────────────────────────────────────── */
  .vq-submit{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:20px;margin:0 auto 22px;max-width:640px}
  .vq-submit h3{margin:0 0 14px;font-size:15px;font-weight:700}
  .vq-cols{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  @media(max-width:720px){.vq-cols{grid-template-columns:1fr}}
  .vq-col-hdr{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);padding-bottom:8px;border-bottom:1px solid var(--border);margin-bottom:10px;display:flex;align-items:center;justify-content:space-between}
  .vq-col-count{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:0 7px;font-size:10px;font-weight:700}
  .vq-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px;transition:.15s}
  .vq-card:hover{border-color:rgba(0,242,234,.35)}
  .vq-card-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px;gap:8px}
  .vq-brand-chip{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;background:rgba(0,242,234,.12);color:var(--cyan);border-radius:5px;padding:2px 7px;white-space:nowrap}
  .vq-prio-chip{font-size:10px;font-weight:700;border-radius:5px;padding:2px 7px;white-space:nowrap}
  .vq-prio-high{background:rgba(255,59,48,.15);color:var(--red)}
  .vq-prio-normal{background:rgba(0,242,234,.1);color:var(--cyan)}
  .vq-prio-low{background:rgba(154,160,181,.12);color:var(--muted)}
  .vq-title{font-size:13px;font-weight:600;margin-bottom:4px}
  .vq-desc{font-size:12px;color:var(--muted);line-height:1.4;margin-bottom:8px}
  .vq-meta{font-size:11px;color:var(--muted);margin-bottom:10px}
  .vq-meta strong{color:var(--txt)}
  .vq-actions{display:flex;gap:7px;flex-wrap:wrap}
  .vq-btn{font-size:11px;font-weight:600;padding:4px 10px;border-radius:6px;cursor:pointer;border:1px solid var(--border);background:none;color:var(--muted);font-family:inherit;transition:.1s}
  .vq-btn:hover{border-color:var(--cyan);color:var(--cyan)}
  .vq-btn.vq-primary{background:var(--cyan);color:#000;border-color:var(--cyan)}
  .vq-btn.vq-done{background:rgba(107,232,107,.15);color:#6be86b;border-color:rgba(107,232,107,.3)}
  .vq-btn.vq-drive{background:rgba(0,242,234,.1);color:var(--cyan);border-color:rgba(0,242,234,.3)}
  .vq-empty{color:var(--muted);font-size:12px;padding:20px 0;text-align:center}
  /* Gilbert tools panel (legacy, kept for video tab) */
  .vq-tools-panel{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px 20px;margin-bottom:18px}
  .vq-tools-hdr{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:12px}
  .vq-tool-links{display:flex;flex-wrap:wrap;gap:8px}
  .vq-tool-link{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border:1px solid var(--border);border-radius:8px;font-size:12px;font-weight:600;color:var(--txt);text-decoration:none;background:var(--panel2);transition:.15s}
  .vq-tool-link:hover{border-color:var(--cyan);color:var(--cyan)}
  /* More Tools tab */
  .mt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;padding:4px 0}
  .mt-card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px 14px;display:flex;flex-direction:column;align-items:center;gap:8px;text-decoration:none;color:inherit;transition:.15s;cursor:pointer;position:relative;text-align:center}
  .mt-card:hover{border-color:var(--cyan);background:rgba(0,242,234,.06)}
  .mt-card-emoji{font-size:28px;line-height:1}
  .mt-card-name{font-size:13px;font-weight:700;color:#fff;word-break:break-word}
  .mt-card-add{border:1px dashed var(--border);color:var(--muted);background:none}
  .mt-card-add:hover{border-color:var(--cyan);color:var(--cyan);background:rgba(0,242,234,.04)}
  .mt-dots{position:absolute;top:6px;right:8px;background:none;border:none;color:var(--muted);font-size:16px;cursor:pointer;line-height:1;padding:2px 5px;opacity:0;transition:.1s;border-radius:6px}
  .mt-card:hover .mt-dots{opacity:1}
  .mt-dots:hover{background:rgba(255,255,255,.1);color:#fff}
  .mt-menu{position:absolute;top:28px;right:6px;background:var(--panel2);border:1px solid var(--border);border-radius:8px;z-index:50;min-width:100px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.4)}
  .mt-menu-item{display:block;width:100%;padding:9px 14px;font-size:12px;font-weight:600;cursor:pointer;background:none;border:none;color:var(--txt);text-align:left;font-family:inherit;transition:.1s}
  .mt-menu-item:hover{background:rgba(0,242,234,.1);color:var(--cyan)}
  .mt-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:1000;display:flex;align-items:center;justify-content:center}
  .mt-modal{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:24px;width:100%;max-width:380px}
  .mt-modal h3{margin:0 0 18px;font-size:16px;font-weight:800}
  .mt-modal label{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:5px}
  .mt-modal input{width:100%;box-sizing:border-box;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:#fff;font-size:13px;font-family:inherit;margin-bottom:14px}
  .mt-modal-btns{display:flex;gap:8px;margin-top:4px}
  /* Gilbert list view */
  .vq-list-hdr{display:grid;grid-template-columns:10px 110px 1fr 80px 80px 80px;gap:12px;align-items:center;padding:0 16px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);border-bottom:1px solid var(--border);margin-bottom:8px}
  .vq-row{border:1px solid var(--border);border-radius:10px;margin-bottom:7px;overflow:hidden;transition:.15s}
  .vq-row:hover{border-color:rgba(0,242,234,.4)}
  .vq-row-summary{display:grid;grid-template-columns:10px 110px 1fr 80px 80px 80px;gap:12px;align-items:center;padding:11px 16px;cursor:pointer;min-height:44px}
  .vq-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .vq-dot-pending{background:var(--muted)}
  .vq-dot-inprogress{background:var(--cyan)}
  .vq-dot-done{background:#6be86b}
  .vq-row-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .vq-row-sub{font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .vq-row-member{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .vq-row-due{font-size:11px;color:var(--muted);white-space:nowrap}
  .vq-row-detail{border-top:1px solid var(--border);padding:14px 16px;display:none;background:var(--panel)}
  .vq-row.expanded .vq-row-detail{display:block}
  .vq-chevron{color:var(--muted);font-size:11px;margin-left:auto;flex-shrink:0}
  @media(max-width:700px){.vq-list-hdr,.vq-row-summary{grid-template-columns:10px 90px 1fr 70px}.vq-row-summary>:nth-child(5),.vq-row-summary>:nth-child(6),.vq-list-hdr>:nth-child(5),.vq-list-hdr>:nth-child(6){display:none}}
  /* 1000-video tracker */
  .vp-tracker{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:20px 22px;margin-bottom:20px}
  .vp-tracker-header{text-align:center;margin-bottom:16px}
  .vp-tracker-title{font-size:32px;font-weight:900;letter-spacing:-.03em;background:linear-gradient(90deg,#00f2ea,#f59e0b,#ff0050,#3b82f6,#a78bfa);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;display:inline-block}
  .vp-tracker-bar-wrap{height:10px;background:rgba(255,255,255,.07);border-radius:6px;overflow:hidden;margin-bottom:14px;display:flex}
  .vp-bar-seg{height:100%;transition:width .4s ease;min-width:0}
  .vp-bar-submitted{background:#00f2ea}
  .vp-bar-editing{background:#f59e0b}
  .vp-bar-review{background:#ff0050}
  .vp-bar-scheduled{background:#3b82f6}
  .vp-bar-posted{background:#a78bfa}
  .vp-tracker-legend{display:flex;gap:14px;flex-wrap:wrap}
  .vp-legend-item{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);font-weight:600}
  .vp-legend-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  /* approval + posted status */
  .vq-dot-review{background:#f59e0b}
  .vq-dot-posted{background:#a78bfa}
  .vq-btn.vq-approve{background:rgba(245,158,11,.15);color:#f59e0b;border-color:rgba(245,158,11,.3)}
  .vq-btn.vq-post{background:rgba(167,139,250,.15);color:#a78bfa;border-color:rgba(167,139,250,.3)}
  .vq-btn.vq-primary{background:var(--cyan);color:#000;border-color:var(--cyan);font-weight:800;font-size:12px}
  .vq-btn.vq-schedule{background:rgba(245,158,11,.15);color:#f59e0b;border-color:rgba(245,158,11,.3)}
  .vq-btn.vq-mark-posted{background:rgba(167,139,250,.15);color:#a78bfa;border-color:rgba(167,139,250,.3)}
  .vq-dot-scheduled{background:#f59e0b}
  .vq-cols-5{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
  @media(max-width:1100px){.vq-cols-5{grid-template-columns:repeat(3,1fr)}}
  @media(max-width:700px){
    .vq-cols-5{
      display:flex;flex-direction:row;flex-wrap:nowrap;
      gap:10px;overflow-x:auto;align-items:flex-start;
      padding-bottom:12px;
      -webkit-overflow-scrolling:touch;
      scrollbar-width:none;
    }
    .vq-cols-5::-webkit-scrollbar{display:none}
    .vq-cols-5>div{flex:0 0 72vw;min-width:220px;max-width:320px}
  }
  .vq-inline-form{margin-top:10px;padding:10px;background:var(--panel2);border:1px solid var(--border);border-radius:8px;display:flex;flex-direction:column;gap:8px}
  .vq-inline-form textarea,.vq-inline-form input[type=url],.vq-inline-form input[type=datetime-local]{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:7px 10px;color:var(--txt);font-size:12px;font-family:inherit;resize:vertical}
  .vq-inline-form .plat-row{display:flex;flex-wrap:wrap;gap:6px}
  .vq-plat-chip{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border:1px solid var(--border);border-radius:20px;font-size:11px;cursor:pointer;background:none;color:var(--muted);font-family:inherit;transition:.1s}
  .vq-plat-chip.on{border-color:var(--cyan);color:var(--cyan);background:rgba(0,242,234,.08)}
  .vq-posted-links{margin-top:8px;display:flex;flex-direction:column;gap:4px}
  .vq-posted-link{display:flex;align-items:center;gap:6px;font-size:11px}
  .vq-posted-link a{color:var(--cyan);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px}
  /* analytics panel */
  .vp-analytics{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px 20px;margin-bottom:20px}
  .vp-analytics-title{font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:14px}
  .vp-analytics-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  @media(max-width:700px){.vp-analytics-grid{grid-template-columns:repeat(2,1fr)}}
  .vp-metric{background:var(--panel2);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
  .vp-metric-val{font-size:20px;font-weight:800;color:var(--txt)}
  .vp-metric-lbl{font-size:10px;color:var(--muted);margin-top:3px;font-weight:600}
  /* section tabs (Videos / Podcast) */
  .vp-section-tabs{display:flex;gap:6px;margin-bottom:18px}
  .vp-stab{font-size:12px;font-weight:700;padding:6px 16px;border-radius:8px;cursor:pointer;border:1px solid var(--border);background:none;color:var(--muted);font-family:inherit;transition:.1s;display:flex;align-items:center;gap:6px}
  .vp-stab.active{background:var(--cyan);color:#000;border-color:var(--cyan)}
  .vp-stab-badge{background:var(--red);color:#fff;border-radius:8px;font-size:10px;padding:1px 6px;font-weight:800}
  /* podcast cards */
  .vp-pod-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:10px;transition:.15s}
  .vp-pod-card:hover{border-color:rgba(0,242,234,.3)}
  .vp-pod-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
  .vp-pod-name{font-size:14px;font-weight:700}
  .vp-pod-handle{font-size:11px;color:var(--muted);margin-top:2px}
  .vp-pod-status{font-size:10px;font-weight:700;border-radius:5px;padding:2px 8px;white-space:nowrap}
  .vp-pod-status-pending{background:rgba(154,160,181,.15);color:var(--muted)}
  .vp-pod-status-approved{background:rgba(0,242,234,.12);color:var(--cyan)}
  .vp-pod-status-scheduled{background:rgba(245,158,11,.15);color:#f59e0b}
  .vp-pod-status-recorded{background:rgba(107,232,107,.12);color:#6be86b}
  .vp-pod-status-rejected{background:rgba(255,59,48,.12);color:var(--red)}
  .vp-pod-status-processing{background:rgba(0,242,234,.08);color:var(--cyan);animation:vpPulse 1.8s infinite}
  .vp-pod-status-processed{background:rgba(107,232,107,.12);color:#6be86b}
  @keyframes vpPulse{0%,100%{opacity:1}50%{opacity:.5}}
  .vp-pod-body{font-size:12px;color:var(--muted);line-height:1.5;margin-bottom:10px}
  .vp-pod-meta{font-size:11px;color:var(--muted);margin-bottom:10px}
  /* footage upload */
  .vq-footage-tabs{display:flex;gap:6px;margin-bottom:8px}
  .vq-ftab{font-size:11px;font-weight:700;padding:4px 12px;border-radius:6px;cursor:pointer;border:1px solid var(--border);background:none;color:var(--muted);font-family:inherit;transition:.1s}
  .vq-ftab.active{background:rgba(0,242,234,.15);color:var(--cyan);border-color:var(--cyan)}
  .vq-drop-zone{border:2px dashed var(--border);border-radius:10px;padding:24px 16px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s;min-height:90px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;font-size:13px;user-select:none;-webkit-user-select:none}
  label.vq-drop-zone{display:flex}
  .vq-drop-zone:hover,.vq-drop-zone.drag,.vq-drop-zone:active{border-color:var(--cyan);background:rgba(0,242,234,.05)}
  /* buffer modal */
  .vq-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9000;display:flex;align-items:center;justify-content:center}
  .vq-modal{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:24px;width:min(420px,92vw);max-height:85vh;overflow-y:auto}
  .vq-modal h3{margin:0 0 16px;font-size:16px;font-weight:700}
  .vq-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div><h1>Command Center</h1></div>
    <div style="display:flex;gap:8px;align-items:center">
      <a class="chip sisy" href="https://sisyphus.cultcontent.cc" target="_blank" rel="noopener">🪨 Sisyphus</a>
      <button class="chip" id="hdr-team-chip" onclick="switchTab(4)" style="display:none">⚙ Team</button>
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
    <button class="tab" onclick="switchTab(2)">Software</button>
    <button class="tab" id="vq-tab-btn" onclick="switchTab(3)">Video Production</button>
    <button class="tab" id="tm-tab-btn" onclick="switchTab(4)" style="display:none">Team Management</button>
    <button class="tab" onclick="switchTab(5)">More Tools</button>
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

<!-- Video Queue tab -->
<div id="tab-video-queue" style="display:none">

  <!-- Gilbert tools panel (video_editor only) -->
  <div id="vq-tools-panel" style="display:none" class="vq-tools-panel">
    <div class="vq-tools-hdr">Your Tools</div>
    <div class="vq-tool-links">
      <a href="https://www.capcut.com" target="_blank" class="vq-tool-link">🎬 CapCut</a>
      <a href="https://seedance.ai" target="_blank" class="vq-tool-link">✨ Seedance AI</a>
      <a href="https://www.tiktok.com/studio" target="_blank" class="vq-tool-link">📱 TikTok Studio</a>
      <a href="https://publish.buffer.com" target="_blank" class="vq-tool-link">📅 Buffer</a>
      <a href="https://drive.google.com" target="_blank" class="vq-tool-link">📁 Google Drive</a>
      <a href="https://manifest.cultcontent.cc" target="_blank" class="vq-tool-link">🖥 Content Pipeline →</a>
    </div>
  </div>

  <!-- 1000-video progress tracker -->
  <div class="vp-tracker" id="vp-tracker">
    <div class="vp-tracker-header">
      <div class="vp-tracker-title">1,000 Video Challenge</div>
    </div>
    <div class="vp-tracker-bar-wrap">
      <div class="vp-bar-seg vp-bar-submitted" id="vp-bar-submitted" style="width:0%"></div>
      <div class="vp-bar-seg vp-bar-editing" id="vp-bar-editing" style="width:0%"></div>
      <div class="vp-bar-seg vp-bar-review" id="vp-bar-review" style="width:0%"></div>
      <div class="vp-bar-seg vp-bar-scheduled" id="vp-bar-scheduled" style="width:0%"></div>
      <div class="vp-bar-seg vp-bar-posted" id="vp-bar-posted" style="width:0%"></div>
    </div>
    <div class="vp-tracker-legend" style="justify-content:center">
      <div class="vp-legend-item"><div class="vp-legend-dot" style="background:#00f2ea"></div><span id="vp-cnt-submitted">0</span> Submitted</div>
      <div class="vp-legend-item"><div class="vp-legend-dot" style="background:#f59e0b"></div><span id="vp-cnt-editing">0</span> Editing</div>
      <div class="vp-legend-item"><div class="vp-legend-dot" style="background:#ff0050"></div><span id="vp-cnt-review">0</span> For Review</div>
      <div class="vp-legend-item"><div class="vp-legend-dot" style="background:#3b82f6"></div><span id="vp-cnt-scheduled-tracker">0</span> Scheduled</div>
      <div class="vp-legend-item"><div class="vp-legend-dot" style="background:#a78bfa"></div><span id="vp-cnt-posted">0</span> Posted</div>
    </div>
    <div style="display:flex;justify-content:center;gap:32px;margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,.06)">
      <div style="text-align:center">
        <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-.02em" id="vp-stat-views">0</div>
        <div style="font-size:10px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.07em;margin-top:2px">Total Views</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-.02em" id="vp-stat-posts">0</div>
        <div style="font-size:10px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.07em;margin-top:2px">Total Posts</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-.02em" id="vp-stat-pct">0%</div>
        <div style="font-size:10px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.07em;margin-top:2px">To Goal</div>
      </div>
    </div>
  </div>

  <!-- Section tabs: Videos | Podcast -->
  <div class="vp-section-tabs" id="vp-section-tabs">
    <button class="vp-stab active" id="vp-stab-videos" onclick="vpSwitchSection('videos')">Videos</button>
    <button class="vp-stab" id="vp-stab-podcast" onclick="vpSwitchSection('podcast')">Podcast Management <span class="vp-stab-badge" id="vp-podcast-badge" style="display:none">0</span></button>
  </div>

  <!-- VIDEOS SECTION -->
  <div id="vp-section-videos">
  <div class="vq-submit" id="vq-submit-form" style="display:none">
    <h3 style="margin-bottom:14px">Submit New Footage</h3>
    <div class="fr full"><div class="fg">
      <label>How many videos in this batch?</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px" id="vq-qty-row">
        ${[1,2,3,4,5,6,7,8,9,10].map(n=>`<button type="button" class="vq-plat-chip${n===1?' on':''}" onclick="vqPickQty(${n})" id="vqqty-${n}">${n}</button>`).join('')}
      </div>
      <input type="hidden" id="vq-qty" value="1"/>
      <label>Footage</label>
      <div class="vq-footage-tabs">
        <button type="button" class="vq-ftab active" id="vq-ftab-link" onclick="vqFootageTab('link')">Paste Drive Link</button>
        <button type="button" class="vq-ftab" id="vq-ftab-upload" onclick="vqFootageTab('upload')">Upload File <span style="font-size:10px;opacity:.6">&lt;100MB</span></button>
      </div>
      <div id="vq-footage-link">
        <input type="url" id="vq-drive" placeholder="https://drive.google.com/…"/>
      </div>
      <div id="vq-footage-upload" style="display:none">
        <div id="vq-file-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px"></div>
        <label for="vq-file-input" class="vq-drop-zone" id="vq-drop-zone" style="display:flex;cursor:pointer;padding:16px" ondragover="event.preventDefault();this.classList.add('drag')" ondragleave="this.classList.remove('drag')" ondrop="vqHandleDrop(event)">
          <span style="font-size:20px">＋</span>
          <span style="font-weight:700;margin-left:8px" id="vq-add-label">Add a clip</span>
        </label>
        <input type="file" id="vq-file-input" accept="video/*" style="display:none" onchange="vqHandleFiles(this.files)"/>
        <p style="font-size:11px;color:var(--muted);margin-top:6px;text-align:center">Tap to add one clip at a time. After picking, swipe down to close Photos — clips upload in parallel, submit once.</p>
      </div>
    </div></div>
    <div class="fr full"><div class="fg"><label>Notes <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
      <textarea id="vq-desc" style="min-height:55px" placeholder="Any direction for the editor — hook ideas, vibe, must-include moments…"></textarea>
    </div></div>
    <div class="fr full"><div class="fg" style="margin-top:4px">
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none">
        <input type="checkbox" id="vq-shoppable" style="accent-color:var(--cyan);width:16px;height:16px;flex-shrink:0"/>
        <span style="font-size:13px;font-weight:600">Is this video shoppable? <span style="font-size:11px;font-weight:400;color:var(--muted)">(TikTok Shop affiliate — posts manually in-app)</span></span>
      </label>
    </div></div>
    <div id="vq-status-banner" style="display:none;margin-top:10px;padding:10px 14px;border-radius:8px;font-size:13px;line-height:1.5;word-break:break-word"></div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px">
      <button class="btn" onclick="submitVideoRequest()">Submit</button>
    </div>
  </div>

  <div class="vq-cols-5" id="vq-queue-wrap">
    <div>
      <div class="vq-col-hdr" style="color:#00f2ea">Submitted <span class="vq-col-count" id="vq-cnt-pending">0</span></div>
      <div id="vq-col-pending"></div>
    </div>
    <div>
      <div class="vq-col-hdr" style="color:#f59e0b">Editing <span class="vq-col-count" id="vq-cnt-inprogress">0</span></div>
      <div id="vq-col-inprogress"></div>
    </div>
    <div>
      <div class="vq-col-hdr" style="color:#ff0050">For Review <span class="vq-col-count" id="vq-cnt-done">0</span></div>
      <div id="vq-col-done"></div>
    </div>
    <div>
      <div class="vq-col-hdr" style="color:#3b82f6">Scheduled <span class="vq-col-count" id="vq-cnt-scheduled">0</span></div>
      <div id="vq-col-scheduled"></div>
    </div>
    <div>
      <div class="vq-col-hdr" style="color:#a78bfa;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span>Posted <span class="vq-col-count" id="vq-cnt-posted">0</span></span>
        <span style="margin-left:auto;display:flex;gap:4px">
          <button id="vq-sort-views" onclick="vqSetSort('views')" style="font-size:10px;padding:2px 7px;background:rgba(167,139,250,.15);border:1px solid rgba(167,139,250,.3);border-radius:4px;color:#a78bfa;cursor:pointer">👁 Views</button>
          <button id="vq-sort-date" onclick="vqSetSort('date')" style="font-size:10px;padding:2px 7px;background:none;border:1px solid rgba(255,255,255,.1);border-radius:4px;color:var(--muted);cursor:pointer">📅 Date</button>
        </span>
      </div>
      <div id="vq-col-posted"></div>
    </div>
  </div>

  <!-- Buffer posting modal -->
  <div id="vq-buffer-modal" class="vq-modal-overlay" style="display:none" onclick="if(event.target===this)vqCloseBufferModal()">
    <div class="vq-modal">
      <h3>Post to Buffer</h3>
      <div class="fg" style="margin-bottom:12px"><label>Caption</label>
        <textarea id="vq-buf-caption" style="min-height:80px" placeholder="Write your caption…"></textarea>
      </div>
      <div class="fg" style="margin-bottom:12px"><label>Schedule (optional — blank = add to queue)</label>
        <input type="datetime-local" id="vq-buf-schedule"/>
      </div>
      <div id="vq-buf-err" class="err" style="display:none;margin-bottom:8px"></div>
      <div class="vq-modal-actions">
        <button class="btn" onclick="vqCloseBufferModal()" style="background:none">Cancel</button>
        <button class="btn" onclick="vqSubmitBuffer()">Send to Buffer</button>
      </div>
    </div>
  </div>

  <!-- Gilbert list view (video_editor only) -->
  <div id="vq-list-wrap" style="display:none">
    <div class="vq-list-hdr">
      <span></span>
      <span>From</span>
      <span>Request</span>
      <span>Priority</span>
      <span>Due</span>
      <span>Status</span>
    </div>
    <div id="vq-list-rows"></div>
  </div>
  </div><!-- /vp-section-videos -->

  <!-- PODCAST SECTION -->
  <div id="vp-section-podcast" style="display:none">
    <div style="background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px 20px;margin-bottom:16px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px">
        <div style="font-size:18px;font-weight:800;letter-spacing:-.02em">Podcast Management</div>
        <div style="display:flex;align-items:center;gap:12px">
          <a href="https://cultcontent.cc/cult-commerce-podcast" target="_blank" style="color:var(--cyan);font-size:11px">cultcontent.cc/cult-commerce-podcast</a>
          <button class="vq-btn vq-approve" style="font-size:11px;padding:4px 10px" onclick="vpOpenAddGuest()">+ Add Guest</button>
        </div>
      </div>
      <div id="vp-podcast-tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">
        <button class="vq-ftab active" id="vp-ptab-pending" onclick="vpPodcastFilter('pending')">Pending <span class="vq-col-count" id="vp-ptab-cnt-pending" style="display:none">0</span></button>
        <button class="vq-ftab" id="vp-ptab-approved" onclick="vpPodcastFilter('approved')">Approved <span class="vq-col-count" id="vp-ptab-cnt-approved" style="display:none">0</span></button>
        <button class="vq-ftab" id="vp-ptab-scheduled" onclick="vpPodcastFilter('scheduled')">Scheduled <span class="vq-col-count" id="vp-ptab-cnt-scheduled" style="display:none">0</span></button>
        <button class="vq-ftab" id="vp-ptab-recorded" onclick="vpPodcastFilter('recorded')">Recorded <span class="vq-col-count" id="vp-ptab-cnt-recorded" style="display:none">0</span></button>
        <button class="vq-ftab" id="vp-ptab-all" onclick="vpPodcastFilter('all')">All <span class="vq-col-count" id="vp-ptab-cnt-all" style="display:none">0</span></button>
      </div>
      <div id="vp-podcast-list"><div class="vq-empty">Loading applications…</div></div>
    </div>
  </div>

  <!-- Podcast: Add Guest manually modal -->
  <div id="vp-addguest-modal" class="vq-modal-overlay" style="display:none" onclick="if(event.target===this)vpCloseAddGuest()">
    <div class="vq-modal">
      <h3>Add Guest Manually</h3>
      <div class="fg" style="margin-bottom:10px"><label>Name <span style="color:var(--red)">*</span></label><input type="text" id="vpag-name" placeholder="Full name"/></div>
      <div class="fg" style="margin-bottom:10px"><label>Email <span style="color:var(--red)">*</span></label><input type="email" id="vpag-email" placeholder="guest@email.com"/></div>
      <div class="fg" style="margin-bottom:10px"><label>Status</label>
        <select id="vpag-status" onchange="vpagToggleScheduleFields()">
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="scheduled">Scheduled</option>
        </select>
      </div>
      <div id="vpag-schedule-fields" style="display:none">
        <div class="fg" style="margin-bottom:10px"><label>Recording Date & Time</label><input type="datetime-local" id="vpag-dt"/></div>
        <div class="fg" style="margin-bottom:10px"><label>Riverside Room URL</label><input type="url" id="vpag-riverside" placeholder="https://riverside.fm/studio/…"/></div>
      </div>
      <div class="fg" style="margin-bottom:10px"><label>Topics / Notes <span style="font-weight:400;color:var(--muted)">(optional)</span></label><textarea id="vpag-notes" style="min-height:56px" placeholder="What they want to talk about, how they booked, etc."></textarea></div>
      <div id="vpag-note" style="font-size:11px;color:var(--muted);margin-bottom:10px;display:none">📧 Adding as Scheduled + Riverside URL will automatically send the guest the recording link.</div>
      <div id="vpag-err" class="err" style="display:none;margin-bottom:8px"></div>
      <div class="vq-modal-actions">
        <button class="btn" onclick="vpCloseAddGuest()" style="background:none">Cancel</button>
        <button class="btn" onclick="vpSubmitAddGuest()">Add Guest</button>
      </div>
    </div>
  </div>

  <!-- Podcast schedule modal -->
  <div id="vp-schedule-modal" class="vq-modal-overlay" style="display:none" onclick="if(event.target===this)vpCloseScheduleModal()">
    <div class="vq-modal">
      <h3 id="vp-sched-modal-title">Schedule Recording</h3>
      <div class="fg" style="margin-bottom:12px"><label id="vp-sched-dt-label">Recording Date &amp; Time</label>
        <input type="datetime-local" id="vp-sched-dt"/>
      </div>
      <div class="fg" id="vp-sched-riverside-wrap" style="margin-bottom:12px"><label>Riverside Room URL <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
        <input type="url" id="vp-sched-riverside" placeholder="https://riverside.fm/studio/…"/>
      </div>
      <div class="fg" style="margin-bottom:12px"><label id="vp-sched-notes-label">Notes to guest <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
        <textarea id="vp-sched-notes" style="min-height:60px" placeholder="Anything they should prepare…"></textarea>
      </div>
      <div id="vp-sched-err" class="err" style="display:none;margin-bottom:8px"></div>
      <div class="vq-modal-actions">
        <button class="btn" onclick="vpCloseScheduleModal()" style="background:none">Cancel</button>
        <button class="btn" onclick="vpSubmitSchedule()">Confirm Schedule</button>
      </div>
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
      <div id="ccProductWrap" style="display:none;margin-top:14px;padding:12px;border-radius:8px;background:rgba(0,242,234,.06);border:1px solid rgba(0,242,234,.25)">
        <div style="font-size:12px;font-weight:700;color:var(--cyan);margin-bottom:8px">🤖 Claude Code — Select product</div>
        <select id="ccProductSel" style="width:100%;padding:10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border)"><option value="">Choose product…</option></select>
        <div style="font-size:11px;color:var(--muted);margin-top:6px">Claude will receive the task and product context via Lark.</div>
      </div>
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
    <h3>→ Send to Software</h3>
    <p class="mt" id="push-task-title" style="font-size:14px;font-weight:600;margin-bottom:4px"></p>
    <p id="push-task-meta" style="font-size:12px;color:var(--muted);margin:0 0 14px"></p>
    <label style="display:block;margin-bottom:6px">Product <span style="color:var(--muted);font-weight:400">(optional)</span></label>
    <select id="push-product" style="width:100%;padding:10px;border-radius:8px;background:var(--panel2);color:var(--txt);border:1px solid var(--border);font-family:inherit;font-size:13px;margin-bottom:14px"><option value="">No product</option></select>
    <label for="push-note">Note for the sprint <span style="color:var(--muted);font-weight:400">(optional)</span></label>
    <textarea id="push-note" placeholder="What's the update, blocker, or context?" style="width:100%;min-height:70px;margin-top:6px;background:var(--panel2);border:1px solid var(--border);border-radius:8px;color:var(--txt);padding:10px;font-size:13px;font-family:inherit;resize:none"></textarea>
    <div class="err" id="push-err" style="display:none"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closePushOverlay()">Cancel</button>
      <button class="btn" onclick="doPushToSprint()">Add to Software →</button>
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

<!-- Team Management tab -->
<div id="tab-team-mgmt" style="display:none">
  <div id="tm-payroll-section"></div>
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
    <div style="font-size:18px;font-weight:800;letter-spacing:-.02em">Team</div>
    <button class="vq-btn" onclick="tmRefreshOverviews()" id="tm-refresh-btn" style="font-size:11px">↻ Refresh AI Overviews</button>
  </div>
  <div class="tm-grid" id="tm-grid"><div style="color:var(--muted);font-size:12px">Loading…</div></div>
</div>

<!-- More Tools tab -->
<div id="tab-more-tools" style="display:none">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
    <div style="font-size:18px;font-weight:800;letter-spacing:-.02em">More Tools</div>
  </div>
  <div class="mt-grid" id="mt-grid"><div style="color:var(--muted);font-size:12px">Loading…</div></div>
</div>

<!-- Add Tool modal -->
<div class="mt-modal-overlay" id="mt-modal" style="display:none" onclick="if(event.target===this)mtCloseModal()">
  <div class="mt-modal">
    <h3 id="mt-modal-title">Add a Tool</h3>
    <label>Emoji Icon</label>
    <input id="mt-emoji" type="text" placeholder="🔧" maxlength="4" style="width:80px;margin-bottom:14px">
    <label>Name</label>
    <input id="mt-name" type="text" placeholder="CapCut" maxlength="40">
    <label>Link</label>
    <input id="mt-url" type="url" placeholder="https://..." maxlength="500">
    <div class="mt-modal-btns">
      <button class="vq-btn vq-done" style="flex:1" onclick="mtSave()">Add Tool</button>
      <button class="vq-btn" onclick="mtCloseModal()">Cancel</button>
    </div>
  </div>
</div>

<!-- Team member modal -->
<div class="tm-modal-overlay" id="tm-modal" style="display:none" onclick="if(event.target===this)tmCloseModal()">
  <div class="tm-modal">
    <div class="tm-modal-hdr">
      <div class="tm-modal-avatar" id="tmm-avatar"></div>
      <div>
        <div style="font-size:18px;font-weight:800" id="tmm-name"></div>
        <div style="font-size:12px;color:var(--muted)" id="tmm-role"></div>
      </div>
      <button onclick="tmCloseModal()" style="margin-left:auto;background:none;border:none;font-size:20px;color:var(--muted);cursor:pointer">✕</button>
    </div>
    <!-- Contact -->
    <div class="tm-section">
      <div class="tm-section-title">Contact</div>
      <div class="tm-contact-grid" id="tmm-contact"></div>
    </div>
    <!-- Stats detail -->
    <div class="tm-section">
      <div class="tm-section-title">Stats</div>
      <div id="tmm-stats-detail"></div>
    </div>
    <!-- KPIs -->
    <div class="tm-section" id="tmm-kpi-section">
      <div class="tm-section-title">KPI Gates (this month)</div>
      <div id="tmm-kpis"></div>
    </div>
    <!-- AI Overview -->
    <div class="tm-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div class="tm-section-title" style="margin-bottom:0">AI Overview</div>
        <span id="tmm-ai-updated" style="font-size:9px;color:var(--muted)"></span>
      </div>
      <div class="tm-ai-overview" id="tmm-ai-overview">No overview generated yet.</div>
    </div>
    <!-- Recent Calls -->
    <div class="tm-section">
      <div class="tm-section-title">Recent Calls</div>
      <div id="tmm-calls"><div style="color:var(--muted);font-size:12px">Loading…</div></div>
    </div>
    <!-- Notes -->
    <div class="tm-section" id="tmm-notes-section" style="display:none">
      <div class="tm-section-title">Admin Notes</div>
      <textarea class="tm-notes-ta" id="tmm-notes-ta" placeholder="Notes about this team member…"></textarea>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="vq-btn vq-done" onclick="tmSaveNotes()">Save Notes</button>
      </div>
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
  document.getElementById('tab-video-queue').style.display=idx===3?'':'none';
  document.getElementById('tab-team-mgmt').style.display=idx===4?'':'none';
  document.getElementById('tab-more-tools').style.display=idx===5?'':'none';
  if(idx===1)loadReportTab();
  if(idx===2)loadSprint();
  if(idx===3){applyVqRole();loadVideoQueue();}
  if(idx===4)loadTeamMgmt();
  if(idx===5)loadMoreTools();
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
  var html='<div style="margin-bottom:16px"><div style="font-size:16px;font-weight:700;margin-bottom:6px">'+esc(r.title||'Software')+'</div>';
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
    renderSprint();closePlanOverlay();toast('Software items added!');
  }).catch(function(){btn.disabled=false;btn.textContent='Retry';});
}

function load(){
  if(DEV_AS){
    var db=document.getElementById('dev-banner');
    if(db){
      db.style.cssText='display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:rgba(255,0,80,.1);border:1px solid rgba(255,0,80,.35);border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:12.5px;color:var(--red)';
      db.innerHTML='<strong>Dev Mode</strong> — viewing as <strong>'+DEV_AS+'</strong>. Read-only.<button onclick="window.location.href=\\'/my-tasks\\';" style="margin-left:auto;padding:4px 12px;border-radius:6px;border:1px solid rgba(255,0,80,.5);background:rgba(255,0,80,.12);color:var(--red);cursor:pointer;font-size:12px;font-weight:600">✕ Exit Dev Mode</button>';
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
      var isMatchmaking=t.source==='creator-matchmaking';
      html+='<div class="card'+(isMatchmaking?' matchmaking-glow':'')+'" id="card-'+t.record_id+'"><div class="body">';
      html+='<div class="task-title" id="ttl-'+t.record_id+'" onclick="startEditCardTitle(\\''+t.record_id+'\\')">'+esc(t.task||'(untitled)')+(isMatchmaking?'<span class="tiktok-badge">🎵 TikTok</span>':'')+'</div>';
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
    if(CB_IS_ADMIN&&!DEV_AS){var tmBtn=document.getElementById('tm-tab-btn');if(tmBtn)tmBtn.style.display='';var tmChip=document.getElementById('hdr-team-chip');if(tmChip)tmChip.style.display='';}
    if(!d.hasComp&&CB_IS_ADMIN&&!DEV_AS){
      // Admin with no personal comp: payroll lives only in Team Management tab, not here
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
  var tmPay=document.getElementById('tm-payroll-section');
  if(tmPay)tmPay.innerHTML='<div class="tp"><div class="tp-hdr"><span class="tp-title">Team Payroll</span><span class="tp-est">ESTIMATED — settles monthly</span></div><div style="color:var(--muted);font-size:12px">Loading…</div></div>';
  if(el)el.style.display='none';
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
  el.style.display='none';
  var tmPay=document.getElementById('tm-payroll-section');
  if(tmPay)tmPay.innerHTML=html;
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
  var fill=function(){
    var sel=document.getElementById('assignSel');
    sel.innerHTML='<option value="">Choose…</option>'
      +'<option value="__claude_code__">🤖 Claude Code</option>'
      +TEAM.map(function(m){return'<option value="'+m.openId+'">'+esc(m.name)+(m.role?' — '+esc(m.role):'')+'</option>';}).join('');
    sel.onchange=function(){
      var isClaude=this.value==='__claude_code__';
      var wrap=document.getElementById('ccProductWrap');
      wrap.style.display=isClaude?'block':'none';
      if(isClaude){
        var psel=document.getElementById('ccProductSel');
        psel.innerHTML='<option value="">Choose product…</option>'+SP_PRODUCTS.map(function(p){return'<option value="'+p.id+'">'+p.emoji+' '+esc(p.name)+'</option>';}).join('');
        psel.onchange=function(){btn.disabled=!this.value;};
        btn.disabled=true;
      }else{
        btn.disabled=!this.value;
      }
    };
  };
  var ps=document.getElementById('prioSel');var curP=(CURRENT.priority||'').trim();var match=['🔴 Critical','🟠 High','🟡 Normal','⚪ Low'].filter(function(p){return p===curP;});ps.value=match[0]||'🟡 Normal';
  if(TEAM.length){fill();}else{fetch('/api/my-tasks/team',{credentials:'include'}).then(function(r){return r.json();}).then(function(d){TEAM=d.team||[];fill();}).catch(function(){});}
  document.getElementById('overlay').classList.add('show');
}
function doReassign(){
  if(!CURRENT)return;var to=document.getElementById('assignSel').value;if(!to)return;
  var btn=document.getElementById('confirmBtn');btn.disabled=true;btn.textContent='Saving…';
  if(to==='__claude_code__'){
    var psel=document.getElementById('ccProductSel');
    var productId=psel?psel.value:'';
    var product=SP_PRODUCTS.filter(function(p){return p.id===productId;})[0]||null;
    fetch('/api/my-tasks/reassign-claude',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({record_id:CURRENT.record_id,task:CURRENT.task||'',productId:productId,productName:product?product.name:'',priority:document.getElementById('prioSel').value})})
    .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});}).then(function(x){
      btn.textContent='Reassign';
      if(x.ok&&x.j.ok){ALL=ALL.filter(function(t){return t.record_id!==CURRENT.record_id;});closeModal();renderFilters();render();document.getElementById('sub').textContent=ALL.length+' active task'+(ALL.length===1?'':'s');toast('🤖 Sent to Claude Code');}
      else{document.getElementById('modalErr').style.display='block';document.getElementById('modalErr').textContent=(x.j&&x.j.error)||'Failed to ping Claude Code';btn.disabled=false;}
    }).catch(function(e){document.getElementById('modalErr').style.display='block';document.getElementById('modalErr').textContent=''+e;btn.disabled=false;btn.textContent='Reassign';});
    return;
  }
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
function closeModal(){document.getElementById('overlay').classList.remove('show');CURRENT=null;var w=document.getElementById('ccProductWrap');if(w)w.style.display='none';}
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
function toast(msg,dur){var t=document.getElementById('toast');t.textContent=msg;t.style.display='block';setTimeout(function(){t.style.display='none';},(dur||3500));}

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

/* ── Video Queue ─────────────────────────────────────────────────────── */
var VQ_DATA=[], VQ_MY_EMAIL='', VQ_IS_EDITOR=false, VQ_IS_ADMIN=false, VQ_LOADED=false;
var VQ_POSTED_SORT='views'; // 'views' | 'date'
function vqSetSort(s){
  VQ_POSTED_SORT=s;
  document.getElementById('vq-sort-views').style.background=s==='views'?'rgba(167,139,250,.15)':'none';
  document.getElementById('vq-sort-views').style.color=s==='views'?'#a78bfa':'var(--muted)';
  document.getElementById('vq-sort-date').style.background=s==='date'?'rgba(167,139,250,.15)':'none';
  document.getElementById('vq-sort-date').style.color=s==='date'?'#a78bfa':'var(--muted)';
  renderVideoQueue();
}
var VQ_BRANDS=['Lode WTR','Roots by Genetic Art','Trip Visuals','Made Right','B NOOR','Elasco Skincare','Starlit Scribbles'];

// Connected Buffer channels — IDs from api.buffer.com/graphql
var VQ_BUFFER_CHANNELS=[
  {id:'69d7f3cd031bfa423ce82b4a',service:'tiktok',   name:'tommylynch_'},
  {id:'69d6de31031bfa423ce369cf',service:'instagram', name:'tommy.lynch_'},
  {id:'69d70072031bfa423ce3fc25',service:'instagram', name:'cultcontent.cc'},
  {id:'69d6de1e031bfa423ce368be',service:'youtube',   name:'Tommy Lynch'},
  {id:'69d6de07031bfa423ce366fa',service:'youtube',   name:'Cult Content'},
  {id:'69d700d7031bfa423ce3fd6f',service:'linkedin',  name:'tommy-lynch (personal)'},
  {id:'69d70096031bfa423ce3fca1',service:'linkedin',  name:'cultcontent (org)'},
  {id:'69d70154031bfa423ce3fefa',service:'facebook',  name:'Cult Content'},
  {id:'69d7018f031bfa423ce3ffa5',service:'twitter',   name:'thlynch3'},
];

function applyVqRole(){
  var isEd=!!(window.__VQ_IS_EDITOR__);
  var isAdm=!!(window.__VQ_IS_ADMIN__);
  // Submit form only for admin (Tommy); editors just work the kanban
  document.getElementById('vq-submit-form').style.display=isAdm?'':'none';
  // Kanban visible to both editor and admin
  document.getElementById('vq-queue-wrap').style.display=(isAdm||isEd)?'':'none';
  // Your Tools panel for editors
  document.getElementById('vq-tools-panel').style.display=isEd?'':'none';
  // Old list view hidden — everyone uses kanban now
  document.getElementById('vq-list-wrap').style.display='none';
  // Podcast tab only visible to admin (Tommy)
  var sectionTabs=document.getElementById('vp-section-tabs');
  if(sectionTabs)sectionTabs.style.display=isAdm?'':'none';
}

function loadVideoQueue(){
  if(!VQ_LOADED){
    var dl=document.getElementById('vq-brand-list');
    if(dl)VQ_BRANDS.forEach(function(b){var o=document.createElement('option');o.value=b;dl.appendChild(o);});
  }
  fetch('/api/video-requests',{credentials:'include'})
  .then(function(r){return r.json();}).then(function(d){
    VQ_DATA=d.requests||[];
    VQ_MY_EMAIL=d.myEmail||'';
    VQ_IS_EDITOR=!!d.isEditor;
    VQ_IS_ADMIN=!!d.isAdmin;
    VQ_LOADED=true;
    // Auto-transition: any scheduled card whose time has passed moves to Posted,
    // then immediately fetches live post URLs from Buffer.
    var now=Date.now();
    var toPost=VQ_DATA.filter(function(r){
      return r.status==='approved'&&r.scheduledAt&&new Date(r.scheduledAt).getTime()<now;
    });
    if(toPost.length){
      var remaining=toPost.length;
      var done=function(){remaining--;if(remaining===0)renderVideoQueue();};
      toPost.forEach(function(r){
        fetch('/api/video-requests/'+r.id,{
          method:'PATCH',credentials:'include',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({status:'posted'}),
        }).then(function(){
          r.status='posted';
          // Fetch live Buffer URLs; fire-and-forget then re-render
          fetch('/api/video-requests/'+r.id+'/fetch-links',{
            method:'POST',credentials:'include',
            headers:{'Content-Type':'application/json'},
          }).then(function(res){return res.json();}).then(function(ld){
            if(ld.links)ld.links.forEach(function(l){
              r.postedLinks=r.postedLinks||[];
              if(!r.postedLinks.find(function(e){return e.url===l.url;}))r.postedLinks.push(l);
            });
            if(ld.errors)r.linkErrors=ld.errors;
            done();
          }).catch(function(){done();});
        }).catch(function(){done();});
      });
    } else {
      renderVideoQueue();
    }
  }).catch(function(e){toast('Could not load video queue: '+e);});
}

function renderVideoQueue(){
  vqUpdateTracker();
  var pending=VQ_DATA.filter(function(r){return r.status==='pending';});
  var inprog=VQ_DATA.filter(function(r){return r.status==='in-progress';});
  var done=VQ_DATA.filter(function(r){return r.status==='done';});
  var scheduled=VQ_DATA.filter(function(r){return r.status==='approved';});
  var posted=VQ_DATA.filter(function(r){return r.status==='posted';}).sort(function(a,b){
    if(VQ_POSTED_SORT==='views') return (b.totalViews||0)-(a.totalViews||0);
    return (b.postedAt||b.scheduledAt&&new Date(b.scheduledAt).getTime()||0)-(a.postedAt||a.scheduledAt&&new Date(a.scheduledAt).getTime()||0);
  });
  var pendingCount=pending.reduce(function(s,r){return s+(r.quantity||1);},0);
  document.getElementById('vq-cnt-pending').textContent=pendingCount;
  document.getElementById('vq-cnt-inprogress').textContent=inprog.length;
  document.getElementById('vq-cnt-done').textContent=done.length;
  document.getElementById('vq-cnt-scheduled').textContent=scheduled.length;
  document.getElementById('vq-cnt-posted').textContent=posted.length;
  document.getElementById('vq-col-pending').innerHTML=pending.map(vqCardHtml).join('')||'<div class="vq-empty">Nothing submitted yet</div>';
  document.getElementById('vq-col-inprogress').innerHTML=inprog.map(vqCardHtml).join('')||'<div class="vq-empty">Nothing in editing</div>';
  document.getElementById('vq-col-done').innerHTML=done.map(vqCardHtml).join('')||'<div class="vq-empty">Nothing awaiting review</div>';
  document.getElementById('vq-col-scheduled').innerHTML=scheduled.map(vqCardHtml).join('')||'<div class="vq-empty">Nothing scheduled</div>';
  document.getElementById('vq-col-posted').innerHTML=posted.map(vqCardHtml).join('')||'<div class="vq-empty">Nothing posted yet</div>';
}

function vqUpdateTracker(){
  var goal=1000;
  var submitted=VQ_DATA.filter(function(r){return r.status==='pending';}).reduce(function(s,r){return s+(r.quantity||1);},0);
  var editing=VQ_DATA.filter(function(r){return r.status==='in-progress';}).length;
  var review=VQ_DATA.filter(function(r){return r.status==='done';}).length;
  var scheduled=VQ_DATA.filter(function(r){return r.status==='approved';}).length;
  var posted=VQ_DATA.filter(function(r){return r.status==='posted';}).length;
  document.getElementById('vp-cnt-submitted').textContent=submitted;
  document.getElementById('vp-cnt-editing').textContent=editing;
  document.getElementById('vp-cnt-review').textContent=review;
  document.getElementById('vp-cnt-scheduled-tracker').textContent=scheduled;
  document.getElementById('vp-cnt-posted').textContent=posted;
  var total=submitted+editing+review+scheduled+posted;
  var scale=total>goal?total:goal;
  document.getElementById('vp-bar-submitted').style.width=((submitted/scale)*100)+'%';
  document.getElementById('vp-bar-editing').style.width=((editing/scale)*100)+'%';
  document.getElementById('vp-bar-review').style.width=((review/scale)*100)+'%';
  document.getElementById('vp-bar-scheduled').style.width=((scheduled/scale)*100)+'%';
  document.getElementById('vp-bar-posted').style.width=((posted/scale)*100)+'%';
  // Summary stats
  var totalViews=VQ_DATA.filter(function(r){return r.status==='posted';}).reduce(function(s,r){return s+(r.totalViews||0);},0);
  var totalChannelPosts=VQ_DATA.filter(function(r){return r.status==='posted';}).reduce(function(s,r){return s+((r.bufferPosts&&r.bufferPosts.length)||0);},0);
  var pct=Math.round((posted/goal)*1000)/10;
  document.getElementById('vp-stat-views').textContent=totalViews.toLocaleString();
  document.getElementById('vp-stat-posts').textContent=totalChannelPosts.toLocaleString();
  document.getElementById('vp-stat-pct').textContent=pct+'%';
}

function renderVqList(){
  var order={pending:0,'in-progress':1,done:2};
  var sorted=VQ_DATA.slice().sort(function(a,b){
    var od=(order[a.status]||0)-(order[b.status]||0);
    return od!==0?od:(b.submittedAt||0)-(a.submittedAt||0);
  });
  document.getElementById('vq-list-rows').innerHTML=
    sorted.length?sorted.map(vqRowHtml).join(''):'<div class="vq-empty">No video requests yet.</div>';
}

function vqRowHtml(r){
  var id=esc(r.id||'');
  var prioClass=r.priority==='high'?'vq-prio-high':r.priority==='low'?'vq-prio-low':'vq-prio-normal';
  var prioPretty=r.priority==='high'?'🔴 High':r.priority==='low'?'Low':'Normal';
  var dotClass=r.status==='done'?'vq-dot-review':r.status==='approved'?'vq-dot-scheduled':r.status==='in-progress'?'vq-dot-inprogress':r.status==='posted'?'vq-dot-posted':'vq-dot-pending';
  var statusPretty=r.status==='in-progress'?'Editing':r.status==='done'?'For Review':r.status==='approved'?'Scheduled':r.status==='posted'?'Posted':'Submitted';
  var due=r.dueDate||'—';
  var rowFootageLink=r.driveUrl?'<a href="'+esc(r.driveUrl)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:#00f2ea;text-decoration:none;font-size:.82rem;font-weight:600;">Open Footage</a>':'<span style="color:var(--muted);font-size:12px">No footage linked</span>';
  var rowAssetsLink=r.assetsDriveUrl?'<a href="'+esc(r.assetsDriveUrl)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:#c9a84c;text-decoration:none;font-size:.82rem;font-weight:600;">Brand Assets</a>':'';
  var driveBtn=rowFootageLink+(rowAssetsLink?' &nbsp;&middot;&nbsp; '+rowAssetsLink:'');
  var actionBtn='';
  if(r.status==='pending') actionBtn='<button class="vq-btn vq-primary" onclick="event.stopPropagation();vqMoveStatus(\\''+id+'\\',\\'in-progress\\')">▶ Start</button>';
  if(r.status==='in-progress') actionBtn='<button class="vq-btn vq-done" onclick="event.stopPropagation();vqMoveStatus(\\''+id+'\\',\\'done\\')">✓ Ready for Review</button>';
  if(r.status==='done') actionBtn='<button class="vq-btn vq-schedule" onclick="event.stopPropagation();vqMoveStatus(\\''+id+'\\',\\'approved\\')">→ Schedule</button>';
  if(r.status==='approved') actionBtn='<button class="vq-btn vq-mark-posted" onclick="event.stopPropagation();vqMoveStatus(\\''+id+'\\',\\'posted\\')">📤 Mark Posted</button>';
  return '<div class="vq-row" id="vqrow-'+id+'">'
    +'<div class="vq-row-summary" onclick="vqToggleRow(\\''+id+'\\')">'
    +'<div class="vq-dot '+dotClass+'"></div>'
    +'<div class="vq-row-member">'+esc(r.submittedByName||r.submittedBy||'?')+'</div>'
    +'<div><div class="vq-row-title">'+esc(r.title||'Untitled')+'</div><div class="vq-row-sub">'+esc(r.brand||'—')+'</div></div>'
    +'<span class="vq-prio-chip '+prioClass+'">'+prioPretty+'</span>'
    +'<div class="vq-row-due">'+esc(due)+'</div>'
    +'<div style="font-size:11px;color:var(--muted)">'+esc(statusPretty)+'</div>'
    +'</div>'
    +'<div class="vq-row-detail">'
    +(r.description?'<div style="font-size:13px;line-height:1.5;margin-bottom:10px"><strong>Brief:</strong> '+esc(r.description)+'</div>':'')
    +(r.script?'<div style="font-size:12px;line-height:1.5;margin-bottom:12px;background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;white-space:pre-wrap"><strong>Script:</strong> '+esc(r.script)+'</div>':'')
    +'<div class="vq-actions">'+driveBtn+actionBtn+'</div>'
    +'</div>'
    +'</div>';
}

function vqToggleRow(id){
  var el=document.getElementById('vqrow-'+id);
  if(el)el.classList.toggle('expanded');
}

function vqCardHtml(r){
  var prioClass=r.priority==='high'?'vq-prio-high':r.priority==='low'?'vq-prio-low':'vq-prio-normal';
  var date=r.submittedAt?new Date(r.submittedAt).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';
  var id=esc(r.id||'');
  var deleteBtn=VQ_IS_ADMIN?'<button class="vq-btn" style="margin-left:auto;color:var(--red)" onclick="vqDelete(\\''+id+'\\')">✕ Delete</button>':'';
  var footageLink=r.driveUrl?'<a href="'+esc(r.driveUrl)+'" target="_blank" rel="noopener" style="color:#00f2ea;text-decoration:none;font-size:.75rem;">Footage</a>':'';
  var assetsLink=r.assetsDriveUrl?'<a href="'+esc(r.assetsDriveUrl)+'" target="_blank" rel="noopener" style="color:#c9a84c;text-decoration:none;font-size:.75rem;">Brand Assets</a>':'';
  var driveBtn=(footageLink||assetsLink)?'<div style="display:flex;gap:10px;margin-top:4px;">'+footageLink+assetsLink+'</div>':'';
  var body='';

  if(r.status==='pending'){
    var startBtn=(VQ_IS_EDITOR||VQ_IS_ADMIN)?'<button class="vq-btn vq-primary" onclick="vqMoveStatus(\\''+id+'\\',\\'in-progress\\')">▶ Start</button>':'';
    var pendingNotes=(r.notes||r.description)?'<div style="font-size:12px;color:var(--muted);line-height:1.5;white-space:pre-wrap;margin-bottom:8px">'+esc(r.notes||r.description)+'</div>':'';
    body=pendingNotes+'<div class="vq-actions">'+driveBtn+startBtn+'</div>';
  }

  else if(r.status==='in-progress'){
    var revBadge=r.revisionsRequested?'<div style="display:flex;align-items:flex-start;gap:8px;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.25);border-radius:8px;padding:8px 10px;margin-bottom:8px;min-width:0">'
      +'<span style="font-size:14px;flex-shrink:0">↩</span>'
      +'<div style="min-width:0;flex:1"><div style="font-size:11px;font-weight:700;color:#fbbf24;margin-bottom:2px">Revisions requested</div>'
      +'<div style="font-size:11px;color:rgba(251,191,36,.75);line-height:1.4;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere">'+esc(r.revisionNotes||'')+'</div>'
      +'</div></div>':'';
    var notesHtml=revBadge+'<div id="vqnotes-view-'+id+'" style="font-size:12px;color:var(--muted);line-height:1.5;white-space:pre-wrap;margin-bottom:6px">'
      +(r.notes||r.description?esc(r.notes||r.description):'<em style="opacity:.5">No notes yet</em>')
      +'</div>'
      +'<div id="vqnotes-edit-'+id+'" style="display:none">'
      +'<textarea rows="3" style="width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:7px 10px;color:var(--txt);font-size:12px;font-family:inherit;resize:vertical" id="vqnotes-ta-'+id+'">'+(esc(r.notes||r.description||''))+'</textarea>'
      +'<div style="display:flex;gap:6px;margin-top:4px">'
      +'<button class="vq-btn vq-done" onclick="vqSaveNotes(\\''+id+'\\')">Save</button>'
      +'<button class="vq-btn" onclick="document.getElementById(\\'vqnotes-edit-'+id+'\\').style.display=\\'none\\';document.getElementById(\\'vqnotes-view-'+id+'\\').style.display=\\'\\'">Cancel</button>'
      +'</div></div>';
    var editNotesBtn='<button class="vq-btn" style="font-size:10px;padding:2px 7px" onclick="document.getElementById(\\'vqnotes-view-'+id+'\\').style.display=\\'none\\';document.getElementById(\\'vqnotes-edit-'+id+'\\').style.display=\\'\\';document.getElementById(\\'vqnotes-ta-'+id+'\\').focus()">✏ Edit notes</button>';
    var draftForm='<div id="vqdraft-form-'+id+'" style="display:none" class="vq-inline-form">'
      +'<input type="url" placeholder="Paste Google Drive link to edited draft…" id="vqdraft-url-'+id+'" />'
      +'<div style="display:flex;gap:6px"><button class="vq-btn vq-done" onclick="vqSubmitDraft(\\''+id+'\\')">Submit Draft</button>'
      +'<button class="vq-btn" onclick="document.getElementById(\\'vqdraft-form-'+id+'\\').style.display=\\'none\\'">Cancel</button></div>'
      +'</div>';
    var uploadDraftBtn=(VQ_IS_EDITOR||VQ_IS_ADMIN)?'<button class="vq-btn vq-primary" onclick="document.getElementById(\\'vqdraft-form-'+id+'\\').style.display=document.getElementById(\\'vqdraft-form-'+id+'\\').style.display===\\'none\\'?\\'\\':\\'none\\'">📤 Upload Draft</button>':'';
    body=notesHtml+editNotesBtn+'<div class="vq-actions" style="margin-top:8px">'+driveBtn+uploadDraftBtn+'</div>'+draftForm;
  }

  else if(r.status==='done'){
    var draftLink=r.draftUrl?'<a href="'+esc(r.draftUrl)+'" target="_blank" class="vq-btn vq-drive">📄 View Draft</a>':'<span style="font-size:11px;color:var(--muted)">No draft yet</span>';
    if(r.shoppable&&VQ_IS_ADMIN){
      var shoppableForm='<div class="vq-inline-form" id="vqform-'+id+'" style="margin-top:10px">'
        +'<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;background:rgba(0,242,234,.06);border:1px solid rgba(0,242,234,.2);border-radius:8px;padding:8px 10px">'
        +'<span style="font-size:14px">🛒</span>'
        +'<span style="font-size:11px;font-weight:700;color:var(--cyan)">TikTok Shop — Manual Post</span>'
        +'<span style="font-size:10px;color:var(--muted);margin-left:4px">post directly in TikTok app</span>'
        +'</div>'
        +'<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Caption</div>'
        +'<textarea rows="2" placeholder="Write your caption…" id="vqcap-'+id+'" style="width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:7px 10px;color:var(--txt);font-size:12px;font-family:inherit;resize:vertical;margin-bottom:10px">'+esc(r.caption||'')+'</textarea>'
        +'<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">TikTok status</div>'
        +'<div style="display:flex;gap:6px;margin-bottom:12px">'
        +'<button class="vq-btn '+((!r.tiktokShopStatus||r.tiktokShopStatus==='scheduled')?'vq-schedule':'')+'" onclick="vqSetTiktokStatus(\\''+id+'\\',\\'scheduled\\')" id="vqtts-sched-'+id+'">📅 Scheduled</button>'
        +'<button class="vq-btn '+(r.tiktokShopStatus==='posting'?'vq-primary':'')+'" onclick="vqSetTiktokStatus(\\''+id+'\\',\\'posting\\')" id="vqtts-post-'+id+'">📲 Posting Now</button>'
        +'</div>'
        +'<button class="vq-btn vq-schedule" onclick="vqApproveShoppable(\\''+id+'\\',this)">✓ Move to Scheduled</button>'
        +'<div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,.07)">'
        +'<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Request Revision</div>'
        +'<textarea rows="2" placeholder="Describe what needs to change…" id="vqrev-'+id+'" style="width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:7px 10px;color:var(--txt);font-size:12px;font-family:inherit;resize:vertical;margin-bottom:6px"></textarea>'
        +'<button class="vq-btn" style="background:rgba(251,191,36,.12);border-color:rgba(251,191,36,.3);color:#fbbf24" onclick="vqRequestRevision(\\''+id+'\\')">↩ Request Revision</button>'
        +'</div>'
        +'</div>';
      body='<div class="vq-actions">'+draftLink+deleteBtn+'</div>'+shoppableForm;
    } else if(VQ_IS_ADMIN){
      var savedCap=esc(r.caption||'');
      var savedSched=toLocalInputDT(r.scheduledAt);
      var savedVideoTitle=esc(r.videoTitle||'');
      var savedChannels=r.channelSchedules||[];
      // Build per-channel rows
      var channelRows=VQ_BUFFER_CHANNELS.map(function(ch){
        var saved=savedChannels.find(function(s){return s.channelId===ch.id;})||{};
        var isOn=saved.on||(savedChannels.length===0&&false);
        var chCap=esc(saved.caption||'');
        var chSched=''; // always blank — master time is used; user sets per-channel override explicitly
        var svcIcon={'tiktok':'📱','instagram':'📸','youtube':'▶️','linkedin':'💼','twitter':'𝕏','facebook':'👤'}[ch.service]||'🌐';
        var tagHint={'linkedin':'Tag people: type their name — Buffer will try to resolve. Companies may need the exact page name.','tiktok':'Tag with @username — must be their exact TikTok handle.','instagram':'Tag with @username in caption.'}[ch.service]||'';
        return '<div class="vq-ch-row" id="vqch-'+id+'-'+ch.id+'" data-ch="'+ch.id+'" data-svc="'+ch.service+'">'
          +'<div style="display:flex;align-items:center;justify-content:space-between;gap:6px">'
          +'<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;font-weight:600;flex:1;min-width:0">'
          +'<input type="checkbox" class="vq-ch-check" '+(isOn?'checked':'')+' onchange="vqToggleChannel(\\''+id+'\\',\\''+ch.id+'\\',this)" style="accent-color:var(--cyan);width:14px;height:14px;flex-shrink:0"/>'
          +svcIcon+' '+esc(ch.name)+' <span style="font-size:10px;color:var(--muted);font-weight:400">'+ch.service+'</span>'
          +'</label>'
          +'<button type="button" class="vq-ch-edit-btn" style="display:'+(isOn?'':'none')+';background:none;border:1px solid rgba(255,255,255,.12);border-radius:4px;color:var(--muted);font-size:10px;cursor:pointer;padding:2px 7px;flex-shrink:0;white-space:nowrap" onclick="vqExpandChannel(\\''+id+'\\',\\''+ch.id+'\\',this)">▾ Edit</button>'
          +'</div>'
          +'<div class="vq-ch-detail" style="display:none;margin-top:8px;padding-left:22px">'
          +(tagHint?'<div style="font-size:10px;color:#f59e0b;margin-bottom:6px">⚠ '+tagHint+'</div>':'')
          +'<textarea rows="2" placeholder="Caption for this channel…" class="vq-ch-cap" data-ch="'+ch.id+'" oninput="vqMarkCapEdited(this)" style="width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:6px 9px;color:var(--txt);font-size:11px;font-family:inherit;resize:vertical;margin-bottom:6px">'+chCap+'</textarea>'
          +'<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
          +'<span style="font-size:10px;color:var(--muted)">Override time:</span>'
          +'<input type="datetime-local" class="vq-ch-sched" data-ch="'+ch.id+'" value="'+chSched+'" style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:4px 8px;color:var(--txt);font-size:11px;flex:1;min-width:160px"/>'
          +'</div>'
          +'</div>'
          +'</div>';
      }).join('');
      var reviewForm='<div class="vq-inline-form" id="vqform-'+id+'" style="margin-top:10px">'
        +'<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Title <span style="font-weight:400;text-transform:none;letter-spacing:0;color:rgba(255,255,255,.3)">(YouTube — required)</span></div>'
        +'<input type="text" id="vqvtitle-'+id+'" placeholder="Video title for YouTube…" value="'+savedVideoTitle+'" style="width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:7px 10px;color:var(--txt);font-size:12px;font-family:inherit;margin-bottom:10px"/>'
        +'<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Master caption <span style="font-weight:400;text-transform:none;letter-spacing:0">(auto-fills each channel)</span></div>'
        +'<textarea rows="2" placeholder="Write your caption…" id="vqcap-'+id+'" onkeyup="vqSyncCaptions(\\''+id+'\\')" style="width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:7px 10px;color:var(--txt);font-size:12px;font-family:inherit;resize:vertical;margin-bottom:10px">'+savedCap+'</textarea>'
        +'<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Default date &amp; time</div>'
        +'<input type="datetime-local" id="vqsched-'+id+'" value="'+savedSched+'" onchange="vqSyncSchedule(\\''+id+'\\')" style="width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:7px 10px;color:var(--txt);font-size:12px;margin-bottom:12px"/>'
        +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">'
        +'<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Channels</div>'
        +'<button type="button" style="background:none;border:none;font-size:10px;color:var(--cyan);cursor:pointer;padding:0" onclick="vqSelectAllChannels(\\''+id+'\\',this)">Select all</button>'
        +'</div>'
        +'<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">'+channelRows+'</div>'
        +'<div id="vqsched-err-'+id+'" style="font-size:11px;color:var(--red);display:none;margin-bottom:6px"></div>'
        +'<button class="vq-btn vq-schedule" id="vqschedbtn-'+id+'" onclick="vqApproveSchedule(\\''+id+'\\',this)">✓ Approve &amp; Schedule in Buffer</button>'
        +'<div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,.07)">'
        +'<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Request Revision</div>'
        +'<textarea rows="2" placeholder="Describe what needs to change…" id="vqrev-'+id+'" style="width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:7px 10px;color:var(--txt);font-size:12px;font-family:inherit;resize:vertical;margin-bottom:6px"></textarea>'
        +'<button class="vq-btn" style="background:rgba(251,191,36,.12);border-color:rgba(251,191,36,.3);color:#fbbf24" onclick="vqRequestRevision(\\''+id+'\\')">↩ Request Revision</button>'
        +'</div>'
        +'</div>';
      body='<div class="vq-actions">'+draftLink+deleteBtn+'</div>'+reviewForm;
    } else {
      body='<div class="vq-actions">'+draftLink+'</div>';
    }
  }

  else if(r.status==='approved'){
    var draftLink2=r.draftUrl?'<a href="'+esc(r.draftUrl)+'" target="_blank" class="vq-btn vq-drive">📄 Draft</a>':'';
    if(r.shoppable){
      var tsStatus=r.tiktokShopStatus||'scheduled';
      var tsLabel=tsStatus==='posting'?'📲 Posting Now':'📅 Scheduled';
      var tsBadgeColor=tsStatus==='posting'?'rgba(0,242,234,.15)':'rgba(59,130,246,.12)';
      var tsBorderColor=tsStatus==='posting'?'rgba(0,242,234,.4)':'rgba(59,130,246,.3)';
      var tsBadge='<span style="background:'+tsBadgeColor+';border:1px solid '+tsBorderColor+';border-radius:10px;padding:2px 9px;font-size:10px;font-weight:700;color:'+(tsStatus==='posting'?'var(--cyan)':'#60a5fa')+'">'+tsLabel+'</span>';
      var tsToggle=VQ_IS_ADMIN
        ?'<div style="display:flex;gap:6px;margin-top:8px">'
          +'<button class="vq-btn '+(tsStatus==='scheduled'?'vq-schedule':'')+'" onclick="vqSetTiktokStatus(\\''+id+'\\',\\'scheduled\\')" style="font-size:11px">📅 Scheduled</button>'
          +'<button class="vq-btn '+(tsStatus==='posting'?'vq-primary':'')+'" onclick="vqSetTiktokStatus(\\''+id+'\\',\\'posting\\')" style="font-size:11px">📲 Posting Now</button>'
          +'</div>':''
      var markPostedBtn=VQ_IS_ADMIN?'<button class="vq-btn vq-mark-posted" onclick="vqMarkPosted(\\''+id+'\\')" style="font-size:11px;margin-top:8px">📤 Mark Posted</button>':'';
      body='<div style="font-size:11px;color:var(--muted);margin-bottom:8px;line-height:1.7">'
        +'<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><span style="font-size:14px">🛒</span><span style="font-weight:700;color:var(--txt)">TikTok Shop</span>'+tsBadge+'</div>'
        +(r.caption?'<strong style="color:var(--txt)">Caption:</strong> '+esc(r.caption.slice(0,80))+(r.caption.length>80?'…':''):'')
        +'</div>'
        +'<div class="vq-actions" style="flex-wrap:wrap;gap:6px">'+draftLink2+'</div>'
        +tsToggle+markPostedBtn;
      var isClientVideoS=r.source==='client-portal';
      return '<div class="vq-card">'
        +'<div class="vq-card-top">'+(r.brand&&!isClientVideoS?'<span class="vq-brand-chip">'+esc(r.brand)+'</span>':'')
        +(isClientVideoS?'<span class="vq-prio-chip" style="background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.3);color:#fbbf24">🧾 '+esc(r.brand||'Client')+'</span>':'')
        +(r.priority==='high'?'<span class="vq-prio-chip vq-prio-high">High</span>':'')
        +'<span class="vq-brand-chip" style="background:rgba(0,242,234,.08);border-color:rgba(0,242,234,.25);color:var(--cyan)">🛒 Shoppable</span>'
        +'</div>'
        +'<div class="vq-title">'+esc(r.title||'Untitled')+'</div>'
        +'<div class="vq-meta">'+date+'</div>'
        +body
        +'</div>';
    }
    var schedTime=r.scheduledAt?new Date(r.scheduledAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'—';
    // Show only the channels that actually got scheduled in Buffer
    var scheduledChannels=(r.bufferPosts||[]).map(function(p){
      var ch=VQ_BUFFER_CHANNELS.find(function(c){return c.id===p.channelId;});
      return ch?ch.name:p.channelId;
    });
    var platDisplay=scheduledChannels.length?scheduledChannels.join(', '):(r.platforms||[]).join(', ')||'—';
    var errDetail=r.bufferErrors&&r.bufferErrors.length
      ?'<details style="margin-top:6px"><summary style="font-size:10px;color:#f59e0b;cursor:pointer">⚠ '+r.bufferErrors.length+' channel(s) failed — click for details</summary>'
        +'<div style="font-size:10px;color:rgba(251,191,36,.75);margin-top:4px;line-height:1.6;white-space:pre-wrap">'+esc(r.bufferErrors.join('\\n'))+'</div></details>':''
    var editSchedBtn=VQ_IS_ADMIN?'<button class="vq-btn" onclick="vqEditSchedule(\\''+id+'\\')" style="font-size:11px">✏ Edit Schedule</button>':'';
    var cancelBufBtn=VQ_IS_ADMIN&&(r.bufferPosts||[]).length?'<button class="vq-btn" onclick="vqCancelBufferPosts(\\''+id+'\\')" style="font-size:11px;color:#f87171;border-color:rgba(248,113,113,.3)">✕ Cancel Buffer Posts</button>':'';
    body='<div style="font-size:11px;color:var(--muted);margin-bottom:8px;line-height:1.7">'
      +'<strong style="color:var(--txt)">Scheduled:</strong> '+schedTime+'<br>'
      +(r.caption?'<strong style="color:var(--txt)">Caption:</strong> '+esc(r.caption.slice(0,60))+(r.caption.length>60?'…':'')+'<br>':'')
      +'<strong style="color:var(--txt)">Channels ('+scheduledChannels.length+'):</strong> '+esc(platDisplay)
      +errDetail
      +'</div>'
      +'<div class="vq-actions">'+draftLink2+editSchedBtn+cancelBufBtn+'</div>';
  }

  else if(r.status==='posted'){
    var links=(r.postedLinks||[]);
    var linkErrors=(r.linkErrors||[]);
    var totalViews=r.totalViews||links.reduce(function(s,l){return s+(l.views||0);},0);
    var metricsAge=r.metricsUpdatedAt?'Updated '+new Date(r.metricsUpdatedAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Never synced';
    var viewsBadge=totalViews>0
      ?'<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">'
        +'<span style="font-size:20px;font-weight:800;color:var(--cyan)">'+totalViews.toLocaleString()+'</span>'
        +'<span style="font-size:11px;color:var(--muted)">total views</span>'
        +'<span style="font-size:9px;color:rgba(255,255,255,.2);margin-left:auto">'+metricsAge+'</span>'
        +'</div>'
      :'';
    var linksHtml=links.length?'<div class="vq-posted-links">'+links.map(function(l){
      var viewStr=l.views!=null&&l.views>0?'<span style="font-size:9px;color:var(--muted);margin-left:4px">'+Number(l.views).toLocaleString()+' views</span>':'';
      return '<div class="vq-posted-link"><span style="font-size:10px;color:var(--muted);min-width:80px;flex-shrink:0">'+esc(l.platform)+'</span><a href="'+esc(l.url)+'" target="_blank">'+esc(l.url)+'</a>'+viewStr+'</div>';
    }).join('')+'</div>':'';
    var errorsHtml=linkErrors.length?'<div style="margin-top:6px">'+linkErrors.map(function(e){
      return '<div style="font-size:10px;color:#f87171;padding:2px 0">⚠ '+esc(e)+'</div>';
    }).join('')+'</div>':'';
    var refreshBtn=VQ_IS_ADMIN?'<button class="vq-btn" onclick="vqRefreshLinks(\\''+id+'\\')">↻ Refresh</button>':'';
    var addLinkForm='<div id="vqlink-form-'+id+'" style="display:none" class="vq-inline-form">'
      +'<select id="vqlink-plat-'+id+'" style="width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:7px 10px;color:var(--txt);font-size:12px">'
      +'<option>TikTok</option><option>Instagram</option><option>YouTube</option><option>LinkedIn</option><option>Twitter</option><option>Facebook</option>'
      +'</select>'
      +'<input type="url" placeholder="Post URL…" id="vqlink-url-'+id+'" />'
      +'<div style="display:flex;gap:6px"><button class="vq-btn vq-done" onclick="vqAddPostedLink(\\''+id+'\\')">Save Link</button>'
      +'<button class="vq-btn" onclick="document.getElementById(\\'vqlink-form-'+id+'\\').style.display=\\'none\\'">Cancel</button></div>'
      +'</div>';
    var addLinkBtn=VQ_IS_ADMIN?'<button class="vq-btn" onclick="document.getElementById(\\'vqlink-form-'+id+'\\').style.display=document.getElementById(\\'vqlink-form-'+id+'\\').style.display===\\'none\\'?\\'\\':\\'none\\'">+ Link</button>':'';
    body=viewsBadge+linksHtml+errorsHtml+'<div class="vq-actions" style="margin-top:6px">'+refreshBtn+addLinkBtn+'</div>'+addLinkForm;
  }

  var isClientVideo=r.source==='client-portal';
  return '<div class="vq-card">'
    +'<div class="vq-card-top">'+(r.brand&&!isClientVideo?'<span class="vq-brand-chip">'+esc(r.brand)+'</span>':'')
    +(isClientVideo?'<span class="vq-prio-chip" style="background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.3);color:#fbbf24">🧾 '+esc(r.brand||'Client')+'</span>':'')
    +(r.priority==='high'?'<span class="vq-prio-chip vq-prio-high">High</span>':'')
    +(r.shoppable?'<span class="vq-brand-chip" style="background:rgba(0,242,234,.08);border-color:rgba(0,242,234,.25);color:var(--cyan)">🛒 Shoppable</span>':'')
    +'</div>'
    +'<div class="vq-title">'+esc(r.title||'Untitled')+'</div>'
    +(r.status==='pending'&&(r.quantity||1)>1?'<div style="display:inline-flex;align-items:center;gap:4px;background:rgba(0,242,234,.1);border:1px solid rgba(0,242,234,.2);border-radius:10px;padding:2px 8px;font-size:10px;font-weight:700;color:var(--cyan);margin-bottom:4px">📦 '+(r.quantity)+' videos</div>':'')
    +'<div class="vq-meta">'+date+'</div>'
    +body
    +'</div>';
}

var _vqBufferId=null;
function vqOpenBufferModal(id){
  _vqBufferId=id;
  var r=VQ_DATA.find(function(x){return x.id===id;});
  if(r){
    var caption=(r.title||'')+(r.description?' — '+r.description:'');
    document.getElementById('vq-buf-caption').value=caption.slice(0,280);
  }
  document.getElementById('vq-buf-err').style.display='none';
  document.getElementById('vq-buffer-modal').style.display='flex';
}
function vqCloseBufferModal(){
  document.getElementById('vq-buffer-modal').style.display='none';
  _vqBufferId=null;
}
function vqApproveShoppable(id,btn){
  var caption=(document.getElementById('vqcap-'+id)||{}).value||'';
  var status=document.getElementById('vqtts-post-'+id)&&document.getElementById('vqtts-post-'+id).classList.contains('vq-primary')?'posting':'scheduled';
  if(btn){btn.disabled=true;btn.textContent='Moving…';}
  fetch('/api/video-requests/'+id,{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({status:'approved',caption:caption,tiktokShopStatus:status,platforms:['TikTok Shop']})})
  .then(function(r){return r.json();}).then(function(d){
    if(btn){btn.disabled=false;btn.textContent='✓ Move to Scheduled';}
    if(d.ok){toast('Moved to Scheduled ✓');loadVideoQueue();}
    else toast('Error: '+(d.error||'Server error'),8000);
  }).catch(function(e){if(btn){btn.disabled=false;btn.textContent='✓ Move to Scheduled';}toast('Error: '+e,8000);});
}
function vqSetTiktokStatus(id,status){
  var schedBtn=document.getElementById('vqtts-sched-'+id);
  var postBtn=document.getElementById('vqtts-post-'+id);
  if(schedBtn&&postBtn){
    schedBtn.className='vq-btn'+(status==='scheduled'?' vq-schedule':'');
    postBtn.className='vq-btn'+(status==='posting'?' vq-primary':'');
  }
  // If card is already in approved state, persist immediately
  var r=VQ_DATA.find(function(x){return x.id===id;});
  if(r&&r.status==='approved'){
    fetch('/api/video-requests/'+id,{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({tiktokShopStatus:status})})
    .then(function(res){return res.json();}).then(function(d){if(d.ok)loadVideoQueue();});
  }
}
function vqMarkPosted(id){
  if(!confirm('Mark this TikTok Shop video as posted?'))return;
  fetch('/api/video-requests/'+id,{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({status:'posted'})})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){toast('Marked as Posted ✓');loadVideoQueue();}
    else toast('Error: '+(d.error||'Server error'),8000);
  });
}
function vqSubmitBuffer(){
  var caption=(document.getElementById('vq-buf-caption').value||'').trim();
  var scheduled=document.getElementById('vq-buf-schedule').value||'';
  var errEl=document.getElementById('vq-buf-err');
  if(!caption){errEl.textContent='Caption is required';errEl.style.display='block';return;}
  if(!_vqBufferId)return;
  errEl.style.display='none';
  fetch('/api/video-requests/'+_vqBufferId+'/post-buffer',{
    method:'POST',credentials:'include',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({caption:caption,scheduledAt:scheduled})
  }).then(function(r){return r.json();}).then(function(d){
    if(d.ok){
      vqCloseBufferModal();
      toast('Sent to Buffer!');
      loadVideoQueue();
    }else{
      errEl.textContent=d.error||'Failed to post to Buffer';
      errEl.style.display='block';
    }
  }).catch(function(e){errEl.textContent=''+e;errEl.style.display='block';});
}

function vqMoveStatus(id,status){
  fetch('/api/video-requests/'+id,{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:status})})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){loadVideoQueue();}else toast('Error: '+(d.error||'Failed'));
  }).catch(function(e){toast(''+e);});
}

function vqPatch(id,data,onOk){
  fetch('/api/video-requests/'+id,{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){if(onOk)onOk();else loadVideoQueue();}else toast('Error: '+(d.error||'Failed'));
  }).catch(function(e){toast(''+e);});
}

// Convert a stored timestamp/ISO string to the format datetime-local inputs expect,
// using the device's local timezone (not UTC like .toISOString() would give).
function toLocalInputDT(val){
  if(!val)return '';
  var d=new Date(val);
  if(isNaN(d.getTime()))return '';
  var pad=function(n){return String(n).padStart(2,'0');};
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
}

// Move an approved (Scheduled) card back to For Review so the schedule can be edited.
// Also clear channelSchedules so stale per-channel times don't pre-populate the form.
function vqCancelBufferPosts(id){
  if(!confirm('Cancel the scheduled Buffer posts for this video? The card will stay in Scheduled but the posts will be deleted from Buffer.'))return;
  toast('Cancelling Buffer posts…');
  fetch('/api/video-requests/'+id+'/cancel-buffer',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'}})
  .then(function(r){return r.json();}).then(function(d){
    var n=d.cancelled||0;
    toast(n>0?'✓ Cancelled '+n+' Buffer post'+(n===1?'':'s'):'No active Buffer posts found');
    vqPatch(id,{bufferPosts:[]},function(){loadVideoQueue();});
  }).catch(function(e){toast('⚠ '+e);});
}

function vqEditSchedule(id){
  if(!confirm('Move this back to For Review so you can edit the schedule? The existing Buffer posts will be cancelled.'))return;
  toast('Cancelling Buffer posts…');
  fetch('/api/video-requests/'+id+'/cancel-buffer',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'}})
  .then(function(r){return r.json();}).then(function(d){
    if(d.cancelled>0)toast('Cancelled '+d.cancelled+' Buffer post'+(d.cancelled===1?'':'s'));
    vqPatch(id,{status:'done',channelSchedules:[],bufferPosts:[]},function(){loadVideoQueue();});
  }).catch(function(){
    vqPatch(id,{status:'done',channelSchedules:[],bufferPosts:[]},function(){loadVideoQueue();});
  });
}

function vqSaveNotes(id){
  var ta=document.getElementById('vqnotes-ta-'+id);
  if(!ta)return;
  vqPatch(id,{notes:ta.value},function(){
    var r=VQ_DATA.find(function(x){return x.id===id;});
    if(r)r.notes=ta.value;
    loadVideoQueue();
  });
}

function vqSubmitDraft(id){
  var inp=document.getElementById('vqdraft-url-'+id);
  if(!inp)return;
  var url=(inp.value||'').trim();
  if(!url){toast('Paste the Drive link first','yellow');return;}
  vqPatch(id,{status:'done',draftUrl:url});
}

// When master caption changes, sync to any channel caption that hasn't been manually edited
function vqSyncCaptions(id){
  var masterCap=document.getElementById('vqcap-'+id);
  if(!masterCap)return;
  var val=masterCap.value;
  var form=document.getElementById('vqform-'+id);
  if(!form)return;
  form.querySelectorAll('.vq-ch-cap').forEach(function(ta){
    // Only sync if the textarea is empty or still matches the previous master value
    if(!ta.dataset.edited)ta.value=val;
  });
}
// Mark a channel caption as manually edited so sync skips it
function vqMarkCapEdited(ta){ta.dataset.edited='1';}

// When default date changes, populate empty channel overrides
function vqSyncSchedule(id){
  var masterSched=document.getElementById('vqsched-'+id);
  if(!masterSched)return;
  var val=masterSched.value;
  var form=document.getElementById('vqform-'+id);
  if(!form)return;
  form.querySelectorAll('.vq-ch-sched').forEach(function(inp){
    if(!inp.value)inp.value=val;
  });
}

// Show/hide per-channel detail when checkbox toggled; sync master caption in
function vqSelectAllChannels(id,btn){
  var form=document.getElementById('vqform-'+id);
  if(!form)return;
  var checks=form.querySelectorAll('.vq-ch-check');
  var allOn=Array.from(checks).every(function(c){return c.checked;});
  checks.forEach(function(c){
    if(c.checked===allOn){
      c.checked=!allOn;
      vqToggleChannel(id,c.closest('.vq-ch-row').dataset.ch,c);
    }
  });
  btn.textContent=allOn?'Select all':'Deselect all';
}

function vqToggleChannel(id,chId,chk){
  var row=document.getElementById('vqch-'+id+'-'+chId);
  if(!row)return;
  // Show the Edit button when checked; hide detail and reset button when unchecked
  var editBtn=row.querySelector('.vq-ch-edit-btn');
  if(editBtn)editBtn.style.display=chk.checked?'':'none';
  var detail=row.querySelector('.vq-ch-detail');
  if(detail&&!chk.checked){detail.style.display='none';}
  if(chk.checked){
    // Sync master caption into this channel's textarea if it's empty
    var masterCap=document.getElementById('vqcap-'+id);
    var ta=row.querySelector('.vq-ch-cap');
    if(ta&&masterCap&&!ta.value)ta.value=masterCap.value;
    // Sync master schedule if override is empty
    var masterSched=document.getElementById('vqsched-'+id);
    var si=row.querySelector('.vq-ch-sched');
    if(si&&masterSched&&!si.value)si.value=masterSched.value;
  }
}

function vqExpandChannel(id,chId,btn){
  var row=document.getElementById('vqch-'+id+'-'+chId);
  if(!row)return;
  var detail=row.querySelector('.vq-ch-detail');
  if(!detail)return;
  var open=detail.style.display!=='none';
  detail.style.display=open?'none':'block';
  btn.textContent=open?'▾ Edit':'▴ Hide';
}

function vqApproveSchedule(id,btn){
  var errEl=document.getElementById('vqsched-err-'+id);
  var masterCap=(document.getElementById('vqcap-'+id)||{}).value||'';
  var videoTitle=((document.getElementById('vqvtitle-'+id)||{}).value||'').trim();
  var defaultSched=(document.getElementById('vqsched-'+id)||{}).value||'';
  var form=document.getElementById('vqform-'+id);
  var setLoading=function(on){if(btn){btn.disabled=on;btn.textContent=on?'⏳ Scheduling…':'✓ Approve & Schedule in Buffer';}};

  // Collect checked channels with their per-channel caption + time
  var channelSchedules=[];
  if(form){
    form.querySelectorAll('.vq-ch-row').forEach(function(row){
      var chk=row.querySelector('.vq-ch-check');
      if(!chk||!chk.checked)return;
      var chId=row.dataset.ch;
      var ta=row.querySelector('.vq-ch-cap');
      var si=row.querySelector('.vq-ch-sched');
      var cap=(ta?ta.value:masterCap).trim()||masterCap.trim();
      var schedVal=si?si.value:defaultSched;
      channelSchedules.push({
        channelId:chId,
        caption:cap,
        scheduledAt:schedVal?new Date(schedVal).toISOString():null,
      });
    });
  }

  // Validate
  var showErr=function(msg){if(errEl){errEl.textContent=msg;errEl.style.display='block';}toast('⚠ '+msg);};
  if(!masterCap.trim()){showErr('Write a caption first');return;}
  if(!defaultSched){showErr('Pick a default date & time');return;}
  if(channelSchedules.length===0){showErr('Select at least one channel');return;}
  var missingTime=channelSchedules.filter(function(s){return !s.scheduledAt;});
  if(missingTime.length){showErr('Missing schedule time for some channels');return;}
  if(errEl)errEl.style.display='none';

  var platforms=channelSchedules.map(function(s){
    var ch=VQ_BUFFER_CHANNELS.find(function(c){return c.id===s.channelId;});
    return ch?ch.service:'unknown';
  });

  // Save metadata then send to Buffer
  setLoading(true);
  vqPatch(id,{status:'approved',caption:masterCap.trim(),videoTitle:videoTitle||null,platforms:platforms,scheduledAt:new Date(defaultSched).toISOString(),channelSchedules:channelSchedules},function(){
    fetch('/api/video-requests/'+id+'/post-buffer',{
      method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({channelSchedules:channelSchedules}),
    })
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.error){
        vqPatch(id,{status:'done'},function(){loadVideoQueue();});
        showErr('Buffer error: '+d.error);
        setLoading(false);
      } else {
        var n=d.scheduled||channelSchedules.length;
        toast('✓ Scheduled on '+n+' channel'+(n===1?'':'s')+' in Buffer');
        loadVideoQueue();
      }
    })
    .catch(function(e){
      vqPatch(id,{status:'done'},function(){loadVideoQueue();});
      showErr('Could not reach server: '+e);
      setLoading(false);
    });
  });
}

function vqRequestRevision(id){
  var ta=document.getElementById('vqrev-'+id);
  var notes=(ta?ta.value:'').trim();
  if(!notes){toast('Describe what needs to change first');ta&&ta.focus();return;}
  vqPatch(id,{status:'in-progress',revisionNotes:notes,revisionsRequested:true,revisionRequestedAt:Date.now()},function(){
    toast('↩ Sent back for revision');
    loadVideoQueue();
  });
}

function vqRefreshLinks(id){
  toast('Fetching links from Buffer…');
  fetch('/api/video-requests/'+id+'/fetch-links',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'}})
  .then(function(r){return r.json();}).then(function(d){
    if(d.error){toast('⚠ '+d.error);return;}
    var r=VQ_DATA.find(function(x){return x.id===id;});
    if(r){
      if(d.links)d.links.forEach(function(l){
        r.postedLinks=r.postedLinks||[];
        var ex=r.postedLinks.find(function(e){return e.url===l.url;});
        if(ex){ex.views=l.views;}else{r.postedLinks.push(l);}
      });
      if(d.errors)r.linkErrors=d.errors;
      if(d.totalViews!=null)r.totalViews=d.totalViews;
    }
    var got=d.links&&d.links.length;
    var views=d.totalViews||0;
    var firstErr=d.errors&&d.errors.length?d.errors[0]:'';
    toast(got?'✓ '+got+' link'+(got===1?'':'s')+' · '+views.toLocaleString()+' total views':firstErr?'⚠ '+firstErr:'No live links yet — try again after posts go out');
    renderVideoQueue();
  }).catch(function(e){toast('⚠ '+e);});
}

function vqAddPostedLink(id){
  var plat=document.getElementById('vqlink-plat-'+id);
  var url=document.getElementById('vqlink-url-'+id);
  if(!url)return;
  var u=(url.value||'').trim();
  if(!u){toast('Paste the post URL first');return;}
  var r=VQ_DATA.find(function(x){return x.id===id;});
  var existing=(r&&r.postedLinks)||[];
  existing.push({platform:plat?plat.value:'Unknown',url:u});
  vqPatch(id,{postedLinks:existing});
}

function vqDelete(id){
  if(!confirm('Delete this video request?'))return;
  fetch('/api/video-requests/'+id,{method:'DELETE',credentials:'include'})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){loadVideoQueue();}else toast('Error: '+(d.error||'Failed'));
  }).catch(function(e){toast(''+e);});
}

function vqOpenDrive(id){
  var r=VQ_DATA.find(function(x){return x.id===id;});
  if(r&&r.driveUrl)window.open(r.driveUrl,'_blank');
}

function vqFootageTab(mode){
  var isUpload=mode==='upload';
  document.getElementById('vq-footage-upload').style.display=isUpload?'':'none';
  document.getElementById('vq-footage-link').style.display=isUpload?'none':'';
  document.getElementById('vq-ftab-upload').classList.toggle('active',isUpload);
  document.getElementById('vq-ftab-link').classList.toggle('active',!isUpload);
}

var VQ_QUEUED_FILES=[];
var _vqFileId=0;

function vqHandleDrop(e){
  e.preventDefault();
  document.getElementById('vq-drop-zone').classList.remove('drag');
  Array.from(e.dataTransfer.files).forEach(function(f){vqAddFile(f);});
}

function vqHandleFiles(fileList){
  var files=Array.from(fileList);
  // Reset input so selecting the same file again re-triggers onchange
  var inp=document.getElementById('vq-file-input');
  if(inp)inp.value='';
  if(!files.length){vqSetStatus('No files received — swipe down to close Photos and try again','yellow');return;}
  vqSetStatus('Adding '+files.length+' file'+(files.length>1?'s':'')+'…','yellow');
  files.forEach(function(f){vqAddFile(f);});
}

function vqAddFile(file){
  var id=_vqFileId++;
  var entry={id:id,name:file.name,url:null,pct:0,status:'uploading'};
  VQ_QUEUED_FILES.push(entry);
  vqRenderFileList();
  // Step 1: get a presigned R2 URL from our server
  fetch('/api/video-requests/r2-upload-url?filename='+encodeURIComponent(file.name)+'&contentType='+encodeURIComponent(file.type||'video/mp4'),{credentials:'include'})
  .then(function(r){return r.json();})
  .then(function(d){
    if(!d.uploadUrl){
      entry.status='error';entry.error=d.error||'Could not get upload URL';
      vqSetStatus(file.name+' — '+entry.error,'red');vqRenderFileList();return;
    }
    // Step 2: PUT directly to R2 (bypasses Cloudflare proxy, no size limit)
    var xhr=new XMLHttpRequest();
    xhr.open('PUT',d.uploadUrl);
    xhr.setRequestHeader('Content-Type',file.type||'video/mp4');
    xhr.upload.onprogress=function(ev){
      if(ev.lengthComputable){entry.pct=Math.round((ev.loaded/ev.total)*100);vqRenderFileList();}
    };
    xhr.onload=function(){
      if(xhr.status>=200&&xhr.status<300){
        entry.url=d.fileUrl;entry.status='done';entry.pct=100;
        vqSetStatus(null);vqRenderFileList();
      }else{
        entry.status='error';entry.error='R2 upload failed (HTTP '+xhr.status+')';
        vqSetStatus(file.name+' upload failed — HTTP '+xhr.status,'red');vqRenderFileList();
      }
    };
    xhr.onerror=function(){
      entry.status='error';entry.error='Network error';
      vqSetStatus(file.name+' — network error','red');vqRenderFileList();
    };
    xhr.send(file);
  })
  .catch(function(e){
    entry.status='error';entry.error=''+e;
    vqSetStatus(file.name+' — '+e,'red');vqRenderFileList();
  });
}

function vqRemoveFile(id){
  VQ_QUEUED_FILES=VQ_QUEUED_FILES.filter(function(f){return f.id!==id;});
  vqRenderFileList();
}

function vqRenderFileList(){
  var el=document.getElementById('vq-file-list');
  if(!el)return;
  if(!VQ_QUEUED_FILES.length){el.innerHTML='';return;}
  el.innerHTML=VQ_QUEUED_FILES.map(function(f){
    var statusHtml=f.status==='uploading'
      ?'<span style="color:var(--cyan);font-size:11px;white-space:nowrap">'+f.pct+'%…</span>'
      :f.status==='done'
      ?'<span style="color:#6be86b;font-size:11px;white-space:nowrap">✓ Ready</span>'
      :'<span style="color:var(--red);font-size:11px;white-space:nowrap">✕ '+esc(f.error||'Error')+'</span>';
    return '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(255,255,255,.05);border-radius:8px;font-size:13px">'
      +'<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(f.name)+'</span>'
      +statusHtml
      +'<button type="button" class="vq-btn" style="font-size:10px;padding:2px 8px;flex-shrink:0" onclick="vqRemoveFile('+f.id+')">✕</button>'
      +'</div>';
  }).join('');
}

function vqClearUpload(){
  VQ_QUEUED_FILES=[];
  vqRenderFileList();
  var inp=document.getElementById('vq-file-input');
  if(inp)inp.value='';
}

function vpSwitchSection(sec){
  document.getElementById('vp-section-videos').style.display=sec==='videos'?'':'none';
  document.getElementById('vp-section-podcast').style.display=sec==='podcast'?'':'none';
  document.getElementById('vp-stab-videos').classList.toggle('active',sec==='videos');
  document.getElementById('vp-stab-podcast').classList.toggle('active',sec==='podcast');
  if(sec==='podcast')loadPodcastApplications();
}

var _vpPodFilter='pending';
var VP_RECORDED_STATUSES=['recorded','processing','processed','done'];
function vpPodcastFilter(status){
  _vpPodFilter=status;
  ['pending','approved','scheduled','recorded','all'].forEach(function(s){
    var el=document.getElementById('vp-ptab-'+s);
    if(el)el.classList.toggle('active',s===status);
  });
  renderPodcastApplications();
}

var VPP_DATA=[];
function loadPodcastApplications(){
  fetch('/api/podcast-applications',{credentials:'include'})
  .then(function(r){return r.json();}).then(function(d){
    VPP_DATA=d.applications||[];
    var pending=VPP_DATA.filter(function(a){return a.status==='pending';}).length;
    var badge=document.getElementById('vp-podcast-badge');
    if(badge){badge.textContent=pending;badge.style.display=pending?'':'none';}
    // Update tab counts
    var countMap={pending:0,approved:0,scheduled:0,recorded:0,all:VPP_DATA.length};
    VPP_DATA.forEach(function(a){
      var s=a.status||'pending';
      if(s==='pending')countMap.pending++;
      else if(s==='approved')countMap.approved++;
      else if(s==='scheduled')countMap.scheduled++;
      else if(VP_RECORDED_STATUSES.indexOf(s)>=0)countMap.recorded++;
    });
    ['pending','approved','scheduled','recorded','all'].forEach(function(s){
      var el=document.getElementById('vp-ptab-cnt-'+s);
      if(!el)return;
      var n=countMap[s]||0;
      el.textContent=n;el.style.display=n?'':'none';
    });
    // Auto-transition: scheduled guests whose recording time passed > 30min ago → recorded
    var now=Date.now();
    var toRecord=VPP_DATA.filter(function(a){
      return a.status==='scheduled'&&a.scheduledAt&&(now-new Date(a.scheduledAt).getTime())>30*60*1000;
    });
    if(toRecord.length){
      Promise.all(toRecord.map(function(a){
        return fetch('/api/podcast-applications/'+a.id,{method:'PATCH',credentials:'include',
          headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'recorded'})}).catch(function(){});
      })).then(function(){
        if(_vpPodFilter==='scheduled'||_vpPodFilter==='recorded'||_vpPodFilter==='all')loadPodcastApplications();
      });
      return;
    }
    // Sync missing scheduledAt dates from GHL for any scheduled guests
    var needsDate=VPP_DATA.filter(function(a){return a.status==='scheduled'&&!a.scheduledAt;});
    if(needsDate.length){
      fetch('/api/podcast-applications/sync-ghl-dates',{method:'POST',credentials:'include'})
      .then(function(r){return r.json();}).then(function(r){
        if(r.updated>0)loadPodcastApplications();else renderPodcastApplications();
      }).catch(function(){renderPodcastApplications();});
      return;
    }
    renderPodcastApplications();
  }).catch(function(e){document.getElementById('vp-podcast-list').innerHTML='<div class="vq-empty">Could not load applications</div>';});
}

function renderPodcastApplications(){
  var list=_vpPodFilter==='all'?VPP_DATA:VPP_DATA.filter(function(a){
    if(_vpPodFilter==='recorded')return VP_RECORDED_STATUSES.indexOf(a.status)>=0;
    return a.status===_vpPodFilter;
  });
  if(!list.length){document.getElementById('vp-podcast-list').innerHTML='<div class="vq-empty">No '+(_vpPodFilter==='all'?'':_vpPodFilter+' ')+'applications</div>';return;}
  document.getElementById('vp-podcast-list').innerHTML=list.map(vpPodCardHtml).join('');
}

function vpPodCardHtml(a){
  var id=esc(a.id||'');
  var statusClass='vp-pod-status-'+(a.status||'pending');
  var statusLabel=(a.status||'pending').charAt(0).toUpperCase()+(a.status||'pending').slice(1);
  var date=a.submittedAt?new Date(a.submittedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'';
  var actions='';
  if(a.status==='pending'){
    actions='<button class="vq-btn vq-approve" onclick="vpApprovePod(\\''+id+'\\')">✓ Approve</button>'
           +'<button class="vq-btn" style="color:var(--red)" onclick="vpRejectPod(\\''+id+'\\')">✕ Decline</button>';
  }
  if(a.status==='approved'){
    actions='<button class="vq-btn vq-post" onclick="vpSchedulePod(\\''+id+'\\')">📅 Schedule</button>'
           +'<button class="vq-btn" style="color:var(--red)" onclick="vpRejectPod(\\''+id+'\\')">✕ Decline</button>';
  }
  if(a.status==='scheduled'){
    // Only show manual Recorded button if no date is set (can't auto-transition without it)
    if(!a.scheduledAt){
      actions='<button class="vq-btn vq-done" onclick="vpMarkRecorded(\\''+id+'\\')">✓ Recorded</button>'
             +'<button class="vq-btn" style="font-size:11px" onclick="vpSyncGhlDate(\\''+id+'\\')" title="Pull appointment date from GHL">🔄 Sync Date</button>';
    }
    if(a.riversideUrl){
      actions+='<a href="'+esc(a.riversideUrl)+'" target="_blank" class="vq-btn vq-drive">🎙 Open Riverside</a>';
      actions+='<button class="vq-btn" style="font-size:11px" onclick="vpResendRiversideEmail(\\''+id+'\\')">📧 Resend Link</button>';
    }
  }
  if(a.status==='recorded'){
    actions='<button class="vq-btn vq-primary" onclick="vpEditScheduleEpisode(\\''+id+'\\')">📅 Schedule Release</button>'
           +'<button class="vq-btn" style="background:rgba(0,242,234,.12);color:var(--cyan);border-color:rgba(0,242,234,.3)" onclick="vpProcessEpisode(\\''+id+'\\')">🎬 Process Episode</button>';
  }
  if(a.status==='processing'){
    actions='<div style="font-size:11px;color:var(--muted);padding:4px 0">✂️ Shorts being edited from this episode</div>';
    if(a.episodePageUrl)actions+='<a href="'+esc(a.episodePageUrl)+'" target="_blank" class="vq-btn vq-drive">▶ View Episode</a>';
  }
  if(a.status==='processed'){
    actions='<div style="font-size:11px;color:#6be86b;margin-bottom:6px">✓ Post-production complete — clips in Video Queue</div>';
    if(a.episodePageUrl)actions+='<a href="'+esc(a.episodePageUrl)+'" target="_blank" class="vq-btn vq-drive">▶ View Episode</a> ';
    actions+='<button class="vq-btn vq-primary" onclick="vpSetPodStatus(\\''+id+'\\',\\'done\\')">→ Mark Done</button>';
  }
  // Admin delete button (all statuses)
  var deleteBtn='<button class="vq-btn" style="color:var(--red);margin-left:auto" onclick="vpDeletePod(\\''+id+'\\')">✕ Delete</button>';

  var availMap={'weekday-morning':'Weekday mornings','weekday-afternoon':'Weekday afternoons','weekday-evening':'Weekday evenings','weekend-morning':'Weekend mornings','weekend-afternoon':'Weekend afternoons'};
  var availLine=(a.availability&&a.availability.length)?'<div style="font-size:11px;color:var(--muted);margin-bottom:6px">🕐 Available: '+a.availability.map(function(v){return availMap[v]||v;}).join(', ')+'</div>':'';
  var schedLine=a.scheduledAt
    ?'<div style="font-size:12px;font-weight:600;color:#f59e0b;margin-bottom:6px">🎙 Recording: '+new Date(a.scheduledAt).toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+'</div>'
    :(a.status==='scheduled'?'<div style="font-size:11px;color:var(--muted);margin-bottom:6px">📅 No recording date — use 🔄 Sync Date to pull from GHL</div>':'');
  var releaseLine=a.releaseDate?'<div style="font-size:11px;color:#6be86b;margin-bottom:6px">📅 Release: '+new Date(a.releaseDate).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+'</div>':'';
  var topicLine=a.topics?'<div class="vp-pod-body">'+esc(a.topics)+'</div>':'';
  var pitchLine=a.pitch?'<div class="vp-pod-body" style="font-style:italic">"'+esc(a.pitch)+'"</div>':'';
  // Episode links (shown for recorded/processing/processed)
  var linksHtml='';
  if(VP_RECORDED_STATUSES.indexOf(a.status)>=0){
    var links=[];
    if(a.ytVideoId)links.push('<a href="https://youtu.be/'+esc(a.ytVideoId)+'" target="_blank" class="vq-btn vq-drive" style="font-size:11px">▶ YouTube</a>');
    if(a.spotifyUrl)links.push('<a href="'+esc(a.spotifyUrl)+'" target="_blank" class="vq-btn vq-drive" style="font-size:11px">🎵 Spotify</a>');
    if(a.applePodcastUrl)links.push('<a href="'+esc(a.applePodcastUrl)+'" target="_blank" class="vq-btn vq-drive" style="font-size:11px">🎙 Apple</a>');
    if(a.episodePageUrl)links.push('<a href="'+esc(a.episodePageUrl)+'" target="_blank" class="vq-btn vq-drive" style="font-size:11px">🌐 Page</a>');
    if(links.length)linksHtml='<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">'+links.join('')+'</div>';
    // Metrics
    var metrics=[];
    if(a.ytViews!=null)metrics.push('<span>▶ '+Number(a.ytViews).toLocaleString()+' views</span>');
    if(a.ytLikes!=null)metrics.push('<span>👍 '+Number(a.ytLikes).toLocaleString()+'</span>');
    if(a.ytComments!=null)metrics.push('<span>💬 '+Number(a.ytComments).toLocaleString()+'</span>');
    if(metrics.length)linksHtml+='<div style="display:flex;gap:12px;font-size:11px;color:var(--muted);margin-bottom:6px">'+metrics.join('')+'</div>';
  }
  return '<div class="vp-pod-card">'
    +'<div class="vp-pod-card-top">'
    +'<div><div class="vp-pod-name">'+esc(a.name||'Unknown')+'</div>'
    +'<div class="vp-pod-handle">'+esc(a.email||'')+(a.social?' · '+esc(a.social):'')+(a.role?' · '+esc(a.role):'')+'</div></div>'
    +'<span class="vp-pod-status '+statusClass+'">'+statusLabel+'</span>'
    +'</div>'
    +availLine+schedLine+releaseLine+topicLine+pitchLine+linksHtml
    +'<div class="vp-pod-meta">Applied '+date+'</div>'
    +'<div class="vq-actions" style="flex-wrap:wrap">'+actions+deleteBtn+'</div>'
    +'</div>';
}

function vpApprovePod(id){vpSetPodStatus(id,'approved');}
function vpRejectPod(id){if(confirm('Decline this application?'))vpSetPodStatus(id,'rejected');}
function vpMarkRecorded(id){vpSetPodStatus(id,'recorded');}
function vpSyncGhlDate(id){
  var btn=event.target;btn.textContent='Syncing…';btn.disabled=true;
  fetch('/api/podcast-applications/sync-ghl-dates',{method:'POST',credentials:'include'})
  .then(function(r){return r.json();}).then(function(d){
    if(d.updated>0){toast('✓ Date synced from GHL');loadPodcastApplications();}
    else{toast('No appointment found in GHL for this guest');btn.textContent='🔄 Sync Date';btn.disabled=false;}
  }).catch(function(e){toast(''+e);btn.textContent='🔄 Sync Date';btn.disabled=false;});
}
function vpDeletePod(id){
  var a=VPP_DATA.find(function(x){return x.id===id;});
  if(!a)return;
  if(!confirm('Permanently delete '+esc(a.name||'this applicant')+'? This cannot be undone.'))return;
  fetch('/api/podcast-applications/'+id,{method:'DELETE',credentials:'include'})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){toast('Deleted');VPP_DATA=VPP_DATA.filter(function(x){return x.id!==id;});renderPodcastApplications();}
    else toast('Error: '+(d.error||'Failed'));
  }).catch(function(e){toast(''+e);});
}
function vpResendRiversideEmail(id){
  if(!confirm('Re-send the Riverside recording link to this guest?'))return;
  fetch('/api/podcast-applications/'+id+'/send-riverside',{method:'POST',credentials:'include'})
  .then(function(r){return r.json();}).then(function(d){
    toast(d.ok?'📧 Riverside link sent!':'Error: '+(d.error||'Failed'));
  }).catch(function(e){toast(''+e);});
}
function vpEditScheduleEpisode(id){
  _vpSchedId=id;
  _vpSchedMode='release';
  document.getElementById('vp-sched-modal-title').textContent='Schedule Episode Release';
  document.getElementById('vp-sched-dt-label').textContent='Release Date & Time';
  document.getElementById('vp-sched-notes-label').innerHTML='Notes to editor <span style="font-weight:400;color:var(--muted)">(optional)</span>';
  document.getElementById('vp-sched-riverside-wrap').style.display='none';
  document.getElementById('vp-sched-err').style.display='none';
  var a=VPP_DATA.find(function(x){return x.id===id;});
  document.getElementById('vp-sched-dt').value=a&&a.releaseDate?new Date(a.releaseDate).toISOString().slice(0,16):'';
  document.getElementById('vp-sched-riverside').value='';
  document.getElementById('vp-sched-notes').value=a&&a.editorNotes?a.editorNotes:'';
  document.getElementById('vp-schedule-modal').style.display='flex';
}
function vpProcessEpisode(id){
  if(!confirm('Queue this episode for automated post-production?\\n\\nClaude will:\\n• Find the Riverside recording\\n• Remove fillers, pauses, clean audio\\n• Apply brand, captions, color\\n• Export full episode to Riverside Hosting\\n• Extract 3–5 short clips → Video Queue'))return;
  fetch('/api/podcast-applications/'+id+'/process-episode',{method:'POST',credentials:'include'})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){toast('Episode queued for processing — Claude will pick it up shortly');loadPodcastApplications();}
    else toast('Error: '+(d.error||'Failed'));
  }).catch(function(e){toast(''+e);});
}
function vpSetPodStatus(id,status){
  fetch('/api/podcast-applications/'+id,{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:status})})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){loadPodcastApplications();}else toast('Error: '+(d.error||'Failed'));
  }).catch(function(e){toast(''+e);});
}

var _vpSchedId=null;
var _vpSchedMode='schedule'; // 'schedule' = set recording time; 'release' = set episode release date
function vpSchedulePod(id){
  _vpSchedId=id;
  _vpSchedMode='schedule';
  document.getElementById('vp-sched-modal-title').textContent='Schedule Recording';
  document.getElementById('vp-sched-dt-label').textContent='Recording Date & Time';
  document.getElementById('vp-sched-notes-label').innerHTML='Notes to guest <span style="font-weight:400;color:var(--muted)">(optional)</span>';
  document.getElementById('vp-sched-riverside-wrap').style.display='';
  document.getElementById('vp-sched-err').style.display='none';
  document.getElementById('vp-sched-dt').value='';
  document.getElementById('vp-sched-riverside').value='';
  document.getElementById('vp-sched-notes').value='';
  document.getElementById('vp-schedule-modal').style.display='flex';
}
function vpCloseScheduleModal(){document.getElementById('vp-schedule-modal').style.display='none';_vpSchedId=null;}

function vpOpenAddGuest(){
  document.getElementById('vpag-name').value='';
  document.getElementById('vpag-email').value='';
  document.getElementById('vpag-status').value='pending';
  document.getElementById('vpag-dt').value='';
  document.getElementById('vpag-riverside').value='';
  document.getElementById('vpag-notes').value='';
  document.getElementById('vpag-err').style.display='none';
  vpagToggleScheduleFields();
  document.getElementById('vp-addguest-modal').style.display='flex';
}
function vpCloseAddGuest(){document.getElementById('vp-addguest-modal').style.display='none';}
function vpagToggleScheduleFields(){
  var s=document.getElementById('vpag-status').value;
  var show=s==='scheduled';
  document.getElementById('vpag-schedule-fields').style.display=show?'':'none';
  document.getElementById('vpag-note').style.display=show?'block':'none';
}
function vpSubmitAddGuest(){
  var name=document.getElementById('vpag-name').value.trim();
  var email=document.getElementById('vpag-email').value.trim();
  var status=document.getElementById('vpag-status').value;
  var dt=document.getElementById('vpag-dt').value;
  var riverside=document.getElementById('vpag-riverside').value.trim();
  var notes=document.getElementById('vpag-notes').value.trim();
  var errEl=document.getElementById('vpag-err');
  if(!name||!email){errEl.textContent='Name and email are required';errEl.style.display='block';return;}
  errEl.style.display='none';
  var body={name:name,email:email,status:status,notes:notes};
  if(status==='scheduled'&&dt)body.scheduledAt=new Date(dt).toISOString();
  if(riverside)body.riversideUrl=riverside;
  fetch('/api/podcast-applications/manual-add',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  .then(function(r){return r.json();}).then(function(d){
    if(d.ok){
      vpCloseAddGuest();
      toast('Guest added'+(status==='scheduled'&&riverside?' — Riverside link emailed':''));
      loadPodcastApplications();
    }else{errEl.textContent=d.error||'Failed';errEl.style.display='block';}
  }).catch(function(e){errEl.textContent=''+e;errEl.style.display='block';});
}
function vpSubmitSchedule(){
  var dt=document.getElementById('vp-sched-dt').value;
  var riverside=document.getElementById('vp-sched-riverside').value||'';
  var notes=document.getElementById('vp-sched-notes').value||'';
  var errEl=document.getElementById('vp-sched-err');
  if(!dt){errEl.textContent='Please select a date and time';errEl.style.display='block';return;}
  if(!_vpSchedId)return;
  errEl.style.display='none';
  var payload=_vpSchedMode==='release'
    ?{releaseDate:new Date(dt).toISOString(),editorNotes:notes}
    :{status:'scheduled',scheduledAt:new Date(dt).toISOString(),riversideUrl:riverside,scheduleNotes:notes};
  fetch('/api/podcast-applications/'+_vpSchedId,{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  }).then(function(r){return r.json();}).then(function(d){
    if(d.ok){vpCloseScheduleModal();toast(_vpSchedMode==='release'?'Release date set!':'Recording scheduled!');loadPodcastApplications();}
    else{errEl.textContent=d.error||'Failed';errEl.style.display='block';}
  }).catch(function(e){errEl.textContent=''+e;errEl.style.display='block';});
}

function vqSetStatus(msg,color){
  var el=document.getElementById('vq-status-banner');
  if(!el)return;
  if(!msg){el.style.display='none';el.textContent='';return;}
  el.style.display='block';
  el.style.background=color==='red'?'rgba(255,0,80,.12)':color==='green'?'rgba(0,242,100,.1)':'rgba(255,159,10,.1)';
  el.style.border='1px solid '+(color==='red'?'rgba(255,0,80,.3)':color==='green'?'rgba(0,242,100,.25)':'rgba(255,159,10,.3)');
  el.style.color=color==='red'?'#ff4d6d':color==='green'?'#6be86b':'#ffd60a';
  el.textContent=msg;
}
function vqPickQty(n){
  for(var i=1;i<=10;i++){var el=document.getElementById('vqqty-'+i);if(el)el.classList.toggle('on',i===n);}
  var inp=document.getElementById('vq-qty');if(inp)inp.value=n;
}

function submitVideoRequest(){
  vqSetStatus(null);
  var btn=document.querySelector('#vq-submit-form .btn');
  var uploading=VQ_QUEUED_FILES.filter(function(f){return f.status==='uploading';});
  var doneFiles=VQ_QUEUED_FILES.filter(function(f){return f.status==='done';});
  var errFiles=VQ_QUEUED_FILES.filter(function(f){return f.status==='error';});
  var pastedUrl=(document.getElementById('vq-drive').value||'').trim();
  if(uploading.length){vqSetStatus('Still uploading — please wait','yellow');return;}
  if(!doneFiles.length&&!pastedUrl){
    if(errFiles.length){vqSetStatus('Upload failed: '+errFiles.map(function(f){return f.error;}).join(', '),'red');}
    else{vqSetStatus('Add at least one video or paste a Drive link','yellow');}
    return;
  }
  var desc=(document.getElementById('vq-desc').value||'').trim();
  var qty=parseInt((document.getElementById('vq-qty')||{}).value||'1',10)||1;
  var shoppable=!!(document.getElementById('vq-shoppable')&&document.getElementById('vq-shoppable').checked);
  var requests=doneFiles.length
    ?doneFiles.map(function(f){return {title:f.name,description:desc,driveUrl:f.url,priority:'normal',quantity:1,shoppable:shoppable};})
    :[{title:'Footage '+new Date().toLocaleDateString('en-US',{month:'short',day:'numeric'}),description:desc,driveUrl:pastedUrl,priority:'normal',quantity:qty,shoppable:shoppable}];
  var total=requests.length;
  if(btn){btn.disabled=true;btn.textContent='Submitting…';}
  function done(err){
    if(btn){btn.disabled=false;btn.textContent='Submit';}
    if(err){vqSetStatus('Submit failed: '+err,'red');toast('Error: '+err,8000);return;}
    document.getElementById('vq-desc').value='';
    document.getElementById('vq-drive').value='';
    vqClearUpload();
    toast(total===1?'Video submitted!':total+' videos submitted!');
    loadVideoQueue();
  }
  function submitNext(i){
    if(i>=total){done(null);return;}
    fetch('/api/video-requests',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(requests[i])})
    .then(function(r){return r.json();}).then(function(d){
      if(d.ok)submitNext(i+1);
      else done(d.error||'Server error');
    }).catch(function(e){done(''+e);});
  }
  submitNext(0);
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
    if(!t){if(++done===total){toast('Done');load();}return;}
    var body={task:'Copy: '+(t.task||'Untitled'),status:'To Do',priority:t.priority||'🟡 Normal',ownerOpenId:t.ownerOpenId||'',clientRecordId:t.clientRecordId||'',pillar:t.pillar||''};
    fetch('/api/admin/tasks/create',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(){if(++done===total){toast('✅ Duplicated '+total+' task'+(total>1?'s':''));SELECTED.clear();load();}})
    .catch(function(){if(++done===total){toast('⚠ Some duplicates may have failed');SELECTED.clear();load();}});
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

load();

/* ── Team Management ─────────────────────────────────── */
var TM_DATA=null,TM_CURRENT_EMAIL=null,TM_IS_ADMIN=false;
var TM_AVATAR_COLORS=['#7b2fff','#00f2ea','#ff0050','#f59e0b','#3b82f6','#ec4899','#10b981'];
function tmAvatarColor(name){
  var i=0;for(var c=0;c<name.length;c++)i+=name.charCodeAt(c);
  return TM_AVATAR_COLORS[i%TM_AVATAR_COLORS.length];
}
function tmInitials(name){return (name||'?').split(' ').map(function(w){return w[0]||'';}).join('').slice(0,2).toUpperCase();}
function tmTenure(startDate){
  if(!startDate)return '—';
  var s=new Date(startDate),n=new Date();
  var months=(n.getFullYear()-s.getFullYear())*12+(n.getMonth()-s.getMonth());
  if(months<1)return '<1 mo';
  if(months<12)return months+' mo';
  var yrs=Math.floor(months/12),mos=months%12;
  return yrs+'y'+(mos?' '+mos+'m':'');
}

/* ── More Tools ───────────────────────────────────────── */
var MT_DATA=null,MT_EDIT_ID=null;
function loadMoreTools(){
  MT_DATA=null;
  fetch('/api/my-tasks/tools',{credentials:'include'})
  .then(function(r){return r.json();}).then(function(d){
    MT_DATA=d.tools||[];
    renderMoreTools();
  }).catch(function(){document.getElementById('mt-grid').innerHTML='<div style="color:var(--muted);font-size:12px">Failed to load tools</div>';});
}
function renderMoreTools(){
  var g=document.getElementById('mt-grid');
  if(!g)return;
  var readOnly=!!DEV_AS;
  var h='';
  (MT_DATA||[]).forEach(function(t){
    h+='<a href="'+esc(t.url)+'" target="_blank" rel="noopener" class="mt-card" style="position:relative">';
    if(!readOnly){
      h+='<button class="mt-dots" onclick="event.preventDefault();event.stopPropagation();mtToggleMenu(\\''+esc(t.id)+'\\')" title="Options">⋯</button>'
        +'<div class="mt-menu" id="mt-menu-'+esc(t.id)+'" style="display:none">'
        +'<button class="mt-menu-item" onclick="event.preventDefault();event.stopPropagation();mtOpenEdit(\\''+esc(t.id)+'\\')">✏ Edit</button>'
        +'<button class="mt-menu-item" style="color:var(--red)" onclick="event.preventDefault();event.stopPropagation();mtDelete(\\''+esc(t.id)+'\\')">✕ Delete</button>'
        +'</div>';
    }
    h+='<div class="mt-card-emoji">'+esc(t.emoji||'🔧')+'</div>'
      +'<div class="mt-card-name">'+esc(t.name)+'</div>'
      +'</a>';
  });
  if(!readOnly){
    h+='<button class="mt-card mt-card-add" onclick="mtOpenModal()">'
      +'<div class="mt-card-emoji">+</div>'
      +'<div class="mt-card-name" style="color:inherit">Add a Tool</div>'
      +'</button>';
  }
  g.innerHTML=h;
}
function mtCloseMenus(){document.querySelectorAll('.mt-menu').forEach(function(m){m.style.display='none';});}
function mtToggleMenu(id){
  var m=document.getElementById('mt-menu-'+id);if(!m)return;
  var wasOpen=m.style.display!=='none';mtCloseMenus();
  if(!wasOpen){m.style.display='block';setTimeout(function(){document.addEventListener('click',mtCloseMenus,{once:true});},0);}
}
function mtOpenModal(){MT_EDIT_ID=null;document.getElementById('mt-modal-title').textContent='Add a Tool';document.getElementById('mt-emoji').value='';document.getElementById('mt-name').value='';document.getElementById('mt-url').value='';document.getElementById('mt-modal').style.display='flex';}
function mtOpenEdit(id){
  var t=(MT_DATA||[]).find(function(x){return x.id===id;});if(!t)return;
  MT_EDIT_ID=id;document.getElementById('mt-modal-title').textContent='Edit Tool';
  document.getElementById('mt-emoji').value=t.emoji||'';document.getElementById('mt-name').value=t.name||'';document.getElementById('mt-url').value=t.url||'';
  document.getElementById('mt-modal').style.display='flex';
}
function mtCloseModal(){document.getElementById('mt-modal').style.display='none';MT_EDIT_ID=null;}
function mtSave(){
  var emoji=document.getElementById('mt-emoji').value.trim()||'🔧';
  var name=document.getElementById('mt-name').value.trim();
  var url=document.getElementById('mt-url').value.trim();
  if(!name||!url)return alert('Name and link are required');
  if(url.slice(0,4)!=='http')return alert('Link must start with https://');
  var method=MT_EDIT_ID?'PUT':'POST';
  var ep=MT_EDIT_ID?'/api/my-tasks/tools/'+encodeURIComponent(MT_EDIT_ID):'/api/my-tasks/tools';
  fetch(ep,{method:method,credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({emoji:emoji,name:name,url:url})})
  .then(function(r){return r.json();}).then(function(d){
    if(!d.ok)return alert(d.error||'Failed to save');
    MT_DATA=d.tools;mtCloseModal();renderMoreTools();
  }).catch(function(){alert('Failed to save tool');});
}
function mtDelete(id){
  if(!confirm('Remove this tool?'))return;
  fetch('/api/my-tasks/tools/'+encodeURIComponent(id),{method:'DELETE',credentials:'include'})
  .then(function(r){return r.json();}).then(function(d){
    if(!d.ok)return alert(d.error||'Failed');
    MT_DATA=d.tools;renderMoreTools();
  }).catch(function(){alert('Failed to remove tool');});
}

function loadTeamMgmt(){
  if(TM_DATA)return renderTeamGrid();
  if(CB_IS_ADMIN&&!DEV_AS)loadTeamSummaryBanner();
  fetch('/api/admin/team/members',{credentials:'include'})
  .then(function(r){return r.json();}).then(function(d){
    TM_DATA=d.members||[];
    TM_IS_ADMIN=!!d.isAdmin;
    renderTeamGrid();
  }).catch(function(e){document.getElementById('tm-grid').innerHTML='<div style="color:var(--muted);font-size:12px">Failed to load team: '+e+'</div>';});
}

function renderTeamGrid(){
  var grid=document.getElementById('tm-grid');
  if(!TM_DATA||!TM_DATA.length){grid.innerHTML='<div style="color:var(--muted);font-size:12px">No team members found.</div>';return;}
  grid.innerHTML=TM_DATA.map(function(m){
    var color=tmAvatarColor(m.name);
    var initials=tmInitials(m.name);
    var tenure=tmTenure(m.startDate);
    var spend=m.base?('$'+(m.base+(m.bonusDollars||0)).toLocaleString()):('$'+(m.bonusDollars||0).toLocaleString());
    var openTasks=(m.openTasks||0);
    var anthropic=m.anthropicUsage?('$'+Number(m.anthropicUsage).toFixed(0)):'—';
    // KPI progress: take first gate as primary
    var kpiHtml='';
    var gates=m.gateDetails||[];
    if(gates.length){
      var g=gates[0];
      var raw=g.value||0;
      var maxVal=g.hit||1;
      var pct=Math.min(100,Math.round((raw/maxVal)*100));
      kpiHtml='<div class="tm-kpi-row">'
        +'<span style="font-size:10px;color:var(--muted);min-width:80px;flex-shrink:0">'+esc(g.label)+'</span>'
        +'<div class="tm-kpi-bar-bg"><div class="tm-kpi-bar-fill" style="width:'+pct+'%"></div></div>'
        +'<span style="font-size:10px;color:var(--muted);min-width:40px;text-align:right">'+raw+' / '+g.hit+'</span>'
        +'</div>';
    }
    return '<div class="tm-card" onclick="tmOpenModal(\\''+esc(m.email)+'\\')">'
      +'<div class="tm-card-top">'
      +'<div class="tm-avatar" style="background:'+color+'">'+initials+'</div>'
      +'<div><div class="tm-name">'+esc(m.name)+'</div><div class="tm-role">'+esc(m.role||'—')+'</div></div>'
      +'</div>'
      +'<div class="tm-stats">'
      +'<div class="tm-stat"><div class="n" style="font-size:13px">'+tenure+'</div><div class="l">Tenure</div></div>'
      +'<div class="tm-stat"><div class="n" style="font-size:13px">'+spend+'</div><div class="l">Mo. Spend</div></div>'
      +'<div class="tm-stat"><div class="n">'+openTasks+'</div><div class="l">Open Tasks</div></div>'
      +'<div class="tm-stat"><div class="n" style="font-size:13px">'+anthropic+'</div><div class="l">Anthropic</div></div>'
      +'</div>'
      +kpiHtml
      +'<div style="display:flex;gap:8px;margin-top:10px">'
      +'<button class="vq-btn" style="flex:1;font-size:11px" onclick="event.stopPropagation();tmOpenModal(\\''+esc(m.email)+'\\')">👤 Profile</button>'
      +'<a class="vq-btn vq-drive" style="flex:1;font-size:11px;text-align:center;text-decoration:none" href="/my-tasks?devAs='+encodeURIComponent(m.email)+'" target="_blank" onclick="event.stopPropagation()">👁 View Account</a>'
      +'</div>'
      +'</div>';
  }).join('');
}

function tmOpenModal(email){
  TM_CURRENT_EMAIL=email;
  var m=TM_DATA&&TM_DATA.find(function(x){return x.email===email;});
  if(!m)return;
  var color=tmAvatarColor(m.name);
  document.getElementById('tmm-avatar').textContent=tmInitials(m.name);
  document.getElementById('tmm-avatar').style.background=color;
  document.getElementById('tmm-name').textContent=m.name;
  document.getElementById('tmm-role').textContent=(m.role||'—')+(m.timezone?' · '+m.timezone:'');
  // Contact
  document.getElementById('tmm-contact').innerHTML=
    '<div class="tm-contact-item"><strong>Email</strong>'+esc(m.email)+'</div>'
    +'<div class="tm-contact-item"><strong>Timezone</strong>'+(m.timezone||'—')+'</div>'
    +(m.phone?'<div class="tm-contact-item"><strong>Phone</strong>'+esc(m.phone)+'</div>':'')
    +(m.startDate?'<div class="tm-contact-item"><strong>Start Date</strong>'+esc(m.startDate)+'</div>':'');
  // Stats detail
  var spend=(m.base||0)+(m.bonusDollars||0);
  document.getElementById('tmm-stats-detail').innerHTML=
    '<div class="tm-stats" style="grid-template-columns:1fr 1fr 1fr 1fr">'
    +'<div class="tm-stat"><div class="n" style="font-size:13px">'+tmTenure(m.startDate)+'</div><div class="l">Tenure</div></div>'
    +'<div class="tm-stat"><div class="n" style="font-size:13px">'+(m.base?'$'+m.base.toLocaleString():'—')+'</div><div class="l">Base</div></div>'
    +'<div class="tm-stat"><div class="n" style="font-size:13px">'+(m.bonusDollars?'$'+m.bonusDollars.toLocaleString():'$0')+'</div><div class="l">Bonus</div></div>'
    +'<div class="tm-stat"><div class="n">'+(m.openTasks||0)+'</div><div class="l">Open Tasks</div></div>'
    +'</div>';
  // KPI gates
  var gates=m.gateDetails||[];
  var kpiSec=document.getElementById('tmm-kpi-section');
  var kpiEl=document.getElementById('tmm-kpis');
  if(gates.length){
    kpiSec.style.display='';
    kpiEl.innerHTML=gates.map(function(g){
      var raw=g.value||0;var maxVal=g.hit||1;
      var pct=Math.min(100,Math.round((raw/maxVal)*100));
      var floorPos=Math.round(((g.floor||0)/maxVal)*100);
      var cls=g.score>=1?'var(--cyan)':g.score>=0.5?'#f59e0b':'var(--muted)';
      return '<div style="margin-bottom:10px">'
        +'<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px"><span>'+esc(g.label)+'</span><span style="color:'+cls+'">'+raw+' / '+g.hit+'</span></div>'
        +'<div style="height:5px;background:var(--border);border-radius:3px;overflow:hidden;position:relative">'
        +'<div style="height:100%;width:'+pct+'%;background:'+cls+';border-radius:3px;transition:width .5s"></div>'
        +'<div style="position:absolute;top:0;bottom:0;left:'+floorPos+'%;width:1px;background:rgba(255,255,255,.3)"></div>'
        +'</div></div>';
    }).join('');
  } else { kpiSec.style.display='none'; }
  // AI Overview
  document.getElementById('tmm-ai-overview').textContent=m.aiOverview||'No overview generated yet.';
  var aiUp=document.getElementById('tmm-ai-updated');
  aiUp.textContent=m.aiOverviewUpdatedAt?'Updated '+new Date(m.aiOverviewUpdatedAt).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';
  // Notes
  var notesSec=document.getElementById('tmm-notes-section');
  if(TM_IS_ADMIN){
    notesSec.style.display='';
    document.getElementById('tmm-notes-ta').value=m.notes||'';
  } else { notesSec.style.display='none'; }
  // Recent calls
  document.getElementById('tmm-calls').innerHTML='<div style="color:var(--muted);font-size:12px">Loading…</div>';
  document.getElementById('tm-modal').style.display='flex';
  // Fetch calls async
  fetch('/api/admin/team/members/'+encodeURIComponent(email)+'/calls',{credentials:'include'})
  .then(function(r){return r.json();}).then(function(d){
    var calls=d.calls||[];
    var el=document.getElementById('tmm-calls');
    if(!el)return;
    if(!calls.length){el.innerHTML='<div style="color:var(--muted);font-size:12px">No recent calls found.</div>';return;}
    el.innerHTML=calls.slice(0,6).map(function(c){
      return '<div class="tm-call-item">'
        +'<div class="tm-call-title">'+esc(c.title||'Untitled')+'</div>'
        +'<div class="tm-call-meta">'+(c.date?new Date(c.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'')+' · '+(c.duration?Math.round(c.duration/60)+' min':'')+'</div>'
        +(c.summary?'<div style="font-size:11px;color:rgba(255,255,255,.55);margin-top:4px;line-height:1.5">'+esc(c.summary.slice(0,200))+(c.summary.length>200?'…':'')+'</div>':'')
        +'</div>';
    }).join('');
  }).catch(function(){
    var el=document.getElementById('tmm-calls');
    if(el)el.innerHTML='<div style="color:var(--muted);font-size:12px">Could not load calls.</div>';
  });
}

function tmCloseModal(){
  document.getElementById('tm-modal').style.display='none';
  TM_CURRENT_EMAIL=null;
}

function tmSaveNotes(){
  if(!TM_CURRENT_EMAIL)return;
  var notes=document.getElementById('tmm-notes-ta').value||'';
  fetch('/api/admin/team/members/'+encodeURIComponent(TM_CURRENT_EMAIL),{
    method:'PATCH',credentials:'include',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({notes:notes})
  }).then(function(r){return r.json();}).then(function(d){
    if(d.ok){
      var m=TM_DATA&&TM_DATA.find(function(x){return x.email===TM_CURRENT_EMAIL;});
      if(m)m.notes=notes;
      toast('Notes saved');
    } else toast('Error: '+(d.error||'Failed'));
  });
}

function tmRefreshOverviews(){
  var btn=document.getElementById('tm-refresh-btn');
  if(btn){btn.disabled=true;btn.textContent='Generating…';}
  fetch('/api/admin/team/members/ai-overviews',{method:'POST',credentials:'include'})
  .then(function(r){return r.json();}).then(function(d){
    if(btn){btn.disabled=false;btn.textContent='↻ Refresh AI Overviews';}
    if(d.ok){TM_DATA=null;loadTeamMgmt();toast('AI overviews updated ✓');}
    else toast('Error: '+(d.error||'Failed'),8000);
  }).catch(function(e){
    if(btn){btn.disabled=false;btn.textContent='↻ Refresh AI Overviews';}
    toast(''+e,8000);
  });
}

load();

</script>

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
  const CLAUDE_QUEUE_FILE = nodePath.join(DATA_DIR, 'claude-queue.json');
  function readClaudeQueue() {
    try { return JSON.parse(fs.readFileSync(CLAUDE_QUEUE_FILE, 'utf8')); } catch (_) { return []; }
  }
  function writeClaudeQueue(q) {
    fs.writeFileSync(CLAUDE_QUEUE_FILE, JSON.stringify(q, null, 2));
  }
  const WR_FILE = nodePath.join(DATA_DIR, 'weekly-reports.json');
  const ST_FILE = nodePath.join(DATA_DIR, 'subtasks.json');
  const NET_SALES_FILE = nodePath.join(DATA_DIR, 'net-sales.json');
  const VR_FILE = nodePath.join(DATA_DIR, 'video-requests.json');

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
      const FORMER_MEMBERS = new Set(['hasan','hassan','shayan','daniel']);
      // Canonical team with roles — looked up by email when not in the Lark table
      const KNOWN_TEAM = [
        { name: 'Jenna', email: 'jenna@cultcontent.cc', role: 'Affiliate Manager' },
        { name: 'Jina',  email: 'jina@cultcontent.cc',  role: 'Creator Lead' },
        { name: 'Becca', email: 'becca@cultcontent.cc', role: 'Affiliate Manager' },
        { name: 'Gourab', email: 'gourab@cultcontent.cc', role: 'Shop Manager' },
        { name: 'Gilbert', email: 'gilbert@cultcontent.cc', role: 'Video Editor' },
      ];
      // Look up open IDs for team members by email via Lark contact API
      const emailLookup = await larkPost('/open-apis/contact/v3/users/batch_get_id', {
        emails: KNOWN_TEAM.map(m => m.email),
      }).catch(() => null);
      const emailToOpenId = {};
      if (emailLookup && emailLookup.data && emailLookup.data.email_users) {
        for (const [email, users] of Object.entries(emailLookup.data.email_users)) {
          if (Array.isArray(users) && users[0] && users[0].open_id) {
            emailToOpenId[email.toLowerCase()] = users[0].open_id;
          }
        }
      }

      const items = (data.data && data.data.items) || [];
      const seenOpenIds = new Set();
      const team = [];

      // Add from Lark table first
      for (const it of items) {
        const f = it.fields || {};
        if (f.Active === false) continue;
        const rawName = (textVal(f.Name) || textVal(f.name) || '').toLowerCase().split(' ')[0];
        if (FORMER_MEMBERS.has(rawName)) continue;
        const openId = textVal(f['Open ID']) || textVal(f['open_id']) || textVal(f['OpenID']) ||
          (Array.isArray(f.Person) && f.Person[0] && f.Person[0].id) ||
          (Array.isArray(f['Lark User']) && f['Lark User'][0] && f['Lark User'][0].id) || '';
        if (!openId) continue;
        seenOpenIds.add(openId);
        // Override role with canonical role if known
        const canonical = KNOWN_TEAM.find(m => m.name.toLowerCase() === rawName);
        team.push({
          name: textVal(f.Name) || textVal(f.name) ||
            (Array.isArray(f.Person) && f.Person[0] && (f.Person[0].name || f.Person[0].en_name)) ||
            (Array.isArray(f['Lark User']) && f['Lark User'][0] && (f['Lark User'][0].name || f['Lark User'][0].en_name)) || openId,
          openId,
          role: (canonical && canonical.role) || textVal(f.Role) || textVal(f.role) || '',
        });
      }

      // Add KNOWN_TEAM members not already in the list (resolved by email lookup)
      for (const m of KNOWN_TEAM) {
        const openId = emailToOpenId[m.email.toLowerCase()];
        if (!openId || seenOpenIds.has(openId)) continue;
        team.push({ name: m.name, openId, role: m.role });
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

  // ---------- ROUTE: POST /api/my-tasks/reassign-claude ----------
  // Reassign a task to Claude Code. Pushes to the claude-queue + sends a Lark ping.
  app.post('/api/my-tasks/reassign-claude', requireAuth, jsonBody, async (req, res) => {
    try {
      const { record_id, task, productId, productName, priority } = req.body || {};
      if (!record_id) return res.status(400).json({ error: 'record_id required' });

      // Push to persistent claude queue
      const queue = readClaudeQueue();
      const entry = {
        id: record_id,
        status: 'pending',
        task: task || record_id,
        larkRecordId: record_id,
        productId: productId || '',
        productName: productName || '',
        priority: priority || '🟡 Normal',
        createdAt: new Date().toISOString(),
        result: null,
      };
      const idx = queue.findIndex(q => q.id === record_id);
      if (idx >= 0) queue[idx] = entry; else queue.push(entry);
      writeClaudeQueue(queue);

      // Send Lark notification
      const RAILWAY_URL = process.env.RAILWAY_URL || 'https://cultcontent-server-production.up.railway.app';
      const lines = [
        '🤖 *Task assigned to Claude Code*',
        '',
        `*Task:* ${task || record_id}`,
        productName ? `*Product:* ${productName}` : null,
        `*Priority:* ${priority || '🟡 Normal'}`,
        `*Record ID:* \`${record_id}\``,
        '',
        'Claude Code will pick this up on its next check.',
      ].filter(Boolean).join('\n');
      fetch(`${RAILWAY_URL}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: lines }),
      }).catch(e => console.error('[ops-my-tasks] lark ping failed:', e.message));

      res.json({ ok: true });
    } catch (e) {
      console.error('[ops-my-tasks] reassign-claude error:', e.message);
      res.status(500).json({ error: 'Failed to queue task for Claude Code', detail: e.message });
    }
  });

  // ---------- ROUTE: POST /api/my-tasks/claude-queue ----------
  // Directly enqueue a task for Claude Code. Auth: Bearer CLAUDE_CODE_SECRET.
  app.post('/api/my-tasks/claude-queue', jsonBody, (req, res) => {
    const secret = process.env.CLAUDE_CODE_SECRET;
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!secret || auth !== secret) return res.status(401).json({ error: 'Unauthorized' });
    const { task, productId, productName, priority, larkRecordId } = req.body || {};
    if (!task) return res.status(400).json({ error: 'task is required' });
    const id = larkRecordId || ('manual_' + Date.now());
    const queue = readClaudeQueue();
    const entry = {
      id, status: 'pending', task,
      larkRecordId: larkRecordId || null,
      productId: productId || '', productName: productName || '',
      priority: priority || '🟡 Normal',
      createdAt: new Date().toISOString(), result: null,
    };
    const idx = queue.findIndex(q => q.id === id);
    if (idx >= 0) queue[idx] = entry; else queue.push(entry);
    writeClaudeQueue(queue);
    res.json({ ok: true, task: entry });
  });

  // ---------- ROUTE: GET /api/my-tasks/claude-queue ----------
  // Returns pending tasks for Claude Code. Auth: Bearer CLAUDE_CODE_SECRET.
  app.get('/api/my-tasks/claude-queue', (req, res) => {
    const secret = process.env.CLAUDE_CODE_SECRET;
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!secret || auth !== secret) return res.status(401).json({ error: 'Unauthorized' });
    const queue = readClaudeQueue();
    res.json({ queue: queue.filter(t => t.status === 'pending') });
  });

  // ---------- ROUTE: PATCH /api/my-tasks/claude-queue/:id ----------
  // Claim or complete a task. Auth: Bearer CLAUDE_CODE_SECRET.
  app.patch('/api/my-tasks/claude-queue/:id', jsonBody, (req, res) => {
    const secret = process.env.CLAUDE_CODE_SECRET;
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!secret || auth !== secret) return res.status(401).json({ error: 'Unauthorized' });
    const queue = readClaudeQueue();
    const task = queue.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const allowed = ['status', 'result', 'claimedAt', 'completedAt'];
    for (const k of allowed) { if (req.body[k] !== undefined) task[k] = req.body[k]; }
    writeClaudeQueue(queue);
    res.json({ ok: true, task });
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

      // Fire matchmaking completion email (non-fatal).
      const taskTitleForEmail = textVal(afterFields.Task) || '';
      const promptActionForEmail = textVal(afterFields['Prompt / Action']) || '';
      if (textVal(existingFields.Source) === 'creator-matchmaking') {
        sendMatchmakingCompleteEmail({ taskTitle: taskTitleForEmail, promptAction: promptActionForEmail })
          .catch(e => console.error('[matchmaking complete email]', e.message));
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

  // ---------- ROUTE: GET /task-management → redirect to /my-tasks (admin tab) ----------
  app.get('/task-management', requireAuth, (req, res) => {
    res.redirect('/my-tasks');
  });

  // ---------- ROUTE: GET /my-tasks (HTML page) ----------
  // The per-person task board. Auth-gated. Renders a dark-theme page that
  // fetches /api/my-tasks/list on load, groups tasks by Priority, offers a
  // Pillar filter, and completes tasks via a modal with a CLIENT-SIDE
  // required-result guard (submit disabled until the textarea is non-empty).
  app.get('/my-tasks', requireAuth, async (req, res) => {
    try {
      const email = effectiveEmail(req).toLowerCase();
      const isAdmin = ADMIN_EMAILS.has(email);
      const role = await resolveUserRole(email);
      const modules = isAdmin
        ? (ROLE_MODULES[role] || []).concat(ROLE_MODULES['admin'] || [])
        : (ROLE_MODULES[role] || []);
      const isEditor = modules.includes('video-queue-editor');
      const hasVqAdmin = modules.includes('video-queue-admin') || isAdmin;
      const tabLabel = isEditor ? 'Video Queue' : 'Video Production';
      const html = MY_TASKS_HTML
        .replace('window.__VQ_IS_EDITOR__=false;', `window.__VQ_IS_EDITOR__=${isEditor};`)
        .replace('window.__VQ_IS_ADMIN__=false;', `window.__VQ_IS_ADMIN__=${hasVqAdmin};`)
        .replace('__VQ_TAB_LABEL__', tabLabel)
        .replace('window.__USER_ROLE__="";', `window.__USER_ROLE__="${role}";`)
        .replace('window.__USER_MODULES__=[];', `window.__USER_MODULES__=${JSON.stringify(modules)};`);
      res.type('html').send(html);
    } catch (e) {
      console.error('[my-tasks] page serve error:', e.message);
      res.status(500).type('html').send('<p style="font-family:sans-serif;padding:40px">Error loading page. Try refreshing.</p>');
    }
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
    'jina@cultcontent.cc': 'Jina',
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
  app.get('/ops/my-tasks', requireAuth, async (req, res) => {
    try {
      const email = effectiveEmail(req).toLowerCase();
      const isAdmin = ADMIN_EMAILS.has(email);
      const role = await resolveUserRole(email);
      const modules = isAdmin
        ? (ROLE_MODULES[role] || []).concat(ROLE_MODULES['admin'] || [])
        : (ROLE_MODULES[role] || []);
      const isEditor = modules.includes('video-queue-editor');
      const hasVqAdmin = modules.includes('video-queue-admin') || isAdmin;
      const tabLabel = isEditor ? 'Video Queue' : 'Video Production';
      const html = MY_TASKS_HTML
        .replace('window.__VQ_IS_EDITOR__=false;', `window.__VQ_IS_EDITOR__=${isEditor};`)
        .replace('window.__VQ_IS_ADMIN__=false;', `window.__VQ_IS_ADMIN__=${hasVqAdmin};`)
        .replace('__VQ_TAB_LABEL__', tabLabel)
        .replace('window.__USER_ROLE__="";', `window.__USER_ROLE__="${role}";`)
        .replace('window.__USER_MODULES__=[];', `window.__USER_MODULES__=${JSON.stringify(modules)};`);
      res.type('html').send(html);
    } catch (e) {
      console.error('[ops/my-tasks] page serve error:', e.message);
      res.status(500).type('html').send('<p style="font-family:sans-serif;padding:40px">Error loading page. Try refreshing.</p>');
    }
  });

  // ---------- ROLE MODULE SYSTEM ----------
  // Maps Lark role names (normalized to kebab-case) to the modules the user sees.
  const ROLE_MODULES = {
    'video-editor':      ['video-queue-editor'],
    'brand-manager':     [],
    'community-manager': [],
    'developer':         [],
    'affiliate-manager': [],
    'shop-manager':      [],
    'admin':             ['video-queue-admin'],
    'member':            [],
  };
  // Email fallback (used when Lark table has no Email field or lookup fails)
  const EMAIL_ROLES = {
    'gilbert@cultcontent.cc':  'video-editor',
    'gourab@cultcontent.cc':   'brand-manager',
    'jina@cultcontent.cc':     'community-manager',
    'becca@cultcontent.cc':    'community-manager',
    'jenna@cultcontent.cc':    'community-manager',
    'daniel@cultcontent.cc':   'developer',
    'tommy@cultcontent.cc':    'admin',
  };
  const _roleCache = new Map(); // email → { role, expiresAt }
  const ROLE_CACHE_TTL = 10 * 60 * 1000;

  async function resolveUserRole(email) {
    const hit = _roleCache.get(email);
    if (hit && Date.now() < hit.expiresAt) return hit.role;
    // Try Lark Team table (looks for Email field)
    try {
      const data = await larkGet(
        `/open-apis/bitable/v1/apps/${OPS_APP_TOKEN}/tables/${TEAM_TABLE}/records`,
        { page_size: 100 }
      );
      const items = (data.data && data.data.items) || [];
      for (const it of items) {
        const f = it.fields || {};
        const rowEmail = (textVal(f.Email) || textVal(f.email) || '').toLowerCase();
        if (rowEmail && rowEmail === email) {
          const raw = textVal(f.Role) || textVal(f.role) || '';
          const role = raw.toLowerCase().replace(/\s+/g, '-') || 'member';
          _roleCache.set(email, { role, expiresAt: Date.now() + ROLE_CACHE_TTL });
          return role;
        }
      }
    } catch (e) {
      console.warn('[my-tasks] role Lark lookup failed:', e.message);
    }
    // Fallback to EMAIL_ROLES map
    const role = EMAIL_ROLES[email] || 'member';
    _roleCache.set(email, { role, expiresAt: Date.now() + ROLE_CACHE_TTL });
    return role;
  }

  // ---------- ROUTE: GET /api/video-requests ----------
  // Returns video requests. Supports two auth paths:
  //   1. CF Access session (staff/admin/editor) — full access with role-based filtering
  //   2. Bearer CLAUDE_CODE_SECRET (portal server) — must supply ?clientBrandId= to scope to one brand
  // Honors ?devAs= so admin dev-mode previews show the correct role flags.
  const VIDEO_EDITOR_EMAILS = new Set(['gilbert@cultcontent.cc']);
  app.get('/api/video-requests', (req, res) => {
    try {
      // Allow portal server-to-server calls with Bearer CLAUDE_CODE_SECRET
      const secret = process.env.CLAUDE_CODE_SECRET;
      const bearerToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const isPortalAgent = secret && bearerToken === secret;

      if (isPortalAgent) {
        const clientBrandId = (req.query.clientBrandId || '').trim();
        if (!clientBrandId) return res.status(400).json({ error: 'clientBrandId query param required for portal requests' });
        const all = readJsonFile(VR_FILE, []);
        const requests = all.filter(r => r.clientBrandId === clientBrandId || r.submittedBy === req.query.submittedBy);
        return res.json({ requests });
      }

      // Staff UI path — set req.userEmail from CF Access header (requireAuth middleware not used here)
      if (!req.userEmail) {
        const cfEmail = req.headers['cf-access-authenticated-user-email'];
        if (cfEmail) {
          req.userEmail = cfEmail;
        } else if (!process.env.CF_ACCESS_AUD) {
          // local dev — no CF Access, allow through
        } else {
          return res.status(401).type('text').send('Session expired — please refresh the page');
        }
      }

      const callerEmail = (req.userEmail || '').toLowerCase();
      const email = effectiveEmail(req); // respects ?devAs for admin
      const isAdmin = ADMIN_EMAILS.has(callerEmail) && callerEmail === email;
      const isEditor = VIDEO_EDITOR_EMAILS.has(email);
      const all = readJsonFile(VR_FILE, []);
      const requests = (isAdmin || isEditor)
        ? all
        : all.filter(r => (r.submittedBy || '').toLowerCase() === email);
      const names = { 'gilbert@cultcontent.cc':'Gilbert', 'jina@cultcontent.cc':'Jina',
        'becca@cultcontent.cc':'Becca', 'jenna@cultcontent.cc':'Jenna',
        'gourab@cultcontent.cc':'Gourab', 'tommy@cultcontent.cc':'Tommy' };
      requests.forEach(r => { if(!r.submittedByName) r.submittedByName = names[r.submittedBy] || r.submittedBy; });
      res.json({ requests, myEmail: email, isEditor, isAdmin });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- ROUTE: POST /api/video-requests ----------
  app.post('/api/video-requests', jsonBody, (req, res) => {
    try {
      // Accept either session auth (dashboard users) or Bearer CLAUDE_CODE_SECRET (agent)
      const secret = process.env.CLAUDE_CODE_SECRET;
      const bearerToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const isAgent = secret && bearerToken === secret;
      const sessionEmail = (req.userEmail || (req.session && req.session.userEmail) || req.headers['cf-access-authenticated-user-email'] || '').toLowerCase();
      if (!isAgent && !sessionEmail) return res.status(401).json({ error: 'Unauthorized' });
      const email = isAgent ? 'claude@cultcontent.cc' : sessionEmail;
      const names = { 'gilbert@cultcontent.cc':'Gilbert', 'jina@cultcontent.cc':'Jina',
        'becca@cultcontent.cc':'Becca', 'jenna@cultcontent.cc':'Jenna',
        'gourab@cultcontent.cc':'Gourab', 'tommy@cultcontent.cc':'Tommy',
        'claude@cultcontent.cc':'Claude' };
      const { brand, title, description, script, driveUrl, priority, dueDate, quantity, clientBrandId, source, shoppable } = req.body || {};
      if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
      // Portal agent submittedBy should be the brand login email, not claude@
      const resolvedEmail = (isAgent && req.body.submittedBy) ? req.body.submittedBy : email;
      const all = readJsonFile(VR_FILE, []);
      const id = 'vr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      all.push({
        id, submittedBy: resolvedEmail, submittedByName: names[resolvedEmail] || resolvedEmail,
        submittedAt: Date.now(), brand: (brand || '').trim(),
        title: title.trim(), description: (description || '').trim(),
        script: (script || '').trim(), driveUrl: (driveUrl || '').trim(),
        priority: priority || 'normal', dueDate: dueDate || '', status: 'pending',
        quantity: Math.min(Math.max(parseInt(quantity, 10) || 1, 1), 10),
        ...(shoppable ? { shoppable: true } : {}),
        ...(clientBrandId ? { clientBrandId: clientBrandId.trim() } : {}),
        ...(source ? { source: source.trim() } : {}),
      });
      writeJsonFile(VR_FILE, all);
      res.json({ ok: true, id });

      // Notify Gilbert on Lark
      const qty = Math.min(Math.max(parseInt(quantity, 10) || 1, 1), 10);
      resolveOpenId('gilbert@cultcontent.cc').then(openId => {
        if (!openId) return;
        const who = names[email] || email;
        const videoWord = qty > 1 ? `${qty} videos` : 'a video';
        const msg = `🎬 New video request from ${who}\n\n${title.trim()}${description ? '\n' + description : ''}\nQuantity: ${videoWord}${driveUrl ? '\nFootage: ' + driveUrl : ''}\n\nhttps://manifest.cultcontent.cc/my-tasks`;
        return sendLarkMessage(openId, msg);
      }).catch(e => console.error('[video-notify] Lark DM failed:', e.message));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- ROUTE: PATCH /api/video-requests/:id ----------
  // Editor or admin can update status; submitter can update their own.
  // Also accepts WEBHOOK_SECRET as Bearer token for agent-submitted patches.
  app.patch('/api/video-requests/:id', jsonBody, (req, res) => {
    try {
      const webhookSecret = process.env.WEBHOOK_SECRET;
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const isWebhookAuth = webhookSecret && bearer === webhookSecret;
      if (!isWebhookAuth && !req.session?.userEmail && !req.headers['cf-access-authenticated-user-email']) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const email = isWebhookAuth ? 'claude@cultcontent.cc' : (req.userEmail || (req.session && req.session.userEmail) || '').toLowerCase();
      const isAdmin = ADMIN_EMAILS.has(email) || isWebhookAuth;
      const isEditor = VIDEO_EDITOR_EMAILS.has(email) || isWebhookAuth;
      const { id } = req.params;
      const all = readJsonFile(VR_FILE, []);
      const idx = all.findIndex(r => r.id === id);
      if (idx < 0) return res.status(404).json({ error: 'Not found' });
      const r = all[idx];
      if (!isAdmin && !isEditor && r.submittedBy !== email)
        return res.status(403).json({ error: 'Not allowed' });
      const { status, notes, draftUrl, caption, videoTitle, platforms, scheduledAt, postedLinks,
              revisionNotes, revisionsRequested, revisionRequestedAt, channelSchedules, bufferPosts,
              tiktokShopStatus } = req.body || {};
      if (notes !== undefined) r.notes = notes;
      if (draftUrl !== undefined) r.draftUrl = draftUrl;
      if (caption !== undefined) r.caption = caption;
      if (videoTitle !== undefined) r.videoTitle = videoTitle;
      if (platforms !== undefined) r.platforms = platforms;
      if (scheduledAt !== undefined) r.scheduledAt = scheduledAt ? new Date(scheduledAt).getTime() : null;
      if (postedLinks !== undefined) r.postedLinks = postedLinks;
      if (channelSchedules !== undefined) r.channelSchedules = channelSchedules;
      if (bufferPosts !== undefined) r.bufferPosts = bufferPosts;
      if (tiktokShopStatus !== undefined) r.tiktokShopStatus = tiktokShopStatus;
      if (revisionNotes !== undefined) r.revisionNotes = revisionNotes;
      if (revisionsRequested !== undefined) r.revisionsRequested = revisionsRequested;
      if (revisionRequestedAt !== undefined) r.revisionRequestedAt = revisionRequestedAt;
      // Clear revision flag when editor marks as ready for review
      if (status === 'done') { r.revisionsRequested = false; r.revisionNotes = null; }
      r.updatedAt = Date.now();

      // When editor starts editing a multi-video batch, expand into N cards
      if (status === 'in-progress' && r.status === 'pending' && (r.quantity || 1) > 1) {
        const qty = Math.min(r.quantity, 10);
        const dateLabel = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        r.status = 'in-progress';
        r.title = `Video 1 — ${dateLabel}`;
        r.expandedAt = Date.now();
        all[idx] = r;
        for (let n = 2; n <= qty; n++) {
          const copy = Object.assign({}, r, {
            id: 'vr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + n,
            title: `Video ${n} — ${dateLabel}`,
            submittedAt: r.submittedAt,
            status: 'in-progress',
          });
          all.push(copy);
        }
      } else {
        if (status) r.status = status;
        all[idx] = r;
        // Revision: move card to front of the array so it appears at top of editing stack
        if (status === 'in-progress' && revisionsRequested) {
          all.splice(idx, 1);
          all.unshift(r);
        }
      }
      writeJsonFile(VR_FILE, all);
      res.json({ ok: true });

      // Fire-and-forget Lark DM to Gilbert when a revision is requested
      if (status === 'in-progress' && revisionsRequested && revisionNotes) {
        resolveOpenId('gilbert@cultcontent.cc').then(openId => {
          if (!openId) return;
          const title = r.title || 'a video';
          const msg = `🔄 Revision requested on "${title}"\n\n${revisionNotes}\n\nCheck the Video Production queue: https://manifest.cultcontent.cc/my-tasks`;
          return sendLarkMessage(openId, msg);
        }).catch(e => console.error('[revision-notify] Lark DM failed:', e.message));
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- ROUTE: POST /api/video-requests/upload-footage ----------
  const multer = require('multer');
  const FOOTAGE_DIR = nodePath.join(DATA_DIR, 'uploads', 'footage');
  if (!fs.existsSync(FOOTAGE_DIR)) fs.mkdirSync(FOOTAGE_DIR, { recursive: true });
  const footageUpload = multer({
    storage: multer.diskStorage({
      destination: FOOTAGE_DIR,
      filename: (req, file, cb) => {
        const ext = nodePath.extname(file.originalname) || '.mp4';
        cb(null, 'footage_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + ext);
      },
    }),
    limits: { fileSize: (parseInt(process.env.FOOTAGE_MAX_MB) || 4096) * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ok = file.mimetype.startsWith('video/') || /\.(mp4|mov|avi|mkv|m4v|webm|flv|wmv)$/i.test(file.originalname);
      cb(ok ? null : new Error('Only video files allowed'), ok);
    },
  }).single('footage');
  const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || process.env.DASHBOARD_URL || 'https://cult-command-center-production.up.railway.app').replace(/\/$/, '');
  app.post('/api/video-requests/upload-footage', requireAuth, (req, res) => {
    footageUpload(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file received' });
      const url = `${PUBLIC_BASE}/uploads/footage/${req.file.filename}`;
      res.json({ ok: true, url, filename: req.file.filename });
    });
  });

  // ---------- ROUTE: GET /api/video-requests/r2-upload-url ----------
  // Returns a presigned R2 PUT URL so the browser can upload directly to R2,
  // bypassing Cloudflare's proxy size limit entirely.
  app.get('/api/video-requests/r2-upload-url', requireAuth, async (req, res) => {
    try {
      const accountId = process.env.R2_ACCOUNT_ID;
      const accessKeyId = process.env.R2_ACCESS_KEY_ID;
      const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
      const bucket = process.env.R2_BUCKET;
      const publicUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
      if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
        return res.status(503).json({ error: 'R2 not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET in env' });
      }
      const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
      const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
      const r2 = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
      });
      const filename = req.query.filename || 'footage.mp4';
      const ext = nodePath.extname(filename) || '.mp4';
      const key = `footage/${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`;
      const contentType = req.query.contentType || 'video/mp4';
      const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
      const uploadUrl = await getSignedUrl(r2, cmd, { expiresIn: 3600 });
      const fileUrl = publicUrl ? `${publicUrl}/${key}` : uploadUrl.split('?')[0];
      res.json({ ok: true, uploadUrl, fileUrl, key });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- PODCAST APPLICATION ROUTES ----------
  const POD_FILE = nodePath.join(DATA_DIR, 'podcast-applications.json');

  function addPodcastGuest({ name, email, status = 'pending', scheduledAt, riversideUrl, topics, notes, source } = {}) {
    if (!name || !email) throw new Error('name and email required');
    const all = readJsonFile(POD_FILE, []);
    const dupe = all.find(a => a.email.toLowerCase() === email.toLowerCase().trim());
    if (dupe) {
      let updated = false;
      if (scheduledAt && !dupe.scheduledAt) { dupe.scheduledAt = scheduledAt; updated = true; }
      if (scheduledAt && dupe.status === 'approved') { dupe.status = 'scheduled'; updated = true; }
      if (updated) writeJsonFile(POD_FILE, all);
      return { ok: true, id: dupe.id, duplicate: true, updated };
    }
    const id = 'pod_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    all.push({
      id, name: name.trim(), email: email.trim().toLowerCase(), status,
      topics: (topics || '').trim(), scheduleNotes: (notes || '').trim(),
      ...(scheduledAt ? { scheduledAt } : {}),
      ...(riversideUrl ? { riversideUrl } : {}),
      ...(source ? { source } : {}),
      submittedAt: Date.now(), addedManually: true,
    });
    writeJsonFile(POD_FILE, all);
    return { ok: true, id };
  }

  // Public POST — no auth required; called from cultcontent.cc application form
  app.post('/api/podcast-applications', jsonBody, (req, res) => {
    res.header('Access-Control-Allow-Origin', 'https://cultcontent.cc');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    try {
      const { name, email, social, role, topics, pitch, availability } = req.body || {};
      if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
      const all = readJsonFile(POD_FILE, []);
      const id = 'pod_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      all.push({ id, name: (name||'').trim(), email: (email||'').trim().toLowerCase(),
        social: (social||'').trim(), role: (role||'').trim(),
        topics: (topics||'').trim(), pitch: (pitch||'').trim(),
        availability: Array.isArray(availability) ? availability : [],
        status: 'pending', submittedAt: Date.now() });
      writeJsonFile(POD_FILE, all);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.options('/api/podcast-applications', (req, res) => {
    res.header('Access-Control-Allow-Origin', 'https://cultcontent.cc');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
  });

  // Admin manual add (bypasses application form, allows pre-setting status)
  // Accepts CF Access session (requireAuth) OR WEBHOOK_SECRET bearer/query param
  app.post('/api/podcast-applications/manual-add', jsonBody, (req, res) => {
    try {
      const webhookSecret = process.env.WEBHOOK_SECRET;
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const isWebhookAuth = webhookSecret && (bearer === webhookSecret || req.query.secret === webhookSecret);
      const callerEmail = (req.userEmail || '').toLowerCase();
      if (!isWebhookAuth && !ADMIN_EMAILS.has(callerEmail)) return res.status(403).json({ error: 'Admin only' });
      const { name, email, status, scheduledAt, riversideUrl, topics, notes } = req.body || {};
      if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
      const all = readJsonFile(POD_FILE, []);
      const id = 'pod_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      all.push({
        id, name: name.trim(), email: email.trim().toLowerCase(),
        status: status || 'pending',
        topics: (topics || '').trim(),
        scheduleNotes: (notes || '').trim(),
        ...(scheduledAt ? { scheduledAt } : {}),
        ...(riversideUrl ? { riversideUrl } : {}),
        submittedAt: Date.now(), addedManually: true,
      });
      writeJsonFile(POD_FILE, all);
      res.json({ ok: true, id });

      // If added directly as scheduled + has a Riverside URL, send the link email
      if ((status === 'scheduled') && riversideUrl) {
        const guest = all[all.length - 1];
        sendPodcastScheduleEmail(guest).catch(e => console.error('[podcast manual add email]', e.message));
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- ROUTE: POST /api/webhooks/add-video-request ----------
  // Webhook-secret authenticated shortcut for adding video queue entries
  // without requiring a session (CF Access bypass covers /api/webhooks/*)
  app.post('/api/webhooks/add-video-request', jsonBody, (req, res) => {
    try {
      const webhookSecret = process.env.WEBHOOK_SECRET;
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const isAuth = webhookSecret && (bearer === webhookSecret || req.query.secret === webhookSecret);
      if (!isAuth) return res.status(401).json({ error: 'Unauthorized' });
      const { title, description, driveUrl, assetsDriveUrl, riversideEditId, priority, source, brand, quantity, costUsd, clientBrandId } = req.body || {};
      if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
      const all = readJsonFile(VR_FILE, []);
      const id = 'vr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const qty = Math.max(1, parseInt(quantity) || 1);
      const cost = costUsd != null ? Number(costUsd) : qty * 10;
      all.push({
        id, submittedBy: 'claude@cultcontent.cc', submittedByName: 'Claude',
        submittedAt: Date.now(), brand: (brand || '').trim(),
        title: title.trim(), description: (description || '').trim(),
        driveUrl: (driveUrl || '').trim(),
        priority: priority || 'normal', status: 'pending', quantity: qty,
        costUsd: cost,
        ...(assetsDriveUrl ? { assetsDriveUrl: assetsDriveUrl.trim() } : {}),
        ...(clientBrandId ? { clientBrandId: clientBrandId.trim() } : {}),
        ...(riversideEditId ? { riversideEditId: riversideEditId.trim() } : {}),
        ...(source ? { source: source.trim() } : {}),
      });
      writeJsonFile(VR_FILE, all);
      res.json({ ok: true, id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- ROUTE: PATCH /api/webhooks/patch-video-request/:id ----------
  // WEBHOOK_SECRET-authenticated status update — bypasses CF Access
  app.patch('/api/webhooks/patch-video-request/:id', jsonBody, (req, res) => {
    try {
      const webhookSecret = process.env.WEBHOOK_SECRET;
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!webhookSecret || bearer !== webhookSecret) return res.status(401).json({ error: 'Unauthorized' });
      const { id } = req.params;
      const all = readJsonFile(VR_FILE, []);
      const idx = all.findIndex(r => r.id === id);
      if (idx < 0) return res.status(404).json({ error: 'Not found' });
      const { status, notes, draftUrl, driveUrl, riversideEditId } = req.body || {};
      if (status) all[idx].status = status;
      if (notes !== undefined) all[idx].notes = notes;
      if (draftUrl !== undefined) all[idx].draftUrl = draftUrl;
      if (driveUrl !== undefined) all[idx].driveUrl = driveUrl;
      if (riversideEditId !== undefined) all[idx].riversideEditId = riversideEditId;
      if (status === 'done') { all[idx].revisionsRequested = false; all[idx].revisionNotes = null; }
      all[idx].updatedAt = Date.now();
      writeJsonFile(VR_FILE, all);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Webhook-auth list for admin tooling (no CF Access session needed)
  app.get('/api/webhooks/list-podcast-applications', (req, res) => {
    try {
      const webhookSecret = process.env.WEBHOOK_SECRET;
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const isAuth = webhookSecret && (bearer === webhookSecret || req.query.secret === webhookSecret);
      if (!isAuth) return res.status(401).json({ error: 'Unauthorized' });
      const all = readJsonFile(POD_FILE, []);
      res.json({ ok: true, applications: all });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Webhook-auth list + delete for video requests (no CF Access session needed)
  app.get('/api/webhooks/list-video-requests', (req, res) => {
    try {
      const webhookSecret = process.env.WEBHOOK_SECRET;
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const isAuth = webhookSecret && (bearer === webhookSecret || req.query.secret === webhookSecret);
      if (!isAuth) return res.status(401).json({ error: 'Unauthorized' });
      const all = readJsonFile(VR_FILE, []);
      res.json({ ok: true, requests: all });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/webhooks/video-request/:id', (req, res) => {
    try {
      const webhookSecret = process.env.WEBHOOK_SECRET;
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const isAuth = webhookSecret && (bearer === webhookSecret || req.query.secret === webhookSecret);
      if (!isAuth) return res.status(401).json({ error: 'Unauthorized' });
      let all = readJsonFile(VR_FILE, []);
      const before = all.length;
      all = all.filter(r => r.id !== req.params.id);
      if (all.length === before) return res.status(404).json({ error: 'Not found' });
      writeJsonFile(VR_FILE, all);
      res.json({ ok: true, removed: before - all.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Webhook-auth patch for podcast applications (find + fix specific records)
  app.patch('/api/webhooks/patch-podcast-application/:id', jsonBody, (req, res) => {
    try {
      const webhookSecret = process.env.WEBHOOK_SECRET;
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const isAuth = webhookSecret && (bearer === webhookSecret || req.query.secret === webhookSecret);
      if (!isAuth) return res.status(401).json({ error: 'Unauthorized' });
      const all = readJsonFile(POD_FILE, []);
      const idx = all.findIndex(r => r.id === req.params.id);
      if (idx < 0) return res.status(404).json({ error: 'Not found' });
      const allowed = ['status','scheduledAt','episodePageUrl','ytVideoId','spotifyUrl','applePodcastUrl','ytViews','ytLikes','ytComments','scheduleNotes','editorNotes'];
      allowed.forEach(k => { if (req.body[k] !== undefined) all[idx][k] = req.body[k]; });
      all[idx].updatedAt = Date.now();
      writeJsonFile(POD_FILE, all);
      res.json({ ok: true, record: all[idx] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET — admin only
  app.get('/api/podcast-applications', requireAuth, (req, res) => {
    try {
      const email = (req.userEmail || '').toLowerCase();
      if (!ADMIN_EMAILS.has(email)) return res.status(403).json({ error: 'Admin only' });
      const all = readJsonFile(POD_FILE, []);
      res.json({ applications: all.slice().reverse() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/podcast-applications/sync-ghl-dates — pull appointment dates from GHL for scheduled guests missing scheduledAt
  app.post('/api/podcast-applications/sync-ghl-dates', requireAuth, async (req, res) => {
    try {
      const callerEmail = (req.userEmail || '').toLowerCase();
      if (!ADMIN_EMAILS.has(callerEmail)) return res.status(403).json({ error: 'Admin only' });

      const GHL_KEY = process.env.GHL_API_KEY;
      const GHL_LOC = process.env.GHL_LOC_ID || process.env.GHL_LOCATION_ID;
      if (!GHL_KEY || !GHL_LOC) return res.json({ updated: 0, reason: 'GHL not configured' });

      const all = readJsonFile(POD_FILE, []);
      const needsDate = all.filter(a => a.status === 'scheduled' && !a.scheduledAt && a.email);
      if (!needsDate.length) return res.json({ updated: 0 });

      const https = require('https');
      function ghlGet(path) {
        return new Promise((resolve, reject) => {
          const opts = { hostname: 'services.leadconnectorhq.com', path, method: 'GET',
            headers: { Authorization: `Bearer ${GHL_KEY}`, Version: '2021-07-28' } };
          const req2 = https.request(opts, r => { let buf = ''; r.on('data', c => buf += c); r.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } }); });
          req2.on('error', reject); req2.end();
        });
      }

      let updated = 0;
      for (const guest of needsDate) {
        try {
          // Find contact by email
          const search = await ghlGet(`/contacts/?locationId=${encodeURIComponent(GHL_LOC)}&query=${encodeURIComponent(guest.email)}&limit=1`);
          const contactId = search.contacts?.[0]?.id;
          if (!contactId) continue;
          // Get their appointments (look ±90 days)
          const start = Date.now() - 90 * 86400000;
          const end   = Date.now() + 90 * 86400000;
          const appts = await ghlGet(`/appointments/?locationId=${encodeURIComponent(GHL_LOC)}&contactId=${encodeURIComponent(contactId)}&startTime=${start}&endTime=${end}`);
          const sorted = (appts.appointments || appts.events || []).sort((a, b) => new Date(a.startTime||a.start) - new Date(b.startTime||b.start));
          const appt = sorted[0];
          if (!appt) continue;
          const scheduledAt = appt.startTime || appt.start;
          if (!scheduledAt) continue;
          const idx = all.findIndex(a => a.id === guest.id);
          if (idx >= 0) { all[idx].scheduledAt = scheduledAt; all[idx].updatedAt = Date.now(); updated++; }
        } catch (_) {}
      }
      if (updated) writeJsonFile(POD_FILE, all);
      res.json({ updated });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PATCH — admin only
  app.patch('/api/podcast-applications/:id', requireAuth, jsonBody, async (req, res) => {
    try {
      const email = (req.userEmail || '').toLowerCase();
      if (!ADMIN_EMAILS.has(email)) return res.status(403).json({ error: 'Admin only' });
      const { id } = req.params;
      const all = readJsonFile(POD_FILE, []);
      const idx = all.findIndex(a => a.id === id);
      if (idx < 0) return res.status(404).json({ error: 'Not found' });
      const updates = req.body || {};
      const wasApproved = all[idx].status !== 'approved' && updates.status === 'approved';
      const wasScheduled = all[idx].status !== 'scheduled' && updates.status === 'scheduled';
      ['status','scheduledAt','riversideUrl','scheduleNotes','releaseDate','editorNotes',
       'ytVideoId','spotifyUrl','applePodcastUrl','episodePageUrl','ytViews','ytLikes','ytComments'].forEach(k => {
        if (updates[k] !== undefined) all[idx][k] = updates[k];
      });
      all[idx].updatedAt = Date.now();
      writeJsonFile(POD_FILE, all);
      res.json({ ok: true });

      // Fire-and-forget GHL approval email
      if (wasApproved) {
        const guest = all[idx];
        sendPodcastApprovalEmail(guest).catch(err => console.error('[podcast email]', err.message));
      }
      // Fire-and-forget Riverside / schedule confirmation email
      if (wasScheduled && all[idx].riversideUrl) {
        const guest = all[idx];
        sendPodcastScheduleEmail(guest).catch(err => console.error('[podcast schedule email]', err.message));
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/podcast-applications/:id — admin only
  app.delete('/api/podcast-applications/:id', requireAuth, (req, res) => {
    try {
      const email = (req.userEmail || '').toLowerCase();
      if (!ADMIN_EMAILS.has(email)) return res.status(403).json({ error: 'Admin only' });
      const { id } = req.params;
      const all = readJsonFile(POD_FILE, []);
      const idx = all.findIndex(a => a.id === id);
      if (idx < 0) return res.status(404).json({ error: 'Not found' });
      all.splice(idx, 1);
      writeJsonFile(POD_FILE, all);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  async function sendMatchmakingCompleteEmail({ taskTitle, promptAction }) {
    const GHL_KEY = process.env.GHL_API_KEY;
    const GHL_LOC = process.env.GHL_LOC_ID || process.env.GHL_LOCATION_ID;
    if (!GHL_KEY || !GHL_LOC) { console.warn('[matchmaking email] GHL_API_KEY or GHL_LOCATION_ID not set — skipping'); return; }

    // Parse brand email from promptAction text: "Contact: email@example.com"
    const emailMatch = promptAction.match(/Contact:\s*([^\n\r]+)/i);
    const brandEmail = emailMatch ? emailMatch[1].trim() : null;
    if (!brandEmail) { console.warn('[matchmaking email] No Contact email found in promptAction — skipping'); return; }

    // Parse brand name from task title: "Generate affiliate link — BrandName"
    const brandName = taskTitle.replace(/^Generate affiliate link\s*[—-]\s*/i, '').trim() || 'there';

    const https = require('https');
    const headers = { Authorization: `Bearer ${GHL_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' };

    function ghlPost(path, body) {
      return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const opts = { hostname: 'services.leadconnectorhq.com', path, method: 'POST',
          headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } };
        const req = https.request(opts, r => {
          let buf = '';
          r.on('data', c => buf += c);
          r.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
      });
    }

    const firstName = brandName.split(' ')[0];
    const lastName = brandName.split(' ').slice(1).join(' ') || '';
    const contactRes = await ghlPost('/contacts/', { locationId: GHL_LOC, firstName, lastName, email: brandEmail });
    const contactId = contactRes.contact?.id;
    if (!contactId) { console.warn('[matchmaking email] Could not upsert GHL contact', contactRes); return; }

    const convRes = await ghlPost('/conversations/', { locationId: GHL_LOC, contactId });
    const conversationId = convRes.conversation?.id;
    if (!conversationId) { console.warn('[matchmaking email] Could not upsert conversation', convRes); return; }

    const message = `Hi ${firstName},\n\nGreat news — your affiliate link for Cult Content has been set up and is live!\n\nYour creators can now start promoting your products through our community. You'll receive commission tracking and reporting as sales come in.\n\nIf you have any questions or want to discuss your campaign, just reply to this email.\n\n— Sisyphus\nCult Content`;

    await ghlPost('/conversations/messages', {
      type: 'Email',
      conversationId,
      contactId,
      subject: `Your affiliate link is live — ${brandName}`,
      message,
    });
    console.log(`[matchmaking email] Completion email sent to ${brandEmail} for ${brandName}`);
  }

  async function sendPodcastApprovalEmail(guest) {
    const GHL_KEY = process.env.GHL_API_KEY;
    const GHL_LOC = process.env.GHL_LOC_ID || process.env.GHL_LOCATION_ID;
    const BOOKING_URL = process.env.PODCAST_BOOKING_URL || 'https://cultcontent.cc/cult-commerce-podcast/book';
    if (!GHL_KEY || !GHL_LOC) { console.warn('[podcast email] GHL_API_KEY or GHL_LOC_ID not set — skipping email'); return; }

    const headers = { Authorization: `Bearer ${GHL_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
    const https = require('https');

    function ghlPost(path, body) {
      return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const opts = { hostname: 'services.leadconnectorhq.com', path, method: 'POST',
          headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } };
        const req = https.request(opts, r => {
          let buf = '';
          r.on('data', c => buf += c);
          r.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
      });
    }

    // Upsert contact
    const contactRes = await ghlPost('/contacts/', { locationId: GHL_LOC, firstName: guest.name.split(' ')[0], lastName: guest.name.split(' ').slice(1).join(' ') || '', email: guest.email });
    const contactId = contactRes.contact?.id;
    if (!contactId) { console.warn('[podcast email] Could not upsert GHL contact', contactRes); return; }

    // Upsert conversation
    const convRes = await ghlPost('/conversations/', { locationId: GHL_LOC, contactId });
    const conversationId = convRes.conversation?.id;
    if (!conversationId) { console.warn('[podcast email] Could not upsert conversation', convRes); return; }

    // Build availability line
    const availMap = { 'weekday-morning': 'Weekday mornings (9–12 ET)', 'weekday-afternoon': 'Weekday afternoons (12–5 ET)', 'weekday-evening': 'Weekday evenings (5–8 ET)', 'weekend-morning': 'Weekend mornings (9–12 ET)', 'weekend-afternoon': 'Weekend afternoons (12–5 ET)' };
    const availLine = (guest.availability || []).map(v => availMap[v] || v).join(', ');

    const message = `Hi ${guest.name.split(' ')[0]},\n\nGreat news — you've been approved to be a guest on the Cult Commerce Podcast!\n\nPlease use the link below to book your recording session. Pick a time that works for you and we'll record on Riverside (video call — no special setup needed).\n\nBook your session: ${BOOKING_URL}\n${availLine ? `\nYou mentioned you're generally available: ${availLine}. There should be slots that work.\n` : ''}\nLooking forward to the conversation.\n\n— Tommy\nCult Commerce Podcast`;

    await ghlPost('/conversations/messages', { type: 'Email', conversationId, contactId, subject: "You're approved — book your recording time", message });
    console.log(`[podcast email] Approval email sent to ${guest.email}`);
  }

  async function sendPodcastScheduleEmail(guest) {
    const GHL_KEY = process.env.GHL_API_KEY;
    const GHL_LOC = process.env.GHL_LOC_ID || process.env.GHL_LOCATION_ID;
    if (!GHL_KEY || !GHL_LOC) { console.warn('[podcast schedule email] GHL creds missing — skipping'); return; }
    if (!guest.email) { console.warn('[podcast schedule email] No guest email — skipping'); return; }

    const headers = { Authorization: `Bearer ${GHL_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
    const https = require('https');
    function ghlPost(path, body) {
      return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const opts = { hostname: 'services.leadconnectorhq.com', path, method: 'POST',
          headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } };
        const req = https.request(opts, r => { let buf = ''; r.on('data', c => buf += c); r.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } }); });
        req.on('error', reject); req.write(data); req.end();
      });
    }

    const firstName = guest.name.split(' ')[0];
    const lastName = guest.name.split(' ').slice(1).join(' ') || '';
    const contactRes = await ghlPost('/contacts/', { locationId: GHL_LOC, firstName, lastName, email: guest.email });
    const contactId = contactRes.contact?.id;
    if (!contactId) { console.warn('[podcast schedule email] Could not upsert contact', contactRes); return; }
    const convRes = await ghlPost('/conversations/', { locationId: GHL_LOC, contactId });
    const conversationId = convRes.conversation?.id;
    if (!conversationId) { console.warn('[podcast schedule email] Could not upsert conversation', convRes); return; }

    const dateStr = guest.scheduledAt
      ? new Date(guest.scheduledAt).toLocaleString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', timeZoneName:'short' })
      : 'your scheduled time';

    const notesLine = guest.scheduleNotes ? `\n\nA note from Tommy:\n${guest.scheduleNotes}` : '';

    const message = `Hi ${firstName},\n\nYour Cult Commerce Podcast recording session is confirmed!\n\n📅 Date & time: ${dateStr}\n\n🎙 Join here on recording day:\n${guest.riversideUrl}\n\nRiverside works in your browser — no downloads needed. Join 2–3 minutes early so we can do a quick audio check before we start.${notesLine}\n\nLooking forward to the conversation!\n\n— Tommy\nCult Commerce Podcast`;

    await ghlPost('/conversations/messages', {
      type: 'Email',
      conversationId,
      contactId,
      subject: `Your podcast recording is confirmed — join link inside`,
      message,
    });
    console.log(`[podcast schedule email] Riverside link sent to ${guest.email}`);
  }

  // ---------- ROUTE: POST /api/podcast-applications/:id/send-riverside ----------
  app.post('/api/podcast-applications/:id/send-riverside', requireAuth, async (req, res) => {
    try {
      const callerEmail = (req.userEmail || '').toLowerCase();
      if (!ADMIN_EMAILS.has(callerEmail)) return res.status(403).json({ error: 'Admin only' });
      const all = readJsonFile(POD_FILE, []);
      const guest = all.find(a => a.id === req.params.id);
      if (!guest) return res.status(404).json({ error: 'Not found' });
      if (!guest.riversideUrl) return res.status(400).json({ error: 'No Riverside URL set — schedule the guest first' });
      await sendPodcastScheduleEmail(guest);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- ROUTE: POST /api/podcast-applications/:id/process-episode ----------
  app.post('/api/podcast-applications/:id/process-episode', requireAuth, async (req, res) => {
    try {
      const email = (req.userEmail || '').toLowerCase();
      if (!ADMIN_EMAILS.has(email)) return res.status(403).json({ error: 'Admin only' });
      const { id } = req.params;
      const all = readJsonFile(POD_FILE, []);
      const idx = all.findIndex(a => a.id === id);
      if (idx < 0) return res.status(404).json({ error: 'Not found' });
      const app = all[idx];
      if (!['recorded', 'done'].includes(app.status)) return res.status(400).json({ error: 'Episode must be in recorded status' });

      // Mark as processing
      all[idx].status = 'processing';
      all[idx].processingQueuedAt = Date.now();
      writeJsonFile(POD_FILE, all);

      // Build a rich task description for Claude Code
      const recordedDate = app.scheduledAt ? new Date(app.scheduledAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'recently';
      const taskDescription = [
        `Post-produce Cult Commerce Podcast episode.`,
        `Guest: ${app.name}${app.role ? ` (${app.role})` : ''}`,
        `Topics: ${app.topics || 'not specified'}`,
        `Recorded: ${recordedDate}`,
        ``,
        `Steps (use Riverside MCP tools — prefix mcp__4323b63b-f8c8-438b-8cce-6d2f90e166fe__):`,
        `1. platform_list_recordings → find the recording matching this guest name and date`,
        `2. editing_create_edit_from_recording → create a new edit`,
        `3. editing_remove_fillers + editing_remove_pauses → clean the audio`,
        `4. editing_set_magic_audio → audio enhancement`,
        `5. editing_apply_brand → apply Tommy's brand`,
        `6. editing_set_captions → add captions (use default preset)`,
        `7. editing_set_color_correction → color grade`,
        `8. editing_apply_smart_layout → smart layout for the full episode`,
        `9. exports_create_export → export the full episode (poll exports_get_export until ready)`,
        `10. hosting_list_podcasts → find the Cult Commerce Podcast feed, then hosting_create_episode → publish the episode with guest name as title`,
        `11. Read the transcript (platform_get_transcript or editing_read_aligned_transcript). Identify 3–5 high-value clips (punchy moments, strong takes, quotable lines — 30–90 seconds each). For each clip: editing_cut_time_ranges or editing_clone_edit to isolate it, exports_create_export, then POST to https://cult-command-center-production.up.railway.app/api/video-requests with body {title: "Clip: [guest] — [one-line description]", description: "[transcript excerpt]", driveUrl: "[export URL]", priority: "high"} using Bearer token from env CLAUDE_CODE_SECRET`,
        `12. PATCH https://cult-command-center-production.up.railway.app/api/podcast-applications/${id} with {status: "processed"} using Bearer CLAUDE_CODE_SECRET — WAIT this route uses session auth, instead POST to /api/podcast-applications/${id}/mark-processed with Bearer CLAUDE_CODE_SECRET`,
        ``,
        `All Railway API calls: use base URL https://cult-command-center-production.up.railway.app and header Authorization: Bearer <CLAUDE_CODE_SECRET from /Users/tommylynch/.claude/claude-code-secret.txt>`,
        `Application ID for status updates: ${id}`,
      ].join('\n');

      // Add to claude-queue
      const queue = readClaudeQueue();
      const queueId = 'podcast_' + id;
      const entry = {
        id: queueId, status: 'pending', task: taskDescription,
        productId: 'podcast', productName: 'Cult Commerce Podcast',
        priority: '🟠 High', larkRecordId: null,
        podcastApplicationId: id, guestName: app.name,
        createdAt: new Date().toISOString(), result: null,
      };
      const existing = queue.findIndex(q => q.id === queueId);
      if (existing >= 0) queue[existing] = entry; else queue.push(entry);
      writeClaudeQueue(queue);

      res.json({ ok: true, queueId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- ROUTE: POST /api/podcast-applications/:id/mark-processed ----------
  // Called by Claude Code agent after post-production is complete
  app.post('/api/podcast-applications/:id/mark-processed', jsonBody, (req, res) => {
    const secret = process.env.CLAUDE_CODE_SECRET;
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!secret || auth !== secret) return res.status(401).json({ error: 'Unauthorized' });
    const { id } = req.params;
    const all = readJsonFile(POD_FILE, []);
    const idx = all.findIndex(a => a.id === id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    all[idx].status = 'processed';
    all[idx].processedAt = Date.now();
    if (req.body && req.body.episodeUrl) all[idx].episodeUrl = req.body.episodeUrl;
    if (req.body && req.body.clipCount) all[idx].clipCount = req.body.clipCount;
    writeJsonFile(POD_FILE, all);
    res.json({ ok: true });
  });

  // ---------- ROUTE: GET /api/webhooks/list-podcast-applications ----------
  // Webhook-accessible (WEBHOOK_SECRET auth) — returns id, name, email, status for all applicants
  app.get('/api/webhooks/list-podcast-applications', (req, res) => {
    const secret = process.env.WEBHOOK_SECRET;
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!secret || auth !== secret) return res.status(401).json({ error: 'Unauthorized' });
    const all = readJsonFile(POD_FILE, []);
    res.json(all.map(a => ({ id: a.id, name: a.name, email: a.email, status: a.status, submittedAt: a.submittedAt })));
  });

  // ---------- ROUTE: PATCH /api/webhooks/patch-podcast-application/:id ----------
  // Webhook-accessible (WEBHOOK_SECRET auth) for patching podcast application fields
  app.patch('/api/webhooks/patch-podcast-application/:id', jsonBody, (req, res) => {
    const secret = process.env.WEBHOOK_SECRET;
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!secret || auth !== secret) return res.status(401).json({ error: 'Unauthorized' });
    const { id } = req.params;
    const all = readJsonFile(POD_FILE, []);
    const idx = all.findIndex(a => a.id === id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    const updates = req.body || {};
    ['status','scheduledAt','episodePageUrl','ytVideoId','spotifyUrl','applePodcastUrl','ytViews','ytLikes','ytComments','scheduleNotes','editorNotes'].forEach(k => {
      if (updates[k] !== undefined) all[idx][k] = updates[k];
    });
    all[idx].updatedAt = Date.now();
    writeJsonFile(POD_FILE, all);
    res.json({ ok: true });
  });

  // ---------- ROUTE: DELETE /api/webhooks/delete-podcast-application/:id ----------
  // Webhook-accessible (WEBHOOK_SECRET auth) for removing test/spam applications
  app.delete('/api/webhooks/delete-podcast-application/:id', (req, res) => {
    const secret = process.env.WEBHOOK_SECRET;
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!secret || auth !== secret) return res.status(401).json({ error: 'Unauthorized' });
    const { id } = req.params;
    const all = readJsonFile(POD_FILE, []);
    const idx = all.findIndex(a => a.id === id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    all.splice(idx, 1);
    writeJsonFile(POD_FILE, all);
    res.json({ ok: true });
  });

  // ---------- ROUTE: POST /api/video-requests ----------
  // Also callable by Claude Code agent (Bearer CLAUDE_CODE_SECRET) for queuing clips
  // (existing route may already exist — this is the claude-code-accessible version)

  // ---------- ROUTE: POST /api/video-requests/:id/post-buffer ----------
  app.post('/api/video-requests/:id/post-buffer', requireAuth, jsonBody, async (req, res) => {
    try {
      const email = (req.userEmail || '').toLowerCase();
      if (!ADMIN_EMAILS.has(email)) return res.status(403).json({ error: 'Admin only' });
      const { id } = req.params;
      const all = readJsonFile(VR_FILE, []);
      const idx = all.findIndex(r => r.id === id);
      if (idx < 0) return res.status(404).json({ error: 'Not found' });
      const r = all[idx];
      if (r.status !== 'approved') return res.status(400).json({ error: 'Video must be approved first' });

      const { channelSchedules } = req.body || {};
      if (!channelSchedules || !channelSchedules.length) {
        return res.status(400).json({ error: 'No channels selected' });
      }

      const BUFFER_TOKEN = process.env.BUFFER_ACCESS_TOKEN;
      if (!BUFFER_TOKEN) {
        return res.status(500).json({ error: 'Buffer not configured — set BUFFER_ACCESS_TOKEN in Railway env vars' });
      }

      // If the draft is a Google Drive link, download the video and re-host on R2
      // so Buffer's servers can fetch it directly. This runs once before the channel loop.
      let resolvedVideoUrl = r.draftUrl || '';
      const driveMatch = resolvedVideoUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (driveMatch) {
        const fileId = driveMatch[1];
        const r2AccountId = process.env.R2_ACCOUNT_ID;
        const r2KeyId     = process.env.R2_ACCESS_KEY_ID;
        const r2Secret    = process.env.R2_SECRET_ACCESS_KEY;
        const r2Bucket    = process.env.R2_BUCKET;
        const r2Public    = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

        if (r2AccountId && r2KeyId && r2Secret && r2Bucket) {
          try {
            console.log('[buffer] Downloading Drive file', fileId, 'to re-host on R2…');
            const dlUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
            const dlRes = await fetch(dlUrl, { redirect: 'follow' });
            if (!dlRes.ok) throw new Error(`Drive download HTTP ${dlRes.status}`);
            const contentType = dlRes.headers.get('content-type') || 'video/mp4';
            const buf = Buffer.from(await dlRes.arrayBuffer());
            const ext = contentType.includes('quicktime') ? 'mov' : 'mp4';
            const key = `drafts/${fileId}-${Date.now()}.${ext}`;

            const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
            const r2client = new S3Client({
              region: 'auto',
              endpoint: `https://${r2AccountId}.r2.cloudflarestorage.com`,
              credentials: { accessKeyId: r2KeyId, secretAccessKey: r2Secret },
            });
            await r2client.send(new PutObjectCommand({
              Bucket: r2Bucket, Key: key, Body: buf, ContentType: contentType,
            }));
            resolvedVideoUrl = r2Public ? `${r2Public}/${key}` : `https://${r2AccountId}.r2.cloudflarestorage.com/${r2Bucket}/${key}`;
            // Persist the R2 URL so we don't re-download on future edits
            r.draftUrl = resolvedVideoUrl;
            console.log('[buffer] Re-hosted to R2:', resolvedVideoUrl);
          } catch (dlErr) {
            console.error('[buffer] Drive→R2 failed:', dlErr.message);
            // Fall through — video platforms will fail but text platforms still schedule
          }
        } else {
          console.warn('[buffer] R2 not configured — Drive URLs will fail for video platforms');
        }
      }

      // Schedule one post per channel via Buffer GraphQL API
      const GQL_URL = 'https://api.buffer.com/graphql';
      const CREATE_POST = `
        mutation CreatePost($input: CreatePostInput!) {
          createPost(input: $input) {
            ... on PostActionSuccess { post { id status dueAt } }
            ... on MutationError { message }
          }
        }
      `;

      const results = [];
      const errors = [];

      for (const ch of channelSchedules) {
        if (!ch.channelId || !ch.caption || !ch.scheduledAt) {
          errors.push(`Channel ${ch.channelId}: missing caption or time`);
          continue;
        }
        // Determine channel service so we can pick the right mode and assets
        const CHANNEL_SERVICES = {
          '69d7f3cd031bfa423ce82b4a': 'tiktok',
          '69d6de31031bfa423ce369cf': 'instagram',
          '69d70072031bfa423ce3fc25': 'instagram',
          '69d6de1e031bfa423ce368be': 'youtube',
          '69d6de07031bfa423ce366fa': 'youtube',
          '69d700d7031bfa423ce3fd6f': 'linkedin',
          '69d70096031bfa423ce3fca1': 'linkedin',
          '69d70154031bfa423ce3fefa': 'facebook',
          '69d7018f031bfa423ce3ffa5': 'twitter',
        };
        const service = CHANNEL_SERVICES[ch.channelId] || 'unknown';
        const VIDEO_SERVICES = new Set(['tiktok', 'instagram', 'youtube']);
        const isVideoService = VIDEO_SERVICES.has(service);

        // Text-only platforms: no media asset needed, caption only.
        // All platforms receive the video asset when a resolved URL is available.
        // Buffer handles video for linkedin, twitter, instagram, facebook, youtube, tiktok.
        let assets = [];
        if (resolvedVideoUrl) {
          assets = [{ video: { url: resolvedVideoUrl } }];
        }

        // Platform-specific metadata required by Buffer's GraphQL API.
        // Introspected from CreatePostInput → PostInputMetaData on 2026-10-15.
        const videoTitle = r.videoTitle || r.title || 'Video';
        const metadata = {};
        if (service === 'instagram') {
          // shouldShareToFeed is required (Boolean!) by Buffer's schema
          metadata.instagram = { type: 'reel', shouldShareToFeed: true };
        } else if (service === 'facebook') {
          // FacebookPostMetadataInput does not have shouldShareToFeed
          metadata.facebook = { type: 'reel' };
        } else if (service === 'youtube') {
          // YouTube requires title and categoryId (22 = People & Blogs)
          metadata.youtube = { title: videoTitle, categoryId: '22' };
        } else if (service === 'tiktok') {
          metadata.tiktok = { title: videoTitle };
        }

        const input = {
          channelId: ch.channelId,
          text: ch.caption,
          mode: 'customScheduled',
          schedulingType: 'automatic',
          needsApproval: false,
          dueAt: new Date(ch.scheduledAt).toISOString(),
          assets,
          ...(Object.keys(metadata).length ? { metadata } : {}),
        };
        try {
          const gqlRes = await fetch(GQL_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${BUFFER_TOKEN}`,
            },
            body: JSON.stringify({ query: CREATE_POST, variables: { input } }),
          });
          const gqlData = await gqlRes.json().catch(() => ({}));
          console.log('[buffer] graphql createPost ch=' + ch.channelId, gqlRes.status, JSON.stringify(gqlData).slice(0, 300));

          const result = gqlData?.data?.createPost;
          const gqlErrors = gqlData?.errors;

          if (!gqlRes.ok || gqlErrors?.length) {
            errors.push(`${ch.channelId}: ${gqlErrors?.[0]?.message || `HTTP ${gqlRes.status}`}`);
          } else if (result?.message) {
            // MutationError fragment
            errors.push(`${ch.channelId}: ${result.message}`);
          } else if (result?.post) {
            results.push({ channelId: ch.channelId, bufferId: result.post.id, scheduledAt: result.post.dueAt });
          } else {
            errors.push(`${ch.channelId}: unexpected Buffer response`);
          }
        } catch (e) {
          errors.push(`${ch.channelId}: ${e.message}`);
        }
      }

      if (results.length === 0) {
        // All channels failed — revert status handled by client
        return res.status(500).json({ error: 'All channels failed: ' + errors.join('; ') });
      }

      // Persist buffer post IDs back onto the record
      r.bufferPosts = results;
      if (errors.length) r.bufferErrors = errors;
      all[idx] = r;
      writeJsonFile(VR_FILE, all);

      const warnings = errors.length ? `Some channels failed: ${errors.join('; ')}` : null;
      res.json({ ok: true, scheduled: results.length, posts: results, ...(warnings ? { warning: warnings } : {}) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- ROUTE: POST /api/buffer-webhook ----------
  // Buffer fires this when a post is sent. Matches by bufferId stored on
  // the video request, marks it posted, and stores the live post URL.
  app.post('/api/buffer-webhook', jsonBody, (req, res) => {
    try {
      const body = req.body || {};
      // Buffer sends { updates: [{ id, service, service_update_id, status, statistics }] }
      // or { update: { id, service, ... } } depending on webhook version
      const updates = body.updates || (body.update ? [body.update] : []);
      if (!updates.length) return res.json({ ok: true, note: 'no updates in payload' });

      const all = readJsonFile(VR_FILE, []);
      let changed = false;

      for (const u of updates) {
        if (u.status !== 'sent') continue;  // only care about published posts
        const bufId = u.id;
        const idx = all.findIndex(r =>
          r.bufferId === bufId ||
          (Array.isArray(r.bufferIds) && r.bufferIds.includes(bufId))
        );
        if (idx < 0) continue;
        const r = all[idx];
        const postUrl = u.service_link || u.statistics?.reach_url || null;
        const platform = u.service || 'unknown';
        if (r.status !== 'posted') {
          r.status = 'posted';
          r.postedAt = Date.now();
        }
        r.postedLinks = r.postedLinks || [];
        if (postUrl && !r.postedLinks.find(l => l.url === postUrl)) {
          r.postedLinks.push({ platform, url: postUrl });
        }
        r.updatedAt = Date.now();
        all[idx] = r;
        changed = true;
      }

      if (changed) writeJsonFile(VR_FILE, all);
      res.json({ ok: true });
    } catch (e) {
      console.error('[buffer-webhook]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- ROUTE: POST /api/video-requests/:id/cancel-buffer ----------
  // Deletes all scheduled Buffer posts for a card (called when moving back to For Review).
  app.post('/api/video-requests/:id/cancel-buffer', requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const all = readJsonFile(VR_FILE, []);
      const r = all.find(r => r.id === id);
      if (!r) return res.status(404).json({ error: 'Not found' });
      const bufferPosts = r.bufferPosts || [];
      if (!bufferPosts.length) return res.json({ ok: true, cancelled: 0 });

      const BUFFER_TOKEN = process.env.BUFFER_ACCESS_TOKEN;
      if (!BUFFER_TOKEN) return res.json({ ok: true, cancelled: 0, note: 'No Buffer token' });

      const GQL_URL = 'https://api.buffer.com/graphql';
      const DELETE_POST = `mutation DeletePost($input: DeletePostInput!) {
        deletePost(input: $input) { deletedPostId }
      }`;

      let cancelled = 0;
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (const bp of bufferPosts) {
        if (!bp.bufferId) continue;
        try {
          await sleep(300);
          const gqlRes = await fetch(GQL_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BUFFER_TOKEN}` },
            body: JSON.stringify({ query: DELETE_POST, variables: { input: { id: bp.bufferId } } }),
          });
          const d = await gqlRes.json().catch(() => ({}));
          if (d?.data?.deletePost?.deletedPostId) cancelled++;
        } catch (_) { /* skip individual failures */ }
      }
      res.json({ ok: true, cancelled });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- ROUTE: POST /api/video-requests/:id/fetch-links ----------
  // Queries Buffer for the live externalLink of each scheduled post.
  // Stores results in r.postedLinks and r.linkErrors on the record.
  app.post('/api/video-requests/:id/fetch-links', requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const all = readJsonFile(VR_FILE, []);
      const idx = all.findIndex(r => r.id === id);
      if (idx < 0) return res.status(404).json({ error: 'Not found' });
      const r = all[idx];
      const bufferPosts = r.bufferPosts || [];
      if (!bufferPosts.length) return res.json({ ok: true, links: [], errors: ['No Buffer posts on record'] });

      const BUFFER_TOKEN = process.env.BUFFER_ACCESS_TOKEN;
      if (!BUFFER_TOKEN) return res.status(500).json({ error: 'BUFFER_ACCESS_TOKEN not configured' });
      const GQL_URL = 'https://api.buffer.com/graphql';

      // VQ_BUFFER_CHANNELS duplicated here for service lookup (client-only constant)
      const CHANNEL_MAP = {
        '69d7f3cd031bfa423ce82b4a': { service: 'tiktok',    name: 'tommylynch_' },
        '69d6de31031bfa423ce369cf': { service: 'instagram', name: 'tommy.lynch_' },
        '69d70072031bfa423ce3fc25': { service: 'instagram', name: 'cultcontent.cc' },
        '69d6de1e031bfa423ce368be': { service: 'youtube',   name: 'Tommy Lynch' },
        '69d6de07031bfa423ce366fa': { service: 'youtube',   name: 'Cult Content' },
        '69d700d7031bfa423ce3fd6f': { service: 'linkedin',  name: 'tommy-lynch' },
        '69d70096031bfa423ce3fca1': { service: 'linkedin',  name: 'cultcontent' },
        '69d70154031bfa423ce3fefa': { service: 'facebook',  name: 'Cult Content' },
        '69d7018f031bfa423ce3ffa5': { service: 'twitter',   name: 'thlynch3' },
      };

      const GET_POST = `query GetPost($input: PostInput!) {
        post(input: $input) {
          id
          externalLink
          sentAt
          status
          metrics { type value }
        }
      }`;

      const links = [];
      const errors = [];
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      for (const bp of bufferPosts) {
        const ch = CHANNEL_MAP[bp.channelId] || {};
        const label = ch.name ? `${ch.service} (${ch.name})` : bp.channelId;
        try {
          await sleep(300); // avoid Buffer rate limit (one req per 300ms)
          const gqlRes = await fetch(GQL_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BUFFER_TOKEN}` },
            body: JSON.stringify({ query: GET_POST, variables: { input: { id: bp.bufferId } } }),
          });
          const d = await gqlRes.json().catch(() => ({}));
          const post = d?.data?.post;
          // Use data.post even if errors[] is non-empty (partial GraphQL response)
          if (!post) {
            const msg = d?.errors?.[0]?.message || `HTTP ${gqlRes.status}`;
            errors.push(`${label}: ${msg}`);
          } else if (post.externalLink) {
            const views = (post.metrics || []).find(m => m.type === 'views')?.value || 0;
            links.push({ platform: label, url: post.externalLink, views });
          } else {
            const status = post.status || 'unknown';
            if (status === 'sent' || post.sentAt) {
              errors.push(`${label}: posted but no URL returned`);
            } else {
              errors.push(`${label}: not yet posted (status: ${status})`);
            }
          }
        } catch (e) {
          errors.push(`${label}: ${e.message}`);
        }
      }

      // Merge links into existing postedLinks; update views on existing entries
      const existing = r.postedLinks || [];
      const merged = [...existing];
      for (const l of links) {
        const ex = merged.find(e => e.url === l.url);
        if (ex) { ex.views = l.views; }
        else { merged.push(l); }
      }
      r.postedLinks = merged;
      r.linkErrors = errors;
      r.totalViews = merged.reduce((s, l) => s + (l.views || 0), 0);
      r.metricsUpdatedAt = Date.now();
      r.updatedAt = Date.now();
      all[idx] = r;
      writeJsonFile(VR_FILE, all);

      res.json({ ok: true, links, errors, totalViews: r.totalViews });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- ROUTE: DELETE /api/video-requests/:id ----------
  app.delete('/api/video-requests/:id', requireAuth, (req, res) => {
    try {
      const email = (req.userEmail || '').toLowerCase();
      const isAdmin = ADMIN_EMAILS.has(email);
      const { id } = req.params;
      const all = readJsonFile(VR_FILE, []);
      const idx = all.findIndex(r => r.id === id);
      if (idx < 0) return res.status(404).json({ error: 'Not found' });
      if (!isAdmin && all[idx].submittedBy !== email)
        return res.status(403).json({ error: 'Not allowed' });
      all.splice(idx, 1);
      writeJsonFile(VR_FILE, all);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- ROUTE: POST /api/video-requests/admin/purge-pending ----------
  // Admin-only one-shot: delete all video requests with status 'pending' (Submitted).
  app.post('/api/video-requests/admin/purge-pending', requireAuth, (req, res) => {
    const email = (req.userEmail || '').toLowerCase();
    if (!ADMIN_EMAILS.has(email)) return res.status(403).json({ error: 'Admin only' });
    const all = readJsonFile(VR_FILE, []);
    const kept = all.filter(r => r.status !== 'pending');
    const removed = all.length - kept.length;
    writeJsonFile(VR_FILE, kept);
    res.json({ ok: true, removed });
  });

  // ---------- ROUTE: POST /api/video-requests/:id/expand ----------
  // Admin-only: immediately expand a pending card into N copies (simulates
  // submitting with quantity N). Used to set up test data without re-submitting.
  app.post('/api/video-requests/:id/expand', requireAuth, jsonBody, (req, res) => {
    try {
      const email = (req.userEmail || '').toLowerCase();
      if (!ADMIN_EMAILS.has(email)) return res.status(403).json({ error: 'Admin only' });
      const { id } = req.params;
      const qty = Math.min(Math.max(parseInt((req.body || {}).quantity, 10) || 2, 2), 10);
      const all = readJsonFile(VR_FILE, []);
      const idx = all.findIndex(r => r.id === id);
      if (idx < 0) return res.status(404).json({ error: 'Not found' });
      const r = all[idx];
      const dateLabel = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      r.title = `Video 1 — ${dateLabel}`;
      r.status = 'pending';
      r.quantity = qty;
      all[idx] = r;
      for (let n = 2; n <= qty; n++) {
        all.push(Object.assign({}, r, {
          id: 'vr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + n,
          title: `Video ${n} — ${dateLabel}`,
          quantity: qty,
        }));
      }
      writeJsonFile(VR_FILE, all);
      res.json({ ok: true, expanded: qty });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- BUFFER POLL: auto-move Scheduled → Posted ----------
  // Polls Buffer GraphQL API every hour using post(input:{id}) per buffer post.
  // A card moves to 'posted' once all its channels have been sent.
  async function pollBufferSent() {
    const BUFFER_TOKEN = process.env.BUFFER_ACCESS_TOKEN;
    if (!BUFFER_TOKEN) return;
    try {
      const all = readJsonFile(VR_FILE, []);
      const scheduled = all.filter(r => r.status === 'approved' && r.bufferPosts?.length);
      if (!scheduled.length) return;

      const GQL_URL = 'https://api.buffer.com/graphql';
      const GET_POST = `query GetPost($input: PostInput!) { post(input: $input) { id sentAt status } }`;

      const sentMap = new Map();
      for (const card of scheduled) {
        for (const bp of card.bufferPosts) {
          if (!bp.bufferId || sentMap.has(bp.bufferId)) continue;
          try {
            const r = await fetch(GQL_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BUFFER_TOKEN}` },
              body: JSON.stringify({ query: GET_POST, variables: { input: { id: bp.bufferId } } }),
            });
            const d = await r.json().catch(() => ({}));
            const post = d?.data?.post;
            if (post) sentMap.set(bp.bufferId, post);
          } catch (_) { /* skip on network error */ }
        }
      }

      let changed = false;
      const fresh = readJsonFile(VR_FILE, []);
      for (let i = 0; i < fresh.length; i++) {
        const r = fresh[i];
        if (r.status !== 'approved' || !r.bufferPosts?.length) continue;
        const allSent = r.bufferPosts.every(bp => {
          const p = sentMap.get(bp.bufferId);
          return p && (p.status === 'sent' || p.sentAt);
        });
        if (!allSent) continue;
        r.status = 'posted';
        r.postedAt = Date.now();
        r.updatedAt = Date.now();
        fresh[i] = r;
        changed = true;
        console.log(`[buffer-poll] marked posted: ${r.id} (${r.title})`);
      }
      if (changed) writeJsonFile(VR_FILE, fresh);
    } catch (e) {
      console.error('[buffer-poll] error:', e.message);
    }
  }

  // Run once at startup (catches anything published while server was down), then every hour.
  setTimeout(pollBufferSent, 30000);
  setInterval(pollBufferSent, 60 * 60 * 1000);

  // ---------- METRICS POLL: update view counts every 12 hours ----------
  const METRICS_GQL = `query GetPost($input: PostInput!) {
    post(input: $input) { id metrics { type value } }
  }`;

  async function pollBufferMetrics() {
    const BUFFER_TOKEN = process.env.BUFFER_ACCESS_TOKEN;
    if (!BUFFER_TOKEN) return;
    try {
      const GQL_URL = 'https://api.buffer.com/graphql';
      const all = readJsonFile(VR_FILE, []);
      const posted = all.filter(r => r.status === 'posted' && r.bufferPosts?.length);
      if (!posted.length) return;
      let changed = false;
      for (const r of posted) {
        let totalViews = 0;
        let metricsCount = 0; // posts that returned actual data (not skipped/errored)
        for (const bp of r.bufferPosts) {
          if (!bp.bufferId) continue;
          try {
            await new Promise(r => setTimeout(r, 400)); // avoid Buffer rate limit
            const res = await fetch(GQL_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BUFFER_TOKEN}` },
              body: JSON.stringify({ query: METRICS_GQL, variables: { input: { id: bp.bufferId } } }),
            });
            const d = await res.json().catch(() => ({}));
            const gqlErrs = d?.errors || [];
            const scopeErr = gqlErrs.some(e => e.message?.includes('insights:read'));
            if (scopeErr) continue; // token lacks insights scope — skip silently
            if (!d?.data?.post) continue; // post not found or no data — skip
            const views = (d.data.post.metrics || []).find(m => m.type === 'views')?.value || 0;
            totalViews += views;
            metricsCount++;
          } catch (_) { /* skip individual failures */ }
        }
        // Only overwrite totalViews if we actually got metrics back — avoid zeroing a
        // previously valid count when Buffer hasn't updated metrics yet after a deploy.
        if (metricsCount > 0) {
          r.totalViews = totalViews;
          r.metricsUpdatedAt = Date.now();
          changed = true;
          console.log(`[metrics-poll] ${r.id} (${r.title}): ${totalViews} total views from ${metricsCount} posts`);
        } else {
          console.log(`[metrics-poll] ${r.id} (${r.title}): no metrics data returned — keeping existing totalViews`);
        }
      }
      if (changed) writeJsonFile(VR_FILE, all);
    } catch (e) {
      console.error('[metrics-poll] error:', e.message);
    }
  }

  // First run 5 min after startup, then every 12 hours.
  setTimeout(pollBufferMetrics, 5 * 60 * 1000);
  setInterval(pollBufferMetrics, 12 * 60 * 60 * 1000);

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
    addPodcastGuest,
    sendPodcastScheduleEmail,
  };
  // Real, already-maintained staff-to-brand knowledge (see the "Trip Visuals
  // and Made Right" commit for evidence this list is actively kept current) —
  // exposed the same way _helpers already is, so db/seed-team.js can seed
  // brand_assignments from the single source of truth instead of duplicating
  // this list somewhere that could drift out of sync with it.
  registerOpsMyTasks.BRAND_MANAGERS = BRAND_MANAGERS;

  // ─────────────────────────────────────────────────────────────────────────
  // TEAM MANAGEMENT ROUTES
  // ─────────────────────────────────────────────────────────────────────────
  const TEAM_MGMT_FILE = nodePath.join(DATA_DIR, 'team-mgmt.json');

  const TEAM_ROSTER = [
    { email: 'tommy@cultcontent.cc',   name: 'Tommy',   role: 'CEO',               timezone: 'ET', color: '#7b2fff' },
    { email: 'jina@cultcontent.cc',    name: 'Jina',    role: 'Account Manager',   timezone: 'ET' },
    { email: 'gilbert@cultcontent.cc', name: 'Gilbert', role: 'Video Editor',      timezone: 'PT' },
    { email: 'gourab@cultcontent.cc',  name: 'Gourab',  role: 'Developer',         timezone: 'IST' },
    { email: 'becca@cultcontent.cc',   name: 'Becca',   role: 'Community Manager', timezone: 'ET' },
    { email: 'jenna@cultcontent.cc',   name: 'Jenna',   role: 'Community Manager', timezone: 'ET' },
  ];

  // GET /api/admin/team/members — merged roster + comp + stored data + open task counts
  app.get('/api/admin/team/members', requireAuth, async (req, res) => {
    try {
      const callerEmail = (req.userEmail || '').toLowerCase();
      const isAdmin = !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(callerEmail);
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });

      const stored = readJsonFile(TEAM_MGMT_FILE, {});
      const now = new Date();
      const monthKey = now.toISOString().slice(0, 7);
      const monthStartMs = new Date(monthKey + '-01T00:00:00.000Z').getTime();
      const nextMonth = new Date(monthKey + '-01T00:00:00.000Z');
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
      const monthEndMs = nextMonth.getTime();
      const netSalesData = readJsonFile(NET_SALES_FILE, {});
      const netSales = (netSalesData[monthKey] && netSalesData[monthKey].netSales) || 0;
      const allWr = readJsonFile(WR_FILE, []);
      const allVr = readJsonFile(VR_FILE, []);
      // Fetch live Lark tasks for accurate open task counts
      let allLarkRecords = [];
      try { allLarkRecords = await listAllTaskRecords(); } catch (_) {}

      const members = TEAM_ROSTER.map(member => {
        const { email, name, role, timezone } = member;
        const s = stored[email] || {};
        const model = COMP_MODEL[email];
        const reportType = REPORT_TYPES[email] || 'brand_manager';

        // KPI / bonus from comp model
        let bonusDollars = 0, gateDetails = [];
        if (model) {
          const myReports = allWr.filter(r =>
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
          const comp = computeCompTierSrv(model, kpis);
          bonusDollars = Math.round(netSales * comp.bonusPct);
          gateDetails = comp.gateDetails;
        }

        // Open tasks: live Lark records filtered by ownerOpenId + VR cards in-progress
        const memberOpenId = SEED_EMAIL_OPENID[email] || null;
        const openLarkTasks = memberOpenId ? allLarkRecords.filter(rec => {
          const f = rec.fields || {};
          const status = (f.Status && (Array.isArray(f.Status) ? f.Status[0] : f.Status)) || '';
          const statusText = typeof status === 'object' ? (status.text || '') : status;
          if (statusText === 'Completed') return false;
          const owners = Array.isArray(f.Owner) ? f.Owner : (f.Owner ? [f.Owner] : []);
          return owners.some(o => (typeof o === 'object' ? o.id : o) === memberOpenId);
        }).length : 0;
        const openVr = allVr.filter(r =>
          (r.submittedBy || '').toLowerCase() === email &&
          ['pending', 'in-progress'].includes(r.status)
        ).length;

        return {
          email, name, role, timezone,
          startDate: s.startDate || null,
          notes: s.notes || '',
          aiOverview: s.aiOverview || '',
          aiOverviewUpdatedAt: s.aiOverviewUpdatedAt || null,
          anthropicUsage: s.anthropicUsage || 0,
          phone: s.phone || '',
          base: model ? model.base : 0,
          bonusDollars, gateDetails,
          openTasks: openLarkTasks + openVr,
        };
      });

      res.json({ members, isAdmin: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PATCH /api/admin/team/members/:email — update stored fields (notes, startDate, phone, anthropicUsage)
  app.patch('/api/admin/team/members/:email', requireAuth, jsonBody, (req, res) => {
    try {
      const callerEmail = (req.userEmail || '').toLowerCase();
      if (!ADMIN_EMAILS.has(callerEmail)) return res.status(403).json({ error: 'Admin only' });
      const email = decodeURIComponent(req.params.email).toLowerCase();
      const stored = readJsonFile(TEAM_MGMT_FILE, {});
      if (!stored[email]) stored[email] = {};
      const { notes, startDate, phone, anthropicUsage, aiOverview, aiOverviewUpdatedAt } = req.body || {};
      if (notes !== undefined) stored[email].notes = notes;
      if (startDate !== undefined) stored[email].startDate = startDate;
      if (phone !== undefined) stored[email].phone = phone;
      if (anthropicUsage !== undefined) stored[email].anthropicUsage = anthropicUsage;
      if (aiOverview !== undefined) stored[email].aiOverview = aiOverview;
      if (aiOverviewUpdatedAt !== undefined) stored[email].aiOverviewUpdatedAt = aiOverviewUpdatedAt;
      writeJsonFile(TEAM_MGMT_FILE, stored);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/admin/team/members/:email/calls — recent Fireflies transcripts for this person
  app.get('/api/admin/team/members/:email/calls', requireAuth, async (req, res) => {
    try {
      const callerEmail = (req.userEmail || '').toLowerCase();
      if (!ADMIN_EMAILS.has(callerEmail)) return res.status(403).json({ error: 'Admin only' });
      const email = decodeURIComponent(req.params.email).toLowerCase();
      const FIREFLIES_KEY = process.env.FIREFLIES_API_KEY;
      if (!FIREFLIES_KEY) return res.json({ calls: [] });

      const query = `query { transcripts(limit:10) { id title date duration participants { email } summary { action_items overview } } }`;
      const r = await fetch('https://api.fireflies.ai/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${FIREFLIES_KEY}` },
        body: JSON.stringify({ query }),
      });
      const d = await r.json();
      const all = (d?.data?.transcripts || []);
      const calls = all
        .filter(t => (t.participants || []).some(p => (p.email || '').toLowerCase() === email))
        .slice(0, 10)
        .map(t => ({
          id: t.id, title: t.title, date: t.date,
          duration: t.duration,
          summary: t.summary?.overview || '',
        }));
      res.json({ calls });
    } catch (e) { res.json({ calls: [] }); }
  });

  // POST /api/admin/team/members/ai-overviews — regenerate AI overviews for all team members
  app.post('/api/admin/team/members/ai-overviews', requireAuth, async (req, res) => {
    try {
      const callerEmail = (req.userEmail || '').toLowerCase();
      if (!ADMIN_EMAILS.has(callerEmail)) return res.status(403).json({ error: 'Admin only' });
      const FIREFLIES_KEY = process.env.FIREFLIES_API_KEY;
      const stored = readJsonFile(TEAM_MGMT_FILE, {});
      const updatedAt = new Date().toISOString();

      for (const member of TEAM_ROSTER) {
        const { email, name, role } = member;
        let callContext = '';
        if (FIREFLIES_KEY) {
          try {
            const q = `query { transcripts(limit:5) { id title date duration participants { email } summary { overview } } }`;
            const r = await fetch('https://api.fireflies.ai/graphql', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${FIREFLIES_KEY}` },
              body: JSON.stringify({ query: q }),
            });
            const d = await r.json();
            const calls = (d?.data?.transcripts || [])
              .filter(t => (t.participants || []).some(p => (p.email || '').toLowerCase() === email))
              .slice(0, 5);
            if (calls.length) {
              callContext = calls.map(c => `- ${c.title} (${new Date(c.date).toLocaleDateString()}): ${c.summary?.overview || 'no summary'}`).join('\n');
            }
          } catch (_) {}
        }
        const notes = (stored[email] || {}).notes || '';
        const prompt = `You are a brief, factual team summarizer for a CEO dashboard at Cult Content, a social commerce agency.\n\nTeam member: ${name} (${role})\nEmail: ${email}\n${notes ? `\nAdmin notes:\n${notes}\n` : ''}${callContext ? `\nRecent call summaries:\n${callContext}\n` : ''}\n\nWrite a 3-4 sentence AI overview of this team member covering: their role, current focus, notable recent activity, and any patterns. Be factual and concise. If there is little data, note that.`;
        try {
          const msg = await anthropic.messages.create({
            model: 'claude-haiku-4-5', max_tokens: 300,
            messages: [{ role: 'user', content: prompt }],
          });
          if (!stored[email]) stored[email] = {};
          stored[email].aiOverview = msg.content[0].text;
          stored[email].aiOverviewUpdatedAt = updatedAt;
        } catch (_) {}
      }

      writeJsonFile(TEAM_MGMT_FILE, stored);
      res.json({ ok: true, updatedAt });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── More Tools routes ──────────────────────────────────
  const GILBERT_SEED = [
    { id:'tool_capcut',     emoji:'🎬', name:'CapCut',           url:'https://www.capcut.com' },
    { id:'tool_seedance',   emoji:'✨', name:'Seedance AI',       url:'https://seedance.ai' },
    { id:'tool_ttstudio',   emoji:'📱', name:'TikTok Studio',     url:'https://www.tiktok.com/studio' },
    { id:'tool_buffer',     emoji:'📅', name:'Buffer',            url:'https://publish.buffer.com' },
    { id:'tool_gdrive',     emoji:'📁', name:'Google Drive',      url:'https://drive.google.com' },
    { id:'tool_manifest',   emoji:'🖥',  name:'Content Pipeline',  url:'https://manifest.cultcontent.cc' },
  ];
  function toolsFilePath(email) {
    return nodePath.join(DATA_DIR, 'tools-' + email.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.json');
  }

  app.get('/api/my-tasks/tools', requireAuth, (req, res) => {
    try {
      const sessionEmail = (req.session && req.session.email) || '';
      const isAdmin = ADMIN_EMAILS.has(sessionEmail);
      const devAs = req.query.devAs;
      const email = (isAdmin && devAs) ? devAs : sessionEmail;
      const fp = toolsFilePath(email);
      let tools;
      if (!require('fs').existsSync(fp) && email === 'gilbert@cultcontent.cc') {
        tools = GILBERT_SEED;
        writeJsonFile(fp, tools);
      } else {
        tools = readJsonFile(fp, []);
      }
      res.json({ ok: true, tools });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/my-tasks/tools/:id', requireAuth, jsonBody, (req, res) => {
    try {
      const email = (req.session && req.session.email) || '';
      const { emoji, name, url } = req.body || {};
      if (!name || !url) return res.status(400).json({ error: 'name and url required' });
      if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'url must start with https://' });
      const fp = toolsFilePath(email);
      let tools = readJsonFile(fp, []);
      const idx = tools.findIndex(t => t.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Tool not found' });
      tools[idx] = { ...tools[idx], emoji: (emoji || '🔧').trim(), name: name.trim(), url: url.trim() };
      writeJsonFile(fp, tools);
      res.json({ ok: true, tools });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/my-tasks/tools', requireAuth, jsonBody, (req, res) => {
    try {
      const email = (req.session && req.session.email) || '';
      const { emoji, name, url } = req.body || {};
      if (!name || !url) return res.status(400).json({ error: 'name and url required' });
      if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'url must start with https://' });
      const fp = toolsFilePath(email);
      const tools = readJsonFile(fp, []);
      const id = 'tool_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
      tools.push({ id, emoji: (emoji || '🔧').trim(), name: name.trim(), url: url.trim() });
      writeJsonFile(fp, tools);
      res.json({ ok: true, tools });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/my-tasks/tools/:id', requireAuth, (req, res) => {
    try {
      const email = (req.session && req.session.email) || '';
      const fp = toolsFilePath(email);
      let tools = readJsonFile(fp, []);
      tools = tools.filter(t => t.id !== req.params.id);
      writeJsonFile(fp, tools);
      res.json({ ok: true, tools });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return app;
};
