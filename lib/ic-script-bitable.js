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
 *   - per-app / per-table tokens from env (IC_SCRIPTS_BITABLE_APP / _TABLE),
 *     defaulting to the TC Bitable app so this works out of the box and can be
 *     pointed at a dedicated Scripts table by setting the env vars.
 *   - axios POST to /bitable/v1/apps/{app}/tables/{table}/records
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

// Default to the TC Bitable app so the mirror works without extra config; set
// IC_SCRIPTS_BITABLE_APP / IC_SCRIPTS_BITABLE_TABLE to point at a dedicated
// "Generated Scripts" table once it exists in Lark Base.
const IC_SCRIPTS_BITABLE_APP =
  process.env.IC_SCRIPTS_BITABLE_APP ||
  process.env.TC_BITABLE_APP ||
  'XN3XbuvcvazZZlsGY5guebJ1t3f';
const IC_SCRIPTS_BITABLE_TABLE =
  process.env.IC_SCRIPTS_BITABLE_TABLE ||
  process.env.TC_BITABLE_TABLE ||
  'tblxUVxtEonKkVWg';

// Primary text field name in the target table. Lark Bitable requires the first
// (primary) field to be set. Override with IC_SCRIPTS_PRIMARY_FIELD if the table
// uses a different primary column header.
const IC_SCRIPTS_PRIMARY_FIELD = process.env.IC_SCRIPTS_PRIMARY_FIELD || 'Hook';

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
 * Build the flat Bitable `fields` object from a generated-script record.
 * PURE — no network, no env reads that change output. Unit-testable in isolation.
 *
 * Accepts the normalized shape the generator/route produces:
 *   {
 *     creatorId, creatorName, tiktokHandle,
 *     brandId, brandName, shopId, productName, funnelStage,
 *     hook, title, fullScript, script (object) | scriptJson (string)
 *   }
 * Unknown/empty values are omitted so we never write null into typed columns.
 */
function buildScriptFields(rec) {
  rec = rec || {};
  const fields = {};

  // Primary field MUST be set — use the hook (the most identifying line),
  // falling back to title, product, or a generic label.
  const primary =
    (rec.hook && String(rec.hook).trim()) ||
    (rec.title && String(rec.title).trim()) ||
    (rec.productName && String(rec.productName).trim()) ||
    'IC script';
  fields[IC_SCRIPTS_PRIMARY_FIELD] = primary.slice(0, 500);

  const put = (key, val) => {
    if (val === undefined || val === null) return;
    const s = typeof val === 'string' ? val : String(val);
    if (s.trim() === '') return;
    fields[key] = s;
  };

  put('Title', rec.title);
  put('Hook', rec.hook);
  put('Creator', rec.creatorName);
  put('Creator Handle', rec.tiktokHandle);
  if (rec.creatorId !== undefined && rec.creatorId !== null && rec.creatorId !== '') {
    const n = Number(rec.creatorId);
    fields['Creator ID'] = Number.isFinite(n) ? n : String(rec.creatorId);
  }
  put('Brand', rec.brandName);
  put('Brand ID', rec.brandId);
  if (rec.shopId !== undefined && rec.shopId !== null && rec.shopId !== '') {
    const n = Number(rec.shopId);
    fields['Shop ID'] = Number.isFinite(n) ? n : String(rec.shopId);
  }
  put('Product', rec.productName);
  put('Funnel Stage', rec.funnelStage);
  put('Full Script', rec.fullScript);

  // Store the structured script JSON for downstream tooling. Accept either a
  // pre-stringified scriptJson or a script object to serialize.
  let scriptJson = null;
  if (rec.scriptJson && typeof rec.scriptJson === 'string') {
    scriptJson = rec.scriptJson;
  } else if (rec.script && typeof rec.script === 'object') {
    try { scriptJson = JSON.stringify(rec.script); } catch (_) { scriptJson = null; }
  }
  if (scriptJson) fields['Script JSON'] = scriptJson.slice(0, 9000);

  return fields;
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

module.exports = {
  buildScriptFields,
  persistScriptToBitable,
  persistScriptsToBitable,
  _config: {
    IC_SCRIPTS_BITABLE_APP,
    IC_SCRIPTS_BITABLE_TABLE,
    IC_SCRIPTS_PRIMARY_FIELD,
  },
};
