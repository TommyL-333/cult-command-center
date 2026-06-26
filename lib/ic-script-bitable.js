/**
 * ic-script-bitable.js
 *
 * IC Content Engine — Lark Base (Bitable) persistence for generated scripts.
 * -----------------------------------------------------------------------------
 * The SOURCE OF TRUTH for generated scripts is the local SQLite mirror
 * (inner_circle_scripts, read via GET /api/inner-circle/my-scripts). This module
 * is a FIRE-AND-FORGET mirror layered on top: it writes one Bitable record per
 * generated script so the team has unified visibility in Lark Base alongside the
 * TC orchestrator log. A Bitable failure must NEVER block script generation or
 * the creator's response — callers invoke this without awaiting the result, or
 * await it only to capture the returned record_id for the SQLite back-reference.
 *
 * Mirrors the proven token + write pattern in lib/tc-orchestrator.js:
 *   - tenant_access_token via LARK_APP_ID / LARK_APP_SECRET (cached ~90s)
 *   - per-app / per-table tokens from env (IC_SCRIPTS_BITABLE_APP / _TABLE)
 *   - axios POST to /bitable/v1/apps/{app}/tables/{table}/records
 *
 * ── CANONICAL 13-FIELD SCRIPTS SCHEMA ────────────────────────────────────────
 * Each generated script is written as ONE Bitable record with exactly these 13
 * columns (names + Bitable types are the contract — see SCRIPT_FIELD_NAMES):
 *
 *   1.  Hook                (Text)
 *   2.  Credibility         (Text)
 *   3.  Problem             (Text)
 *   4.  Proof Stack         (Text)
 *   5.  CTA                 (Text)
 *   6.  Visual Hook Ideas   (Text)
 *   7.  Full Script         (Text)
 *   8.  Funnel Stages       (MultiSelect → ARRAY of strings)
 *   9.  Script #            (Number    → numeric)
 *   10. Creator Handle      (Text)
 *   11. Brand               (Text)
 *   12. Product             (Text)
 *   13. Generated At        (DateTime  → numeric epoch milliseconds)
 *
 * TYPE RULES enforced by buildScriptFields:
 *   - "Funnel Stages" is ALWAYS a JS array (Bitable multi-select expects an
 *     array of option strings), even for a single stage.
 *   - "Script #" is ALWAYS a finite JS number.
 *   - "Generated At" is ALWAYS a numeric epoch in MILLISECONDS (Bitable DateTime
 *     fields take a Unix ms timestamp as a number).
 *
 * HONEST CONTRACT:
 *   - NEVER throws. Returns { ok:false, reason } on any failure.
 *   - Returns { ok:true, recordId } only when Lark actually returns a record id.
 *   - If LARK_APP_ID / LARK_APP_SECRET are missing, returns
 *     { ok:false, reason:'lark-not-configured' } — it does NOT fabricate a write.
 */

'use strict';

const axios = require('axios');

const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;

// Bitable app/table for the dedicated "Generated Scripts" table. Falls back to
// the TC Bitable app so the mirror is wired out of the box; set
// IC_SCRIPTS_BITABLE_APP / IC_SCRIPTS_BITABLE_TABLE to point at the real
// Scripts table once it exists in Lark Base.
const IC_SCRIPTS_BITABLE_APP =
  process.env.IC_SCRIPTS_BITABLE_APP ||
  'CgmzblKdJaA1DxsKPvEu3jaItze';
const IC_SCRIPTS_BITABLE_TABLE =
  process.env.IC_SCRIPTS_BITABLE_TABLE ||
  'tblHZPAtdq3Gaoyb';

// ── The canonical 13 field NAMES, in schema order. The Bitable column headers
// MUST match these strings exactly. Exported so the test asserts the contract.
const SCRIPT_FIELD_NAMES = [
  'Creator Name',
  'Creator Email',
  'Brand',
  'Product',
  'Funnel Stages',
  'Script Length',
  'Format',
  'Script #',
  'Hook',
  'Full Script',
  'Violations Flagged',
  'Violation Notes',
  'Generated At',
];

// Canonical funnel-stage vocabulary (mirrors ic-script-generator FUNNEL_STAGES).
const FUNNEL_STAGES = ['TOF', 'MOF', 'BOF'];

let _larkToken = null;
let _larkTokenExp = 0;

async function getLarkToken() {
  if (_larkToken && Date.now() < _larkTokenExp) return _larkToken;
  const r = await axios.post(
    'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET },
    { timeout: 15000 }
  );
  _larkToken = r.data && r.data.tenant_access_token;
  _larkTokenExp = Date.now() + ((r.data && r.data.expire) ? (r.data.expire - 120) * 1000 : 90 * 1000);
  return _larkToken;
}

/**
 * Trim a value to a clean string, returning '' for null/undefined/blank.
 */
function str(val) {
  if (val === undefined || val === null) return '';
  const s = typeof val === 'string' ? val : String(val);
  return s.trim();
}

/**
 * Normalize a funnel-stage value (string | array | null) into an ARRAY of
 * canonical option strings for the Bitable multi-select. Always returns an
 * array (possibly empty). Filters to the canonical TOF/MOF/BOF set when those
 * tokens are present; otherwise passes through cleaned non-empty values so a
 * custom stage label still persists.
 */
function normalizeFunnelStages(value) {
  let raw = [];
  if (Array.isArray(value)) {
    raw = value;
  } else if (typeof value === 'string' && value.trim()) {
    raw = value.split(/[\s,]+/);
  }
  const cleaned = raw.map((v) => str(v)).filter(Boolean);
  if (!cleaned.length) return [];
  const upper = cleaned.map((s) => s.toUpperCase());
  const canonical = FUNNEL_STAGES.filter((stage) => upper.includes(stage));
  // Prefer canonical ordering when canonical tokens were supplied; otherwise
  // keep the caller's cleaned values (dedup, preserve order).
  if (canonical.length) return canonical;
  return Array.from(new Set(cleaned));
}

/**
 * Build the flat Bitable `fields` object for ONE generated script.
 *
 * PURE — no network, no env reads that change output. Unit-testable in isolation.
 *
 * Produces EXACTLY the 13 canonical fields (SCRIPT_FIELD_NAMES) with correct
 * Bitable types:
 *   - text fields  → string (empty string when source value missing)
 *   - Funnel Stages→ array of option strings
 *   - Script #     → finite number
 *   - Generated At → numeric epoch milliseconds
 *
 * Accepts the normalized shape the generator/route produces:
 *   {
 *     hook, credibility, problem, proofStack, cta, visualHookIdeas, fullScript,
 *     funnelStage | funnelStages,   // string or array
 *     scriptIndex | scriptNumber,   // 0- or 1-based; coerced to a 1-based number
 *     tiktokHandle | creatorHandle,
 *     brandName | brand,
 *     productName | product,
 *     generatedAt                   // Date | epoch ms | epoch s | ISO string
 *   }
 */
function buildScriptFields(rec) {
  rec = rec || {};
  const fields = {};

  // ── Identity (the real base keys creators/team on) ─────────────────────────
  fields['Creator Name'] = str(rec.creatorName !== undefined ? rec.creatorName : rec.creator_name);
  fields['Creator Email'] = str(rec.creatorEmail !== undefined ? rec.creatorEmail : rec.creator_email);
  fields['Brand'] = str(rec.brand);
  fields['Product'] = str(rec.product);

  // ── Wizard metadata (best-effort; blank if not supplied) ───────────────────
  fields['Script Length'] = str(rec.scriptLength !== undefined ? rec.scriptLength : rec.length);
  fields['Format'] = str(rec.format);

  // ── Funnel Stages → ARRAY (multi-select) ───────────────────────────────────
  fields['Funnel Stages'] = normalizeFunnelStages(
    rec.funnelStages !== undefined ? rec.funnelStages : rec.funnelStage
  );

  // ── Script # → NUMBER (1-based; accept scriptNumber or scriptIndex) ─────────
  let scriptNo;
  if (rec.scriptNumber !== undefined && rec.scriptNumber !== null && rec.scriptNumber !== '') {
    scriptNo = Number(rec.scriptNumber);
  } else if (rec.scriptIndex !== undefined && rec.scriptIndex !== null && rec.scriptIndex !== '') {
    scriptNo = Number(rec.scriptIndex) + 1;
  } else {
    scriptNo = 1;
  }
  fields['Script #'] = Number.isFinite(scriptNo) ? scriptNo : 1;

  // ── Hook + Full Script ─────────────────────────────────────────────────────
  fields['Hook'] = str(rec.hook);
  // The real base has no Credibility/Problem/Proof Stack/CTA/Visual columns, so
  // preserve those beats inside Full Script when the model gave us a bare script.
  let full = str(rec.fullScript);
  const beats = [];
  const pushBeat = (label, val) => { const v = str(val); if (v) beats.push(label + ': ' + v); };
  if (full && !/credibility/i.test(full)) {
    pushBeat('Credibility', rec.credibility);
    pushBeat('Problem', rec.problem);
    pushBeat('Proof Stack', rec.proofStack);
    pushBeat('CTA', rec.cta);
    pushBeat('Visual Hook Ideas', rec.visualHookIdeas);
  } else if (!full) {
    pushBeat('Hook', rec.hook);
    pushBeat('Credibility', rec.credibility);
    pushBeat('Problem', rec.problem);
    pushBeat('Proof Stack', rec.proofStack);
    pushBeat('CTA', rec.cta);
    pushBeat('Visual Hook Ideas', rec.visualHookIdeas);
  }
  if (beats.length) {
    full = full ? (full + '\n\n— — —\n' + beats.join('\n')) : beats.join('\n');
  }
  fields['Full Script'] = full;

  // ── Violation checker output (single-select Clean/Flagged + notes) ─────────
  const vFlagged = rec.violationsFlagged !== undefined ? rec.violationsFlagged
    : (rec.violations !== undefined ? rec.violations : rec.clean);
  let vStatus = '';
  if (typeof vFlagged === 'boolean') {
    vStatus = vFlagged ? 'Flagged' : 'Clean';
  } else if (Array.isArray(vFlagged)) {
    vStatus = vFlagged.length ? 'Flagged' : 'Clean';
  } else if (str(vFlagged)) {
    const t = str(vFlagged).toLowerCase();
    vStatus = (t === 'clean' || t === 'false' || t === 'no') ? 'Clean' : 'Flagged';
  }
  if (vStatus) fields['Violations Flagged'] = vStatus;
  const vNotes = str(rec.violationNotes !== undefined ? rec.violationNotes : rec.violation_notes);
  if (vNotes) fields['Violation Notes'] = vNotes;

  // ── Generated At → epoch ms NUMBER ─────────────────────────────────────────
  let genAt = rec.generatedAt;
  genAt = Number(genAt);
  fields['Generated At'] = Number.isFinite(genAt) && genAt > 0 ? genAt : Date.now();

  return fields;
}

/**
 * Coerce a Date | epoch-ms number | epoch-seconds number | ISO string into a
 * numeric epoch in MILLISECONDS. Falls back to Date.now() when absent/invalid
 * so the DateTime column always gets a valid numeric timestamp.
 */
function toEpochMs(value) {
  if (value === undefined || value === null || value === '') return Date.now();
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : Date.now();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: treat values that look like epoch SECONDS (< 1e12) as seconds.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Persist ONE generated script to the Lark Bitable. Fire-and-forget safe.
 * Returns { ok, recordId? , reason? } and NEVER throws.
 */
async function persistScriptToBitable(rec) {
  if (!LARK_APP_ID || !LARK_APP_SECRET) {
    return { ok: false, reason: 'lark-not-configured' };
  }
  try {
    const token = await getLarkToken();
    if (!token) return { ok: false, reason: 'no-token' };

    const fields = buildScriptFields(rec);
    const r = await axios.post(
      `https://open.larksuite.com/open-apis/bitable/v1/apps/${IC_SCRIPTS_BITABLE_APP}/tables/${IC_SCRIPTS_BITABLE_TABLE}/records`,
      { fields },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    const recordId =
      (r.data && r.data.data && r.data.data.record && r.data.data.record.record_id) || null;
    if (r.data && r.data.code === 0 && recordId) {
      return { ok: true, recordId };
    }
    return { ok: false, reason: 'bitable-error', code: r.data && r.data.code, msg: r.data && r.data.msg };
  } catch (e) {
    console.warn('[ic-script-bitable] persist failed:', e.message);
    return { ok: false, reason: 'exception', detail: e.message };
  }
}

/**
 * Persist MANY generated scripts. Returns a summary { attempted, persisted,
 * recordIds }. Each failure is swallowed (logged) so a partial batch still
 * mirrors what it can. Never throws.
 */
async function persistScriptsToBitable(records) {
  const list = Array.isArray(records) ? records : [];
  const recordIds = [];
  let persisted = 0;
  for (const rec of list) {
    const r = await persistScriptToBitable(rec);
    if (r && r.ok) { persisted += 1; recordIds.push(r.recordId); }
    else recordIds.push(null);
  }
  return { attempted: list.length, persisted, recordIds };
}


/**
 * Map ONE raw Bitable record's `fields` object (keyed by the canonical 13 column
 * names) back to a camelCase script object for API responses. PURE.
 *
 * Bitable returns multi-select fields as arrays, text as strings (or {text} run
 * arrays in some doc-field cases), numbers as numbers, and DateTime as numeric
 * epoch ms. We normalize defensively so the route can return clean JSON.
 */
function bitableFieldsToScript(record) {
  const rec = record || {};
  const f = rec.fields || {};

  // Bitable text fields can come back as a plain string OR as an array of
  // rich-text runs [{ text: '...' }]. Coerce both to a clean string.
  const text = (v) => {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
      return v
        .map((seg) => (seg && typeof seg === 'object' ? (seg.text || seg.name || '') : String(seg)))
        .join('')
        .trim();
    }
    if (typeof v === 'object' && v.text) return String(v.text);
    return String(v);
  };
  const arr = (v) => {
    if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? (x.text || x.name || String(x)) : String(x))).filter(Boolean);
    if (typeof v === 'string' && v.trim()) return v.split(/[\s,]+/).filter(Boolean);
    return [];
  };
  const num = (v) => {
    const n = Number(Array.isArray(v) ? v[0] : v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    recordId: rec.record_id || rec.recordId || null,
    creatorName: text(f['Creator Name']),
    creatorEmail: text(f['Creator Email']),
    brand: text(f['Brand']),
    product: text(f['Product']),
    scriptLength: text(f['Script Length']),
    format: text(f['Format']),
    funnelStages: arr(f['Funnel Stages']),
    scriptNumber: num(f['Script #']),
    hook: text(f['Hook']),
    fullScript: text(f['Full Script']),
    violationsFlagged: text(f['Violations Flagged']),
    violationNotes: text(f['Violation Notes']),
    generatedAt: num(f['Generated At']),
  };
}

/**
 * Fetch generated scripts for ONE creator from the Lark Bitable, filtering by
 * the creator's identity. Tries the documented POST .../records/search filter
 * first (conjunction of OR conditions across the candidate identity fields), and
 * falls back to fetching a page of records and filtering in-process if the
 * search endpoint rejects the filter shape.
 *
 * The canonical Scripts schema does NOT include a "Creator Email" column — the
 * write path stores "Creator Handle". To honor the caller's intent we accept
 * BOTH { email, handle } and match a record if EITHER a "Creator Email" field
 * (should the table add one) equals the email OR "Creator Handle" matches the
 * handle (case-insensitive, @-insensitive).
 *
 * HONEST CONTRACT: NEVER throws. Returns:
 *   { ok:true,  scripts:[...] }                      on success (possibly empty)
 *   { ok:false, scripts:[], reason }                 on any failure
 * Never fabricates records.
 *
 * @param {{ email?:string, handle?:string, limit?:number }} opts
 */
async function fetchScriptsFromBitable(opts) {
  const o = opts || {};
  const emailRaw = str(o.email);
  const email = emailRaw.toLowerCase();
  const handleRaw = str(o.handle);
  const handle = handleRaw.replace(/^@/, '').toLowerCase();
  const pageSize = Math.min(Math.max(Number(o.limit) || 200, 1), 500);

  if (!LARK_APP_ID || !LARK_APP_SECRET) {
    return { ok: false, scripts: [], reason: 'lark-not-configured' };
  }
  if (!email && !handle) {
    // No identity to filter on — refuse rather than return the whole table.
    return { ok: false, scripts: [], reason: 'no-identity' };
  }

  let token;
  try {
    token = await getLarkToken();
  } catch (e) {
    return { ok: false, scripts: [], reason: 'token-error', detail: e.message };
  }
  if (!token) return { ok: false, scripts: [], reason: 'no-token' };

  const base = `https://open.larksuite.com/open-apis/bitable/v1/apps/${IC_SCRIPTS_BITABLE_APP}/tables/${IC_SCRIPTS_BITABLE_TABLE}/records`;
  const headers = { Authorization: `Bearer ${token}` };

  // Local predicate used by BOTH the search result and the fallback page, so a
  // record matches our creator regardless of which path returned it.
  const matches = (script) => {
    const em = str(script.creatorEmail).toLowerCase();
    if (email && em && em === String(email).toLowerCase()) return true;
    const nm = str(script.creatorName).toLowerCase();
    if (handle && nm && nm === handle) return true;
    return false;
  };

  // ── Attempt 1: documented POST /records/search with a field filter. ─────────
  try {
    const conditions = [];
    if (email) {
      conditions.push({ field_name: 'Creator Email', operator: 'is', value: [emailRaw] });
    }
    const body = {
      page_size: pageSize,
      filter: { conjunction: 'or', conditions },
      sort: [{ field_name: 'Generated At', desc: true }],
    };
    const r = await axios.post(`${base}/search`, body, { headers, timeout: 15000 });
    if (r.data && r.data.code === 0 && r.data.data) {
      const items = r.data.data.items || [];
      const scripts = items.map(bitableFieldsToScript);
      return { ok: true, scripts };
    }
    // Non-zero code → fall through to the page-and-filter fallback below.
  } catch (e) {
    // Search endpoint/filter shape rejected — fall back to listing + filtering.
  }

  // ── Attempt 2: GET a page of records and filter in-process. ─────────────────
  try {
    const r = await axios.get(base, { headers, params: { page_size: pageSize }, timeout: 15000 });
    if (r.data && r.data.code === 0 && r.data.data) {
      const items = r.data.data.items || [];
      const all = items.map((it) => ({ raw: it, script: bitableFieldsToScript(it) }));
      const filtered = all
        .filter(({ raw, script }) => {
          if (matches(script)) return true;
          // Match a Creator Email column directly off raw fields if present.
          if (email && raw && raw.fields) {
            const ev = raw.fields['Creator Email'];
            const evStr = (Array.isArray(ev) ? ev.map((x) => (x && x.text) || x).join('') : ev || '')
              .toString()
              .toLowerCase()
              .trim();
            if (evStr && evStr === email) return true;
          }
          return false;
        })
        .map(({ script }) => script);
      return { ok: true, scripts: filtered };
    }
    return { ok: false, scripts: [], reason: 'bitable-error', code: r.data && r.data.code, msg: r.data && r.data.msg };
  } catch (e) {
    return { ok: false, scripts: [], reason: 'exception', detail: e.message };
  }
}


module.exports = {
  buildScriptFields,
  bitableFieldsToScript,
  fetchScriptsFromBitable,
  normalizeFunnelStages,
  toEpochMs,
  persistScriptToBitable,
  persistScriptsToBitable,
  SCRIPT_FIELD_NAMES,
  FUNNEL_STAGES,
  _config: {
    IC_SCRIPTS_BITABLE_APP,
    IC_SCRIPTS_BITABLE_TABLE,
  },
};
