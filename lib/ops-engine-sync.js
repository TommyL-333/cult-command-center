// ops-engine-sync.js
// Syncs a client onboarding submission into the Ops Engine Lark Base:
//   1. Upserts a Clients row (keyed by Reacher Shop ID or Brand name)
//   2. Spawns one Live Task per Task Template (excluding Tooling-Provided rows),
//      linked to the client, carrying Pillar/Phase/Role/Execution Mode/Auto/Prompt/SOP.
//
// HONEST: never throws into the caller — every Lark failure is caught and logged.
// Fire-and-forget from runOnboardingPipeline. Requires LARK_APP_ID / LARK_APP_SECRET.
const axios = require('axios');

const APP = process.env.OPS_ENGINE_BASE || 'EsfBbIqfkauKozsxMHMuilDztod';
const T = {
  Clients:   'tblgM1L7myeAfYQm',
  LiveTasks: 'tbl7XaSc37mtcBKg',
  Templates: 'tbl3M7PFNZGKZW5J',
};
const BASE = 'https://open.larksuite.com/open-apis';

async function tenantToken() {
  const r = await axios.post(`${BASE}/auth/v3/tenant_access_token/internal`, {
    app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET,
  });
  return r.data.tenant_access_token;
}
function H(t) { return { headers: { Authorization: `Bearer ${t}` } }; }
function txt(v) {
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.map(txt).join(',');
  if ('text' in v) return v.text;
  return '';
}
function num(v) { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? undefined : n; }

async function listAll(t, table) {
  let items = [], pt = '';
  do {
    const r = await axios.get(`${BASE}/bitable/v1/apps/${APP}/tables/${table}/records?page_size=100${pt ? `&page_token=${pt}` : ''}`, H(t));
    items = items.concat(r.data.data.items || []);
    pt = r.data.data.page_token;
  } while (pt);
  return items;
}

// --- 1. Upsert the Clients row, return its record_id ---
async function upsertClient(t, formData, meta) {
  const brandName = formData.brandName;
  const shopId = String(formData.reacherShopId || formData.shopId || '').trim();
  const comp = formData.compensation || {};

  const fields = {
    'Brand': brandName,
    'First Name': formData.firstName || '',
    'Email': (formData.email || brand?.loginEmail || '').toLowerCase(),
    'Phone': formData.phone || '',
    'Website': formData.website ? { link: formData.website, text: formData.website } : undefined,
    'Status': 'Onboarding',
    'Phase': 'Setup',
    'Onboarded On': Date.now(),
  };
  if (meta && meta.larkDocUrl) fields['Client Overview Doc'] = { link: meta.larkDocUrl, text: 'Overview' };
  if (shopId) fields['Reacher Shop ID'] = shopId;
  // Budgets from onboarding form
  const retainer = num(formData.affiliateRetainerBudget ?? formData.monthlyRetainer ?? comp.retainerBudget);
  if (retainer !== undefined) fields['Affiliate Retainer Budget'] = retainer;
  const sample = num(formData.sampleBudget ?? formData.targetSamples ?? comp.sampleBudget);
  if (sample !== undefined) fields['Sample Budget'] = sample;
  const ugc = num(formData.ugcBudget ?? formData.joinBrandsBudget);
  if (ugc !== undefined) { fields['UGC Budget'] = ugc; fields['JoinBrands Budget'] = ugc; }
  if (formData.sampleBudgetNotes) fields['Sample Budget Notes'] = String(formData.sampleBudgetNotes);
  const tcComm = num(comp.tcCommission ?? formData.tcCommission);
  if (tcComm !== undefined) fields['TC Commission %'] = tcComm;
  const adsComm = num(comp.adsCommission ?? formData.adsCommission);
  if (adsComm !== undefined) fields['Ads Commission %'] = adsComm;
  const netComm = num(comp.netSalesCommission ?? formData.netSalesCommission);
  if (netComm !== undefined) fields['Net Sales Commission %'] = netComm;
  if (formData.product) fields['Product'] = formData.product;
  if (formData.objective) fields['Objective'] = formData.objective;
  // Promotional strategy (set once at onboarding)
  const FLASH_OPTS = ['None','Weekly','Bi-weekly','Monthly'];
  if (formData.flashSaleCadence && FLASH_OPTS.includes(formData.flashSaleCadence)) fields['Flash Sale Cadence'] = formData.flashSaleCadence;
  if (formData.freeShipThreshold) fields['Free Shipping Threshold'] = String(formData.freeShipThreshold);
  if (formData.bundleStrategy) fields['Bundle / GWP Strategy'] = String(formData.bundleStrategy);
  if (formData.sampleAutoApprove === 'Yes' || formData.sampleAutoApprove === 'No') fields['Sample Auto-Approve?'] = formData.sampleAutoApprove;
  if (formData.sampleApprovalCriteria) fields['Sample Approval Criteria'] = String(formData.sampleApprovalCriteria);

  // strip undefineds
  Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

  // Find existing by Shop ID first, else Brand name
  const existing = await listAll(t, T.Clients);
  let match = null;
  if (shopId) match = existing.find(r => txt(r.fields['Reacher Shop ID']).trim() === shopId);
  if (!match) match = existing.find(r => txt(r.fields['Brand']).trim().toLowerCase() === String(brandName).trim().toLowerCase());

  if (match) {
    await axios.put(`${BASE}/bitable/v1/apps/${APP}/tables/${T.Clients}/records/${match.record_id}`, { fields }, H(t));
    return { recordId: match.record_id, created: false };
  }
  const r = await axios.post(`${BASE}/bitable/v1/apps/${APP}/tables/${T.Clients}/records`, { fields }, H(t));
  return { recordId: r.data.data.record.record_id, created: true };
}

// --- 2. Spawn Live Tasks from Templates ---
async function spawnTasks(t, clientRecordId, brandName) {
  const templates = await listAll(t, T.Templates);
  const spawn = templates.filter(tp => {
    const mode = txt(tp.fields['Execution Mode']).trim();
    return mode && mode !== 'Tooling-Provided (Affiliate/Client)';
  });

  // Avoid duplicate spawn: check existing tasks already linked to this client
  const existingTasks = await listAll(t, T.LiveTasks);
  const already = new Set(
    existingTasks
      .filter(et => (et.fields['Client'] || []).some?.(l => l.record_ids?.includes?.(clientRecordId)) ||
                    txt(et.fields['Client']).includes(brandName))
      .map(et => txt(et.fields['Task']).trim())
  );

  let created = 0;
  for (const tp of spawn) {
    const name = txt(tp.fields['Task Name']).trim();
    if (!name || already.has(name)) continue;
    const mode = txt(tp.fields['Execution Mode']).trim();
    const fields = {
      'Task': name,
      'Client': [clientRecordId],
      'Status': 'To Do',
      'Pillar': txt(tp.fields['Pillar']).trim() || undefined,
      'Phase': txt(tp.fields['Phase']).trim() || undefined,
      'Role': txt(tp.fields['Role']).trim() || undefined,
      'Execution Mode': mode,
      'Auto?': mode === 'Sisyphus — Full Auto',
      'Prompt / Action': txt(tp.fields['Prompt / Action']).trim() || undefined,
      'SOP Link': tp.fields['SOP Link'] || undefined,
      'Created On': Date.now(),
    };
    Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);
    try {
      await axios.post(`${BASE}/bitable/v1/apps/${APP}/tables/${T.LiveTasks}/records`, { fields }, H(t));
      created++;
    } catch (e) {
      console.error(`[ops-sync] task spawn failed (${name}):`, JSON.stringify(e.response?.data || e.message).slice(0, 160));
    }
  }
  return { created, eligible: spawn.length };
}

// --- public entry ---
async function syncClientToOpsEngine(formData, meta = {}) {
  try {
    if (!process.env.LARK_APP_ID || !process.env.LARK_APP_SECRET) {
      console.warn('[ops-sync] LARK creds missing — skipping ops engine sync');
      return { ok: false, reason: 'no-lark-creds' };
    }
    const t = await tenantToken();
    const client = await upsertClient(t, formData, meta);
    const tasks = await spawnTasks(t, client.recordId, formData.brandName);
    console.log(`[ops-sync] ${client.created ? 'created' : 'updated'} client ${formData.brandName} | spawned ${tasks.created}/${tasks.eligible} tasks`);
    return { ok: true, clientRecordId: client.recordId, clientCreated: client.created, tasksCreated: tasks.created };
  } catch (e) {
    console.error('[ops-sync] sync failed:', JSON.stringify(e.response?.data || e.message).slice(0, 200));
    return { ok: false, reason: e.message };
  }
}

module.exports = { syncClientToOpsEngine, _internals: { upsertClient, spawnTasks, listAll, tenantToken } };
