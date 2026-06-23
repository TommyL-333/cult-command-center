// lib/tc-orchestrator.js
// TC Orchestrator — owns the entire Target Collab section.
//
// One entry point: orchestrateTargetCollab(opts)
// Called by every creator-page signup hook. It:
//   1. Resolves the brand's TikTok product_id (required for a TC)
//   2. Sends the TC via the Reacher relay (/affiliate/tc-invite)
//   3. VERIFIES the automation actually reached a delivering state
//      (Running/Completed) instead of trusting the relay's ok:true,
//      which is FALSE when the automation is stuck "Stopped".
//   4. Classifies the outcome into a single enum
//   5. On NOT_DELIVERED / cold-creator, fires the open-collab fallback SMS
//   6. Logs EVERY signup + creator metrics + TC outcome to a Lark Bitable
//      for unified decision-making visibility.
//
// HONESTY: never reports SUCCESS unless the automation is verified live.
// All network calls are wrapped — the orchestrator never throws into the
// signup flow (fire-and-forget safe).

const axios = require('axios');
const crypto = require('crypto');

// ---- config -------------------------------------------------------------
const RELAY_BASE = process.env.AFFILIATE_RELAY_BASE || 'https://consultants.cultcontent.cc/affiliate';
const REACHER_BASE = 'https://api.reacherapp.com/public/v1';
const REACHER_KEY = process.env.REACHER_API_KEY;

const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
const TC_BITABLE_APP = process.env.TC_BITABLE_APP || 'XN3XbuvcvazZZlsGY5guebJ1t3f';
const TC_BITABLE_TABLE = process.env.TC_BITABLE_TABLE || 'tblxUVxtEonKkVWg';

// Default commission when brand doesn't specify (regular non-IC TC)
const DEFAULT_TC_COMMISSION = 25;   // percent
const ADS_FRACTION_OF_TC = 0.5;     // ads commission = half of TC

// TC outcome enum
const TC = {
  SUCCESS: 'SUCCESS',
  NOT_DELIVERED: 'NOT_DELIVERED',           // automation stuck Stopped (cold creator)
  CREATOR_NOT_FOUND: 'CREATOR_NOT_FOUND',   // relay/Reacher couldn't resolve handle
  NO_PRODUCT: 'NO_PRODUCT',                 // brand has no TikTok product to attach
  OUTREACH_LIMIT: 'OUTREACH_LIMIT',
  QUOTA_BLOCKED: 'QUOTA_BLOCKED',           // 20k followers + $2k GMV rule
  OPEN_COLLAB_DISABLED: 'OPEN_COLLAB_DISABLED',
  ERROR: 'ERROR',
};

// ---- helpers ------------------------------------------------------------
function rid() { return crypto.randomUUID(); }

let _larkToken = null, _larkTokenExp = 0;
async function larkToken() {
  if (_larkToken && Date.now() < _larkTokenExp) return _larkToken;
  const r = await axios.post(
    'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET },
    { timeout: 15000 }
  );
  _larkToken = r.data.tenant_access_token;
  _larkTokenExp = Date.now() + (r.data.expire ? (r.data.expire - 120) * 1000 : 90 * 1000);
  return _larkToken;
}

// Resolve a brand product_id by fuzzy-matching a product name, else first product.
async function resolveProduct(shopId, productNameHint) {
  try {
    const r = await axios.post(`${RELAY_BASE}/shops/${shopId}/products`, {},
      { timeout: 15000, validateStatus: () => true });
    const prods = r.data?.products || r.data?.data || [];
    if (!Array.isArray(prods) || prods.length === 0) return { ok: false, reason: 'no products on shop' };
    let chosen = prods[0];
    if (productNameHint) {
      const hint = String(productNameHint).toLowerCase();
      const match = prods.find(p =>
        String(p.product_name || p.name || '').toLowerCase().includes(hint) ||
        hint.includes(String(p.product_name || p.name || '').toLowerCase().slice(0, 12))
      );
      if (match) chosen = match;
    }
    return {
      ok: true,
      product_id: String(chosen.product_id || chosen.id),
      product_name: chosen.product_name || chosen.name || '',
      total: prods.length,
    };
  } catch (e) {
    return { ok: false, reason: 'product resolve error: ' + e.message };
  }
}

// Verify the just-created automation actually reaches a delivering state.
// Reacher creates TC automations in "Stopped" then they should flip to Running.
// We poll briefly; if it stays Stopped, the TC did NOT deliver.
async function verifyAutomationDelivered(shopId, automationId, { tries = 3, delayMs = 4000 } = {}) {
  if (!REACHER_KEY || !automationId) return { delivered: false, status: 'unknown', reason: 'no key/id' };
  const H = { headers: { 'x-api-key': REACHER_KEY, 'x-shop-id': String(shopId) }, timeout: 15000, validateStatus: () => true };
  for (let i = 0; i < tries; i++) {
    try {
      const r = await axios.post(`${REACHER_BASE}/automations/list`, { page: 1, page_size: 100 }, H);
      const list = r.data?.automations || r.data?.data || r.data?.items || [];
      const a = list.find(x => String(x.automation_id || x.id) === String(automationId));
      if (a) {
        const status = String(a.status || a.automation_status || '').toLowerCase();
        if (status === 'running' || status === 'completed') {
          return { delivered: true, status, raw: a };
        }
        if (status === 'stopped' && i === tries - 1) {
          return { delivered: false, status, reason: 'automation stuck Stopped — cold creator / not delivered', raw: a };
        }
      }
    } catch (_) { /* keep trying */ }
    if (i < tries - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  return { delivered: false, status: 'stopped', reason: 'automation did not reach Running/Completed' };
}

// Log one signup + TC outcome to the Lark Bitable.
async function logToBitable(rec) {
  try {
    const token = await larkToken();
    const H = { headers: { Authorization: `Bearer ${token}` }, timeout: 20000, validateStatus: () => true };
    const fields = {
      'Creator Handle': rec.handle || '',
      'Brand': rec.brandName || '',
      'Shop ID': String(rec.shopId || ''),
      'Signup Source': rec.source || 'creator-page',
      'TC Status': rec.status || TC.ERROR,
      'Reason': (rec.reason || '').slice(0, 900),
      'Resolution / Action': (rec.resolution || '').slice(0, 900),
      'Automation ID': rec.automationId ? String(rec.automationId) : '',
      'Product ID': rec.productId ? String(rec.productId) : '',
      'Commission %': typeof rec.commission === 'number' ? rec.commission : null,
      'Fallback SMS Sent': !!rec.fallbackSmsSent,
      'Followers': typeof rec.followers === 'number' ? rec.followers : null,
      'Email': rec.email || '',
      'Phone': rec.phone || '',
      'Timestamp': Date.now(),
    };
    // primary text field — use the creator handle so the row has a title
    fields[rec._primaryField || '文本'] = rec.handle || rec.brandName || 'signup';
    const r = await axios.post(
      `https://open.larksuite.com/open-apis/bitable/v1/apps/${TC_BITABLE_APP}/tables/${TC_BITABLE_TABLE}/records`,
      { fields }, H);
    return r.data?.code === 0;
  } catch (e) {
    console.warn('[tc-orchestrator] bitable log failed:', e.message);
    return false;
  }
}

// ---- main entry ---------------------------------------------------------
/**
 * orchestrateTargetCollab(opts)
 * @param {object} opts
 *   shopId        (number|string) required
 *   handle        (string) creator TikTok handle, required
 *   brandName     (string)
 *   productNameHint (string) optional — match a specific product
 *   tcCommission  (number) percent; defaults to 25
 *   email, phone, followers — for logging + fallback SMS
 *   source        (string) which form/flow fired this
 *   openCollabEnabled (bool) brand-level flag
 *   sendSms       (function async (phone, body)) injected SMS sender for fallback
 *   testMode      (bool) if true, only Tommy's phone is messaged
 * @returns {object} { status, reason, resolution, automationId, productId, delivered }
 */
async function orchestrateTargetCollab(opts = {}) {
  const {
    shopId, handle, brandName = '', productNameHint = '',
    tcCommission, email = '', phone = '', followers = null,
    source = 'creator-page', openCollabEnabled = false,
    sendSms = null, testMode = false,
  } = opts;

  const cleanHandle = String(handle || '').replace(/^@/, '').trim();
  const commission = (typeof tcCommission === 'number' && tcCommission > 0) ? tcCommission : DEFAULT_TC_COMMISSION;
  const adsCommission = +(commission * ADS_FRACTION_OF_TC).toFixed(2);

  const base = {
    handle: cleanHandle, brandName, shopId, source, email, phone,
    followers, commission,
  };

  // Guard: must have a handle and shop
  if (!cleanHandle || !shopId) {
    const out = { ...base, status: TC.ERROR, reason: 'missing handle or shopId', resolution: 'check signup payload' };
    await logToBitable(out);
    return out;
  }

  // 1) Resolve product
  const prod = await resolveProduct(shopId, productNameHint);
  if (!prod.ok) {
    const out = {
      ...base, status: TC.NO_PRODUCT,
      reason: prod.reason || 'no product available',
      resolution: 'Add a live TikTok Shop product for this brand before TCs can fire.',
    };
    await logToBitable(out);
    return out;
  }

  // 2) Send the TC via relay
  let automationId = null;
  try {
    const body = {
      shopId,
      handle: cleanHandle,
      products: [{ product_id: prod.product_id, commission_rate: +(commission / 100).toFixed(4) }],
      brandName,
      commission,
      shop_ads_commission_rate: +(adsCommission / 100).toFixed(4),
      message: `Hey! We'd love to collaborate with you on ${brandName} — ${commission}% commission. Click to view & accept the target collab. Excited to work together!`,
    };
    const r = await axios.post(`${RELAY_BASE}/tc-invite`, body, {
      timeout: 30000, headers: { 'Idempotency-Key': rid() }, validateStatus: () => true,
    });
    if (r.status >= 400) {
      const errStr = JSON.stringify(r.data || '').toLowerCase();
      let status = TC.ERROR, resolution = 'relay error';
      if (errStr.includes('not_found') || errStr.includes('could not be resolved')) {
        status = TC.CREATOR_NOT_FOUND;
        resolution = 'Creator never interacted with shop. Send open-collab join SMS.';
      } else if (errStr.includes('limit')) {
        status = TC.OUTREACH_LIMIT;
        resolution = 'Outreach limit hit. Route creator to open collab.';
      }
      const out = { ...base, status, reason: `relay ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`, resolution, productId: prod.product_id };
      await maybeFallbackSms({ status, base, brandName, openCollabEnabled, sendSms, testMode, out });
      await logToBitable(out);
      return out;
    }
    automationId = r.data?.data?.data?.automation_id || r.data?.data?.automation_id || r.data?.automation_id || null;
  } catch (e) {
    const out = { ...base, status: TC.ERROR, reason: 'send exception: ' + e.message, resolution: 'retry / check relay', productId: prod.product_id };
    await logToBitable(out);
    return out;
  }

  // 3) VERIFY delivery — do NOT trust ok:true
  const verify = await verifyAutomationDelivered(shopId, automationId);
  if (verify.delivered) {
    const out = {
      ...base, status: TC.SUCCESS,
      reason: `Automation ${automationId} ${verify.status} — TC delivered.`,
      resolution: '', automationId, productId: prod.product_id,
    };
    await logToBitable(out);
    return out;
  }

  // 4) Not delivered → cold creator wall. Classify + fallback.
  const out = {
    ...base, status: TC.NOT_DELIVERED,
    reason: `Automation ${automationId} ${verify.status} — ${verify.reason || 'did not deliver'} (cold creator / no prior shop interaction).`,
    resolution: openCollabEnabled
      ? 'Open-collab join SMS sent — creator must join the open collab to receive the offer.'
      : 'OPEN COLLAB DISABLED for this brand — enable it in seller center, then creator can join.',
    automationId, productId: prod.product_id,
  };
  if (!openCollabEnabled) out.status = TC.OPEN_COLLAB_DISABLED;
  await maybeFallbackSms({ status: out.status, base, brandName, openCollabEnabled, sendSms, testMode, out });
  await logToBitable(out);
  return out;
}

async function maybeFallbackSms({ status, base, brandName, openCollabEnabled, sendSms, testMode, out }) {
  // Only send the join-open-collab SMS when open collab is enabled & we have a sender + phone
  const needsFallback = [TC.NOT_DELIVERED, TC.CREATOR_NOT_FOUND, TC.OUTREACH_LIMIT].includes(status);
  if (!needsFallback || !openCollabEnabled || !sendSms) { out.fallbackSmsSent = false; return; }
  const TOMMY = '+17038513599';
  const to = testMode ? TOMMY : (base.phone || '');
  if (!to) { out.fallbackSmsSent = false; return; }
  const body = `Hey! Your ${brandName} collab is ready — open the TikTok Shop app and join the ${brandName} Open Collaboration to unlock your commission. Reply here if you need help. 👁`;
  try {
    await sendSms(to, body);
    out.fallbackSmsSent = true;
  } catch (e) {
    out.fallbackSmsSent = false;
    out.reason += ` | fallback SMS failed: ${e.message}`;
  }
}

module.exports = {
  orchestrateTargetCollab,
  resolveProduct,
  verifyAutomationDelivered,
  logToBitable,
  TC,
  _config: { RELAY_BASE, TC_BITABLE_APP, TC_BITABLE_TABLE, DEFAULT_TC_COMMISSION },
};
