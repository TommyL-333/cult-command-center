'use strict';

/**
 * ops-mytasks-lib.js  (cult-command-center)
 *
 * Helper module (NOT a mounted route) powering the Ops Engine "My Tasks" UI.
 * Resolves the signed-in user's Lark open_id, lists the tasks they own from the
 * Ops Engine Live Tasks base, and updates task status/result back to Bitable.
 *
 * Auth: canonical tenant_access_token pattern (auth/v3/tenant_access_token/internal
 * with LARK_APP_ID / LARK_APP_SECRET), cached in-process until ~60s before expiry.
 * Mirrors sisyphus agents/lib/ic-script-bitable.js.
 *
 * Data source (Ops Engine Lark Base):
 *   Base app_token : EsfBbIqfkauKozsxMHMuilDztod   (env OPS_ENGINE_APP_TOKEN overrides)
 *   Live Tasks tbl : tbl7XaSc37mtcBKg              (env OPS_ENGINE_TASKS_TABLE overrides)
 *   Team tbl       : tblswNG7LAFaOJOn              (env OPS_ENGINE_TEAM_TABLE overrides)
 *
 * CONFIRMED Live Tasks field NAMES (from live schema probe, Jul 2026):
 *   Task (Text, primary) | Client (SingleLink) | Status (SingleSelect) |
 *   Pillar (SingleSelect) | Phase | Role | Owner (User) | Execution Mode |
 *   Auto? (Checkbox) | Due Date (DateTime) | Prompt / Action (Text) |
 *   Result / Output (Text) | SOP Link (Url) | Created On (DateTime) |
 *   Priority (SingleSelect) | Category (SingleSelect) | Source (Text)
 *   NOTE: there is NO dedicated "Completed On" field. When a task is marked
 *   Completed we stamp the completion time into the Result / Output note (ISO)
 *   rather than fabricating a field that does not exist. If a completion
 *   DateTime field is later added, set OPS_ENGINE_COMPLETED_FIELD to its name
 *   and it will be written as epoch ms.
 *
 * CONFIRMED Team field NAMES:
 *   Name (Text, primary) | Person (User) | Role (SingleSelect) |
 *   Active (Checkbox) | Open ID (Text)
 *
 * HONESTY: every helper degrades gracefully and NEVER fabricates a write/read.
 * On missing env or API error, list returns [] and update returns { ok:false, error }.
 *
 * Exports:
 *   resolveOpenId(user)                         -> Promise<string|null>
 *   listMyTasks(openId)                         -> Promise<Array<normalizedRow>>
 *   updateTaskStatus(recordId, {status, resultNote, openId}) -> Promise<{ok, ...}>
 */

const axios = require('axios');

const LARK_BASE = 'https://open.larksuite.com';

const OPS_APP_TOKEN   = process.env.OPS_ENGINE_APP_TOKEN   || 'EsfBbIqfkauKozsxMHMuilDztod';
const TASKS_TABLE_ID  = process.env.OPS_ENGINE_TASKS_TABLE || 'tbl7XaSc37mtcBKg';
const TEAM_TABLE_ID   = process.env.OPS_ENGINE_TEAM_TABLE  || 'tblswNG7LAFaOJOn';
const CLIENTS_TABLE_ID = process.env.OPS_ENGINE_CLIENTS_TABLE || 'tblgM1L7myeAfYQm';
// Optional: name of a real completion DateTime field, if one is ever added.
const COMPLETED_FIELD = process.env.OPS_ENGINE_COMPLETED_FIELD || null;

// Hardcoded fallback open_id map (verified against live Owner cells).
const OPEN_ID_FALLBACK = {
  tommy:  'ou_cd6157679f48e0cea557ebcb1995c462',
  hasan:  'ou_c8f157f2f18a8c4ffe6a20d3971348e1',
  shayan: 'ou_19a69dda7462358e4b3c31e2f157a238',
};

// ── token cache (mirrors ic-script-bitable.js) ──────────────────────────────
let _token = null;
let _tokenExp = 0;

async function larkToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  const appId = process.env.LARK_APP_ID;
  const secret = process.env.LARK_APP_SECRET;
  if (!appId || !secret) throw new Error('LARK_APP_ID/LARK_APP_SECRET missing');
  const r = await axios.post(
    `${LARK_BASE}/open-apis/auth/v3/tenant_access_token/internal`,
    { app_id: appId, app_secret: secret },
    { headers: { 'Content-Type': 'application/json' }, timeout: 12000 }
  );
  const tok = r.data && r.data.tenant_access_token;
  if (!tok) {
    throw new Error(
      `tenant_access_token not returned (code=${r.data && r.data.code}, msg=${r.data && r.data.msg})`
    );
  }
  _token = tok;
  const expire = (r.data && r.data.expire) || 7200;
  _tokenExp = Date.now() + (expire - 60) * 1000;
  return _token;
}

// ── helpers ─────────────────────────────────────────────────────────────────

// Bitable Text (incl. primary) fields can come back as a string OR as a rich
// array [{text, type}]. Normalize either shape to a plain string.
function textVal(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((seg) => (seg && typeof seg === 'object' ? (seg.text || '') : String(seg || '')))
      .join('')
      .trim();
  }
  if (typeof v === 'object' && v.text) return v.text;
  return String(v);
}

// SingleLink field -> the linked record's display text (first link).
// Handles BOTH shapes: the plain /records list ({text,text_arr,record_ids}) AND
// the /records/search shape ({link_record_ids:[...]}). For the search shape the
// display text is not inline, so callers resolve link_record_ids via the cached
// Clients lookup (see clientNameForLinks).
function linkText(v) {
  if (!v) return '';
  if (Array.isArray(v) && v.length) {
    const first = v[0];
    if (first && typeof first === 'object') {
      if (first.text) return first.text;
      if (Array.isArray(first.text_arr) && first.text_arr.length) return first.text_arr[0];
    }
  }
  if (typeof v === 'object' && Array.isArray(v.text_arr) && v.text_arr.length) return v.text_arr[0];
  if (typeof v === 'string') return v;
  return '';
}

// Extract linked record ids from either SingleLink shape.
function linkRecordIds(v) {
  if (!v) return [];
  if (Array.isArray(v)) {
    const ids = [];
    for (const seg of v) {
      if (seg && Array.isArray(seg.record_ids)) ids.push(...seg.record_ids);
    }
    return ids;
  }
  if (typeof v === 'object' && Array.isArray(v.link_record_ids)) return v.link_record_ids;
  return [];
}

// ── Clients (brand) name cache: link_record_id -> Brand name ────────────────
let _clientMap = null;
let _clientMapExp = 0;
async function getClientMap() {
  if (_clientMap && Date.now() < _clientMapExp) return _clientMap;
  const map = {};
  try {
    const token = await larkToken();
    let pageToken;
    let guard = 0;
    do {
      const params = { page_size: 200 };
      if (pageToken) params.page_token = pageToken;
      const r = await axios.get(
        `${LARK_BASE}/open-apis/bitable/v1/apps/${OPS_APP_TOKEN}/tables/${CLIENTS_TABLE_ID}/records`,
        { headers: { Authorization: `Bearer ${token}` }, params, timeout: 12000 }
      );
      const data = (r.data && r.data.data) || {};
      for (const it of data.items || []) {
        map[it.record_id] = textVal((it.fields || {})['Brand']);
      }
      pageToken = data.has_more ? data.page_token : undefined;
      guard += 1;
    } while (pageToken && guard < 20);
  } catch (_) { /* degrade to empty map */ }
  _clientMap = map;
  _clientMapExp = Date.now() + 5 * 60 * 1000; // 5 min cache
  return _clientMap;
}

// SingleSelect -> string as-is.
function selectVal(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).join(', ');
  return typeof v === 'string' ? v : String(v);
}

function dateVal(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null; // epoch ms per Bitable DateTime
}

function normalizeRow(item, clientMap) {
  const f = (item && item.fields) || {};
  // Prefer inline link text (plain records shape); else resolve link ids via map.
  let clientName = linkText(f['Client']);
  if (!clientName) {
    const ids = linkRecordIds(f['Client']);
    if (ids.length && clientMap) {
      clientName = ids.map((id) => clientMap[id]).filter(Boolean).join(', ');
    }
  }
  return {
    record_id: item.record_id,
    task: textVal(f['Task']),
    clientName: clientName || '',
    status: selectVal(f['Status']),
    priority: selectVal(f['Priority']),
    pillar: selectVal(f['Pillar']),
    prompt: textVal(f['Prompt / Action']),
    dueDate: dateVal(f['Due Date']),
  };
}

// ── resolveOpenId ───────────────────────────────────────────────────────────
/**
 * Resolve a user's Lark open_id.
 * Priority:
 *   1. Explicit open_id on the session object (openId / open_id / larkOpenId).
 *   2. Team table (tblswNG7LAFaOJOn) — match by 'Open ID', 'Person' user id,
 *      then Name/Email against 'Name'. Returns that row's 'Open ID' text or
 *      the 'Person' user id.
 *   3. Hardcoded fallback map by first name (Tommy/Hasan/Shayan).
 * Returns the open_id string, or null if unresolvable. Never throws.
 */
async function resolveOpenId(user) {
  try {
    if (!user) return null;

    // 1. Session-provided open_id.
    const direct =
      user.openId || user.open_id || user.larkOpenId || user.lark_open_id ||
      (user.session && (user.session.openId || user.session.open_id));
    if (typeof direct === 'string' && direct.startsWith('ou_')) return direct;

    const name = (user.name || user.fullName || user.displayName || '').trim();
    const email = (user.email || '').trim().toLowerCase();

    // 2. Team table lookup.
    try {
      const token = await larkToken();
      const r = await axios.get(
        `${LARK_BASE}/open-apis/bitable/v1/apps/${OPS_APP_TOKEN}/tables/${TEAM_TABLE_ID}/records`,
        { headers: { Authorization: `Bearer ${token}` }, params: { page_size: 200 }, timeout: 12000 }
      );
      const items = (r.data && r.data.data && r.data.data.items) || [];
      for (const it of items) {
        const f = it.fields || {};
        const rowName = textVal(f['Name']).trim().toLowerCase();
        const person = Array.isArray(f['Person']) ? f['Person'][0] : null;
        const personId = person && person.id;
        const personEmail = person && (person.email || '').toLowerCase();
        const openIdText = textVal(f['Open ID']).trim();

        const match =
          (email && (personEmail === email)) ||
          (name && rowName === name.toLowerCase()) ||
          (name && rowName && (rowName.includes(name.toLowerCase()) || name.toLowerCase().includes(rowName)));

        if (match) {
          if (openIdText.startsWith('ou_')) return openIdText;
          if (personId && String(personId).startsWith('ou_')) return personId;
        }
      }
    } catch (_) {
      // fall through to hardcoded map
    }

    // 3. Hardcoded fallback by first name.
    const first = (name.split(/\s+/)[0] || '').toLowerCase();
    if (first && OPEN_ID_FALLBACK[first]) return OPEN_ID_FALLBACK[first];

    return null;
  } catch (_) {
    return null;
  }
}

// ── listMyTasks ─────────────────────────────────────────────────────────────
/**
 * List tasks owned by a given open_id (Owner User field contains open_id).
 * Uses the Bitable /records/search endpoint with a User-contains filter.
 * Paginates via page_token. Returns [] on any error (never throws).
 * @returns {Promise<Array<{record_id,task,clientName,status,priority,pillar,prompt,dueDate}>>}
 */
async function listMyTasks(openId) {
  if (!openId || !String(openId).startsWith('ou_')) return [];
  try {
    const token = await larkToken();
    const clientMap = await getClientMap();
    const url = `${LARK_BASE}/open-apis/bitable/v1/apps/${OPS_APP_TOKEN}/tables/${TASKS_TABLE_ID}/records/search`;
    const rows = [];
    let pageToken = undefined;
    let guard = 0;
    do {
      const body = {
        filter: {
          conjunction: 'and',
          conditions: [{ field_name: 'Owner', operator: 'contains', value: [openId] }],
        },
        page_size: 100,
      };
      const params = {};
      if (pageToken) params.page_token = pageToken;
      const r = await axios.post(url, body, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        params,
        timeout: 15000,
      });
      const data = (r.data && r.data.data) || {};
      const items = data.items || [];
      for (const it of items) rows.push(normalizeRow(it, clientMap));
      pageToken = data.has_more ? data.page_token : undefined;
      guard += 1;
    } while (pageToken && guard < 20);
    return rows;
  } catch (_) {
    return [];
  }
}

// ── updateTaskStatus ────────────────────────────────────────────────────────
/**
 * Update a task record's status (and optionally a result note).
 * Writes ONLY the confirmed field NAMES that exist:
 *   Status         -> string (SingleSelect value)
 *   Result / Output-> string (Text); when status=Completed and no note given,
 *                     stamps an ISO completion timestamp; when a note is given
 *                     while completing, the ISO timestamp is appended.
 *   Owner          -> [{ id: openId }]  (ONLY if openId is passed; User fields
 *                     accept the [{id}] shape). Never written otherwise so we
 *                     don't clobber the existing owner.
 *   <COMPLETED_FIELD> -> epoch ms, ONLY if OPS_ENGINE_COMPLETED_FIELD env names
 *                        a real DateTime field (no bogus field invented).
 * @returns {Promise<{ok:boolean, record_id?:string, error?:string}>}
 */
async function updateTaskStatus(recordId, opts = {}) {
  if (!recordId) return { ok: false, error: 'recordId required' };
  const { status, resultNote, openId } = opts;

  try {
    const token = await larkToken();
    const fields = {};

    if (typeof status === 'string' && status) fields['Status'] = status;

    const isCompleted =
      typeof status === 'string' && /complete|done/i.test(status);

    if (typeof resultNote === 'string' && resultNote) {
      fields['Result / Output'] = isCompleted
        ? `${resultNote}\n\nCompleted: ${new Date().toISOString()}`
        : resultNote;
    } else if (isCompleted) {
      fields['Result / Output'] = `Completed: ${new Date().toISOString()}`;
    }

    if (isCompleted && COMPLETED_FIELD) {
      fields[COMPLETED_FIELD] = Date.now(); // epoch ms
    }

    if (typeof openId === 'string' && openId.startsWith('ou_')) {
      fields['Owner'] = [{ id: openId }];
    }

    if (!Object.keys(fields).length) {
      return { ok: false, error: 'nothing to update' };
    }

    const r = await axios.put(
      `${LARK_BASE}/open-apis/bitable/v1/apps/${OPS_APP_TOKEN}/tables/${TASKS_TABLE_ID}/records/${recordId}`,
      { fields },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    if (r.data && r.data.code === 0) {
      return { ok: true, record_id: (r.data.data && r.data.data.record && r.data.data.record.record_id) || recordId };
    }
    return { ok: false, error: `Bitable code=${r.data && r.data.code} msg=${r.data && r.data.msg}` };
  } catch (e) {
    const detail = (e.response && e.response.data) || e.message;
    return { ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail) };
  }
}

module.exports = {
  resolveOpenId,
  listMyTasks,
  updateTaskStatus,
  // exported for testing / reuse
  _internal: { larkToken, normalizeRow, textVal, linkText, linkRecordIds, getClientMap, OPEN_ID_FALLBACK, OPS_APP_TOKEN, TASKS_TABLE_ID, TEAM_TABLE_ID, CLIENTS_TABLE_ID },
};
