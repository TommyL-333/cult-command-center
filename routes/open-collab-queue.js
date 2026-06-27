/**
 * Cult Content — Open Collab Outreach queue
 *
 * Sibling to the SMS Communication console. Surfaces the TC-backlog creators that
 * returned CREATOR_NOT_FOUND (never interacted with the shop, so TikTok will not
 * resolve a direct Target Collab). These creators are Reacher-discovered and have
 * NO phone/email in GHL — a TikTok DM via Reacher is the ONLY channel to reach them.
 *
 * Flow: read the "TC Needs" Lark base (Status contains "Failed", reason
 * CREATOR_NOT_FOUND) -> render one editable open-collab join DM per creator
 * (handle + brand + their creator signup link baked in) -> Approve & Send fires a
 * per-creator targeted Reacher DM automation (creators_to_include.list_upload) and
 * activates it -> writes status back into the base. Once the creator joins open
 * collab and becomes resolvable, the TC Auto-Retry nymph fires the real TC.
 *
 * Mount (one line in dashboard-server.js, AFTER app.use(requireAuth) so the
 * Command Center CF Access session powers it — same as the Unibox affiliate APIs):
 *   require('./routes/open-collab-queue').mount(app, { DATA_DIR });
 *
 * Auth: requireAdmin (portal-admin session OR x-ic-admin-key header) — same gate
 * pattern as the SMS console so Hasan/Shayan can reach it.
 *
 * Reacher DM contract (probed & confirmed Jun 27 2026):
 *   POST /automations/dm  body { automation_name, mode:'vanilla', schedule,
 *     messages:[{type:'message',body}], creators_to_include:{ list_upload:[handle] },
 *     is_evergreen } -> created STOPPED. Activate with POST /automations/{id}/start.
 *   Writes require an Idempotency-Key (UUID v4) header. x-api-key + x-shop-id auth.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

// ─── Config ──────────────────────────────────────────────────────────────────
const REACHER_BASE = 'https://api.reacherapp.com/public/v1';

// TC Needs Lark base (canonical working list for outstanding Target Collabs)
const TC_NEEDS_APP_TOKEN = process.env.TC_NEEDS_BITABLE_APP_TOKEN || 'UAPzbAuEpa3S5gsEd9SuIzu9tJ5';
const TC_NEEDS_TABLE_ID  = process.env.TC_NEEDS_BITABLE_TABLE_ID  || 'tblKLDaaKIhKsjOn';

// Creator signup base URL (creator pages live here)
const CREATOR_BASE = (process.env.CREATOR_BASE_URL || 'https://portal.cultcontent.cc').replace(/\/$/, '');

// Brand display-name -> { slug, shopId }. Covers every brand that can appear in
// the TC Needs base. Slugs match the creator-page route /creators/{slug}.
const BRAND_MAP = {
  'YUGLO':            { slug: 'yuglo',            shopId: 10021 },
  'YUGLO Skin':       { slug: 'yuglo',            shopId: 10021 },
  'B NOOR':           { slug: 'b-noor',           shopId: 10089 },
  'Lode WTR':         { slug: 'lode-wtr',         shopId: 9061  },
  'Trusted Rituals':  { slug: 'trusted-rituals',  shopId: 8974  },
  'Approved Science': { slug: 'approved-science', shopId: 8913  },
  'Dissolvd':         { slug: 'dissolvd',         shopId: 9963  },
  'Diamandia':        { slug: 'diamandia',        shopId: 8595  },
  'The Perfect Haircare': { slug: 'the-perfect-haircare', shopId: 6826 },
  'Roots by Genetic Art': { slug: 'roots-by-ga',  shopId: 10091 },
  'dear miss gina':   { slug: 'dear-miss-gina',   shopId: 10116 },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function normHandle(h) {
  return String(h || '').trim().replace(/^@+/, '').toLowerCase();
}

function brandInfo(brandName) {
  if (!brandName) return null;
  if (BRAND_MAP[brandName]) return BRAND_MAP[brandName];
  // tolerant lookup (case-insensitive)
  const key = Object.keys(BRAND_MAP).find(k => k.toLowerCase() === String(brandName).toLowerCase());
  return key ? BRAND_MAP[key] : null;
}

function stateFile(DATA_DIR) {
  return path.join(DATA_DIR || '/data', 'open-collab-queue.json');
}

// Local state = our send log + per-creator edited drafts + status overlay,
// keyed by `${shopId}:${handle}`. The base remains the source of truth for WHICH
// creators are in the queue; this file holds our outreach state on top of it.
function loadState(DATA_DIR) {
  try { return JSON.parse(fs.readFileSync(stateFile(DATA_DIR), 'utf8')); }
  catch { return { items: {}, log: [] }; }
}
function saveState(DATA_DIR, state) {
  try { fs.writeFileSync(stateFile(DATA_DIR), JSON.stringify(state, null, 2)); } catch (_) {}
}

// ─── Lark tenant token ───────────────────────────────────────────────────────
let _larkTok = { token: null, exp: 0 };
async function larkToken() {
  if (_larkTok.token && Date.now() < _larkTok.exp) return _larkTok.token;
  let data;
  try {
    ({ data } = await axios.post(
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET },
      { headers: { 'Content-Type': 'application/json' } }
    ));
  } catch (e) {
    const body = e.response && e.response.data;
    throw new Error('LARK_TOKEN_FAIL app=' + String(process.env.LARK_APP_ID).slice(0,12) + ' status=' + (e.response && e.response.status) + ' body=' + JSON.stringify(body));
  }
  if (!data.tenant_access_token) {
    throw new Error('LARK_TOKEN_FAIL app=' + String(process.env.LARK_APP_ID).slice(0,12) + ' code=' + data.code + ' msg=' + data.msg);
  }
  _larkTok = { token: data.tenant_access_token, exp: Date.now() + (data.expire - 60) * 1000 };
  return _larkTok.token;
}

// ─── Read TC Needs base via Sisyphus relay (this app lacks bitable scopes) ────
const SISYPHUS_RELAY_BASE = process.env.SISYPHUS_RELAY_BASE || 'https://sisyphus.cultcontent.cc';
async function fetchNeedsDmCreators() {
  const out = [];
  let pageToken = '';
  do {
    const url = SISYPHUS_RELAY_BASE + '/lark-base/' + TC_NEEDS_APP_TOKEN + '/' + TC_NEEDS_TABLE_ID +
      '/records?page_size=200&single=1' + (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '');
    let data;
    try {
      ({ data } = await axios.get(url, {
        timeout: 20000,
        headers: process.env.LARK_RELAY_SECRET ? { 'x-relay-secret': process.env.LARK_RELAY_SECRET } : {},
      }));
    } catch (e) {
      const body = e.response && e.response.data;
      throw new Error('TC_NEEDS_RELAY_FAIL base=' + TC_NEEDS_APP_TOKEN.slice(0,8) +
        ' status=' + (e.response && e.response.status) + ' body=' + JSON.stringify(body));
    }
    if (!data || data.ok === false) {
      throw new Error('TC_NEEDS_RELAY_ERR base=' + TC_NEEDS_APP_TOKEN.slice(0,8) +
        ' detail=' + JSON.stringify(data));
    }
    const items = (data && data.items) || [];
    for (const r of items) {
      const f = r.fields || {};
      const handle = normHandle(textOf(f['Creator Handle']));
      const brand  = textOf(f['Brand']);
      const reason = textOf(f['Block Reason']);
      const status = textOf(f['Status']);
      if (!handle) continue;
      // Only the "not interacted" bucket needs a DM. Quota-maxed creators just wait.
      if (!/not interacted|CREATOR_NOT_FOUND/i.test(reason)) continue;
      out.push({ record_id: r.record_id, handle, brand, reason, status });
    }
    pageToken = data.has_more ? data.page_token : '';
  } while (pageToken);
  return out;
}

// Lark text fields can be string or [{text}] arrays
function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(x => (x && x.text) ? x.text : (typeof x === 'string' ? x : '')).join('').trim();
  if (typeof v === 'object' && v.text) return v.text;
  if (typeof v === 'object' && v.link) return v.link;
  return String(v);
}

// ─── Default DM copy ─────────────────────────────────────────────────────────
// ── Hero product resolver: tap-to-Showcase link for a brand's allow-listed SKU ──
// Reads brands.json (creatorPage.tcHeroProductId / tcProductIds[0]) for the SKU,
// and the affiliate relay products list for its name. Cached per shop.
const AFFILIATE_BASE = (process.env.AFFILIATE_API_BASE || 'https://sisyphus.cultcontent.cc').replace(/\/$/, '');
const AFFILIATE_FALLBACK = (process.env.AFFILIATE_API_FALLBACK || 'https://consultants.cultcontent.cc').replace(/\/$/, '');
const _heroCache = {}; // shopId -> { link, name } | null

function _loadBrandsFile() {
  try {
    const p = path.join(process.env.DATA_DIR || '/data', 'brands.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw.clients || raw.brands || raw;
  } catch (_) { return []; }
}

async function _relayProducts(shopId) {
  for (const base of [AFFILIATE_BASE, AFFILIATE_FALLBACK]) {
    try {
      const { data } = await axios.post(`${base}/affiliate/shops/${shopId}/products`,
        { page: 1, page_size: 50 }, { timeout: 12000 });
      const arr = data && Array.isArray(data.data) ? data.data : [];
      if (arr.length) return arr;
    } catch (_) { /* try next host */ }
  }
  return [];
}

// Returns { link, name } for the brand's hero product, or null.
async function heroProductForShop(shopId, brandSlug) {
  if (!shopId) return null;
  if (Object.prototype.hasOwnProperty.call(_heroCache, shopId)) return _heroCache[shopId];
  let result = null;
  try {
    const brands = _loadBrandsFile();
    const b = brands.find(x =>
      String(x.shopId || x.shop_id) === String(shopId) ||
      (brandSlug && (x.id === brandSlug || x.slug === brandSlug))
    );
    const cp = (b && b.creatorPage) || {};
    let heroId = cp.tcHeroProductId
      || (Array.isArray(cp.tcProductIds) && cp.tcProductIds[0])
      || null;
    const products = await _relayProducts(shopId);
    // If no configured hero, fall back to the first relay product so the link still works.
    if (!heroId && products.length) heroId = products[0].product_id;
    if (heroId) {
      const match = products.find(p => String(p.product_id) === String(heroId));
      const name = match
        ? String(match.product_name || '').split(',')[0].trim().slice(0, 70)
        : null;
      result = { link: `https://shop.tiktok.com/view/product/${heroId}`, name };
    }
  } catch (_) { result = null; }
  _heroCache[shopId] = result;
  return result;
}

function defaultDm(handle, brandName, product) {
  const info = brandInfo(brandName) || {};
  const brand = brandName || 'our brand';
  // Preferred path: tap-to-add the brand's hero (allow-listed) product to Showcase.
  if (product && product.link) {
    const pname = product.name || `our ${brand} product`;
    return (
`Hey! ✨ Your free ${pname} sample from ${brand} is ready 🎁

Grab it here → ${product.link}
Add it to your TikTok Showcase, then reply "done" 🌙 and we'll send your sample + collab invite straight to your inbox — commission locked in 👁️💫`
    );
  }
  // Fallback: no hero product configured -> brand creator page + manual showcase nudge.
  const link = info.slug ? `${CREATOR_BASE}/creators/${info.slug}` : `${CREATOR_BASE}/creators`;
  return (
`Hey! ✨ We'd love to work with you on ${brand} 🌙 To unlock the collab + your free sample, start here: ${link}

Add the product to your TikTok Showcase, then reply "done" and we'll send your Target Collab invite straight to your inbox — commission locked in 👁️💫`
  );
}

// Build the merged queue (base creators + local draft/status overlay)
async function buildQueue(DATA_DIR) {
  const creators = await fetchNeedsDmCreators();
  const state = loadState(DATA_DIR);
  // Resolve each brand's hero product link once (cached) before building drafts.
  const shopSeen = {};
  for (const c of creators) {
    const inf = brandInfo(c.brand) || {};
    if (inf.shopId && !shopSeen[inf.shopId]) {
      shopSeen[inf.shopId] = true;
      try { await heroProductForShop(inf.shopId, inf.slug); } catch (_) {}
    }
  }
  return Promise.all(creators.map(async c => {
    const info = brandInfo(c.brand) || {};
    const key = `${info.shopId || 'na'}:${c.handle}`;
    const ov = state.items[key] || {};
    const product = info.shopId ? await heroProductForShop(info.shopId, info.slug) : null;
    return {
      key,
      record_id: c.record_id,
      handle: c.handle,
      brand: c.brand,
      slug: info.slug || null,
      shopId: info.shopId || null,
      signupLink: info.slug ? `${CREATOR_BASE}/creators/${info.slug}` : null,
      reason: c.reason,
      baseStatus: c.status,
      // local overlay
      draft: typeof ov.draft === 'string' ? ov.draft : defaultDm(c.handle, c.brand, product),
      dmStatus: ov.dmStatus || 'Not Sent',       // Not Sent | Sent | Failed
      automationId: ov.automationId || null,
      lastError: ov.lastError || null,
      sentAt: ov.sentAt || null,
      sendable: !!info.shopId,                    // can only send if we know the shop
    };
  }));
}

// ─── Send one DM (create targeted automation + activate) ─────────────────────
async function sendOpenCollabDm({ shopId, handle, body }) {
  const REACHER_KEY = process.env.REACHER_API_KEY;
  if (!REACHER_KEY) return { ok: false, error: 'REACHER_API_KEY missing' };
  const H = () => ({ headers: {
    'x-api-key': REACHER_KEY,
    'x-shop-id': String(shopId),
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID(),
  }});

  const payload = {
    automation_name: `Open Collab DM — ${handle} (${shopId})`,
    mode: 'vanilla',
    // enable a single creator/day so the schedule validates; targets exactly this handle
    schedule: {
      Monday_maxCreators: 1, Tuesday_maxCreators: 1, Wednesday_maxCreators: 1,
      Thursday_maxCreators: 1, Friday_maxCreators: 1, Saturday_maxCreators: 1,
      Sunday_maxCreators: 1, timezone: 'America/New_York',
    },
    messages: [{ type: 'message', body }],
    creators_to_include: { list_upload: [handle] },
    is_evergreen: false,
  };

  let automationId = null;
  try {
    const { data } = await axios.post(`${REACHER_BASE}/automations/dm`, payload, H());
    automationId = data?.data?.automation_id || data?.automation_id || data?.id || null;
  } catch (e) {
    return { ok: false, error: reacherErr(e), stage: 'create' };
  }
  if (!automationId) {
    // created but no id returned — find it by name so we can still start/track it
    automationId = await findAutomationIdByName(shopId, payload.automation_name).catch(() => null);
  }
  if (!automationId) return { ok: false, error: 'automation created but id not resolved', stage: 'create' };

  // activate so it actually sends
  try {
    await axios.post(`${REACHER_BASE}/automations/${automationId}/start`, {}, H());
  } catch (e) {
    return { ok: false, error: reacherErr(e), stage: 'start', automationId };
  }
  return { ok: true, automationId };
}

async function findAutomationIdByName(shopId, name) {
  const { data } = await axios.post(`${REACHER_BASE}/automations/list`, { page: 1, page_size: 50 },
    { headers: { 'x-api-key': process.env.REACHER_API_KEY, 'x-shop-id': String(shopId), 'Content-Type': 'application/json' } });
  const items = data?.data || data?.items || data?.automations || [];
  const hit = items.find(a => (a.automation_name || a.name) === name);
  return hit ? (hit.automation_id || hit.id) : null;
}

function reacherErr(e) {
  return e?.response?.data?.error?.message
    || e?.response?.data?.detail
    || (e?.response?.status ? `HTTP ${e.response.status}` : null)
    || e.message;
}

// ─── Write status back to the TC Needs base ──────────────────────────────────
async function updateBaseStatus(record_id, fields) {
  if (!record_id) return;
  try {
    const tok = await larkToken();
    await axios.put(
      `https://open.larksuite.com/open-apis/bitable/v1/apps/${TC_NEEDS_APP_TOKEN}/tables/${TC_NEEDS_TABLE_ID}/records/${record_id}`,
      { fields },
      { headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } }
    );
  } catch (_) { /* non-fatal — local state still records the send */ }
}

// ─── Mount ───────────────────────────────────────────────────────────────────
function mount(app, opts = {}) {
  const DATA_DIR = opts.DATA_DIR || process.env.DATA_DIR || '/data';
  const jsonMw = express.json({ limit: '256kb' });

  // requireAdmin: portal-admin session OR x-ic-admin-key header OR Cloudflare Access session.
  // When mounted AFTER app.use(requireAuth) (the Command Center / manifest.cultcontent.cc),
  // the CF Access (Google login) session has already cleared upstream — the cf-access header
  // proves it — so we pass through, matching the Unibox affiliate-API auth model.
  function requireAdmin(req, res, next) {
    if (req.session && req.session.isPortalAdmin) return next();
    if (req.headers['cf-access-authenticated-user-email']) return next();
    const key = req.headers['x-ic-admin-key'];
    if (process.env.IC_ADMIN_KEY && key && key === process.env.IC_ADMIN_KEY) return next();
    if (req.accepts('html') && !key) return res.redirect('/portal-admin');
    return res.status(401).json({ error: 'Not authorized' });
  }

  // Page
  app.get('/open-collab-outreach', requireAdmin, (req, res) => {
    res.set('Content-Type', 'text/html').send(pageHtml());
  });

  // Queue data
  app.get('/api/open-collab/queue', requireAdmin, async (req, res) => {
    try { res.json({ queue: await buildQueue(DATA_DIR) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Save an edited draft (no send)
  app.post('/api/open-collab/draft', requireAdmin, jsonMw, (req, res) => {
    const { key, draft } = req.body || {};
    if (!key || typeof draft !== 'string') return res.status(400).json({ error: 'key and draft required' });
    const state = loadState(DATA_DIR);
    state.items[key] = Object.assign({}, state.items[key], { draft });
    saveState(DATA_DIR, state);
    res.json({ ok: true });
  });

  // Approve & send
  app.post('/api/open-collab/send', requireAdmin, jsonMw, async (req, res) => {
    const { key, body } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key required' });
    const [shopIdStr, handle] = String(key).split(':');
    const shopId = parseInt(shopIdStr, 10);
    if (!shopId || !handle) return res.status(400).json({ error: 'invalid key' });

    const state = loadState(DATA_DIR);
    const existing = state.items[key] || {};
    const dmBody = typeof body === 'string' && body.trim() ? body : (existing.draft || '');
    if (!dmBody.trim()) return res.status(400).json({ error: 'empty DM body' });

    const result = await sendOpenCollabDm({ shopId, handle, body: dmBody });

    state.items[key] = Object.assign({}, existing, {
      draft: dmBody,
      dmStatus: result.ok ? 'Sent' : 'Failed',
      automationId: result.automationId || existing.automationId || null,
      lastError: result.ok ? null : (result.error || 'unknown'),
      sentAt: result.ok ? new Date().toISOString() : existing.sentAt || null,
    });
    state.log.unshift({
      ts: new Date().toISOString(), key, handle, shopId,
      ok: result.ok, automationId: result.automationId || null, error: result.ok ? null : result.error,
    });
    state.log = state.log.slice(0, 500);
    saveState(DATA_DIR, state);

    // reflect into the base (best-effort)
    if (req.body.record_id) {
      await updateBaseStatus(req.body.record_id, result.ok
        ? { 'Status': 'Retrying', 'Next Action': `Open-collab DM sent ${new Date().toISOString().slice(0,10)}` }
        : { 'Next Action': `DM failed: ${String(result.error).slice(0,80)}` });
    }

    if (result.ok) res.json({ ok: true, automationId: result.automationId });
    else res.status(502).json({ ok: false, error: result.error, stage: result.stage });
  });

  // Approve & send ALL unsent, sendable creators (sequential, paced; 429 retry once).
  app.post('/api/open-collab/send-all', requireAdmin, jsonMw, async (req, res) => {
    const queue = await buildQueue(DATA_DIR).catch(() => []);
    const targets = queue.filter(q => q.sendable && q.dmStatus !== 'Sent');
    const results = [];
    for (const t of targets) {
      let r = await sendOpenCollabDm({ shopId: t.shopId, handle: t.handle, body: t.draft });
      // one retry on transport rate-limit (relay 429)
      if (!r.ok && /429|rate.?limit/i.test(String(r.error || ''))) {
        await new Promise(z => setTimeout(z, 9000));
        r = await sendOpenCollabDm({ shopId: t.shopId, handle: t.handle, body: t.draft });
      }
      const state = loadState(DATA_DIR);
      state.items[t.key] = Object.assign({}, state.items[t.key], {
        draft: t.draft,
        dmStatus: r.ok ? 'Sent' : 'Failed',
        automationId: r.automationId || (state.items[t.key] || {}).automationId || null,
        lastError: r.ok ? null : (r.error || 'unknown'),
        sentAt: r.ok ? new Date().toISOString() : (state.items[t.key] || {}).sentAt || null,
      });
      state.log.unshift({ ts: new Date().toISOString(), key: t.key, handle: t.handle, shopId: t.shopId, ok: r.ok, automationId: r.automationId || null, error: r.ok ? null : r.error, batch: true });
      state.log = state.log.slice(0, 500);
      saveState(DATA_DIR, state);
      if (t.record_id) {
        await updateBaseStatus(t.record_id, r.ok
          ? { 'Status': 'Retrying', 'Next Action': `Open-collab DM sent ${new Date().toISOString().slice(0,10)}` }
          : { 'Next Action': `DM failed: ${String(r.error).slice(0,80)}` }).catch(() => {});
      }
      results.push({ handle: t.handle, ok: r.ok, error: r.ok ? null : r.error });
      // pace to avoid relay 429s (~1 call / 5s)
      await new Promise(z => setTimeout(z, 5000));
    }
    res.json({ ok: true, total: targets.length, sent: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok).length, results });
  });

  // Send log (audit)
  app.get('/api/open-collab/log', requireAdmin, (req, res) => {
    res.json({ log: loadState(DATA_DIR).log.slice(0, 200) });
  });

  console.log('[open-collab-queue] mounted at /open-collab-outreach');
}

function pageHtml() {
  return [
'<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>',
'<meta name="viewport" content="width=device-width,initial-scale=1"/>',
'<title>Open Collab Outreach — Cult Content</title>',
'<style>',
'*{box-sizing:border-box;margin:0;padding:0}',
'body{background:#161823;color:#e8e9f0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:32px;line-height:1.5}',
'.wrap{max-width:920px;margin:0 auto}',
'h1{font-size:24px;font-weight:700;margin-bottom:6px;background:linear-gradient(90deg,#00f2ea,#ff0050);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}',
'.sub{color:#8a8d9f;font-size:14px;margin-bottom:24px}',
'.bar{display:flex;gap:12px;align-items:center;margin-bottom:20px;flex-wrap:wrap}',
'.pill{background:#1f2233;border:1px solid #2a2e44;border-radius:999px;padding:6px 14px;font-size:13px;color:#b8bbcf}',
'.pill b{color:#00f2ea}',
'.card{background:#1c1f2e;border:1px solid #2a2e44;border-radius:14px;padding:18px;margin-bottom:16px}',
'.chead{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}',
'.handle{font-weight:700;font-size:16px;color:#fff}',
'.brand{font-size:12px;color:#8a8d9f}',
'.badge{font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;text-transform:uppercase;letter-spacing:.04em}',
'.b-notsent{background:#2a2e44;color:#b8bbcf}',
'.b-sent{background:rgba(0,242,234,.15);color:#00f2ea;border:1px solid rgba(0,242,234,.4)}',
'.b-failed{background:rgba(255,0,80,.15);color:#ff5b86;border:1px solid rgba(255,0,80,.4)}',
'textarea{width:100%;min-height:108px;background:#12141f;border:1px solid #2a2e44;border-radius:10px;color:#e8e9f0;padding:12px;font-size:13px;font-family:inherit;resize:vertical}',
'textarea:focus{outline:none;border-color:#00f2ea}',
'.meta{font-size:12px;color:#6b6f85;margin:8px 0}',
'.meta a{color:#00f2ea;text-decoration:none}',
'.actions{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}',
'button{font-family:inherit;font-size:13px;font-weight:600;border:none;border-radius:10px;padding:9px 18px;cursor:pointer;transition:opacity .15s}',
'button:disabled{opacity:.45;cursor:not-allowed}',
'.send{background:linear-gradient(90deg,#00f2ea,#00b4d8);color:#06121a}',
'.save{background:#2a2e44;color:#cfd2e6}',
'button:hover:not(:disabled){opacity:.88}',
'.err{color:#ff5b86;font-size:12px;margin-top:8px}',
'.note{color:#8a8d9f;font-size:13px;margin-top:8px}',
'.empty{text-align:center;color:#6b6f85;padding:48px 0}',
'.warn{background:rgba(255,180,0,.08);border:1px solid rgba(255,180,0,.3);color:#ffcf6b;border-radius:8px;padding:6px 12px;font-size:12px;display:inline-block;margin-top:8px}',
'</style></head><body><div class="wrap">',
'<h1>Open Collab Outreach</h1>',
'<div class="sub">Creators who couldn\'t receive a Target Collab because they\'ve never interacted with the shop. A TikTok DM via Reacher is the only way to reach them — invite them to join Open Collaboration, then the TC auto-retry fires once they\'re in.</div>',
'<div class="bar"><span class="pill">Queue: <b id="count">…</b></span><span class="pill">Sent: <b id="sentct">0</b></span><button class="save" onclick="load()">↻ Refresh</button><button class="send" id="sendall" onclick="sendAll()">⚡ Send All</button></div>',
'<div id="list"><div class="empty">Loading queue…</div></div>',
'</div>',
'<script>',
'var Q=[];',
'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}',
'function attr(s){return esc(s).replace(/"/g,"&quot;");}',
'function badge(st){var c=st==="Sent"?"b-sent":st==="Failed"?"b-failed":"b-notsent";return \'<span class="badge \'+c+\'">\'+esc(st)+\'</span>\';}',
'function card(it){',
'  var sendable=it.sendable!==false&&it.shopId;',
'  var h="";',
'  h+=\'<div class="card" id="card-\'+attr(it.key)+\'">\';',
'  h+=\'<div class="chead"><div><div class="handle">@\'+esc(it.handle)+\'</div><div class="brand">\'+esc(it.brand||"—")+(it.shopId?" · shop "+it.shopId:"")+\'</div></div>\'+badge(it.dmStatus)+\'</div>\';',
'  h+=\'<textarea id="ta-\'+attr(it.key)+\'">\'+esc(it.draft)+\'</textarea>\';',
'  if(it.signupLink){h+=\'<div class="meta">Signup link baked in: <a href="\'+attr(it.signupLink)+\'" target="_blank">\'+esc(it.signupLink)+\'</a></div>\';}',
'  if(!sendable){h+=\'<div class="warn">No shop mapping for this brand — can\\\'t send. Add the brand to BRAND_MAP.</div>\';}',
'  if(it.automationId){h+=\'<div class="meta">Reacher automation: \'+esc(it.automationId)+\'</div>\';}',
'  if(it.lastError){h+=\'<div class="err">Last error: \'+esc(it.lastError)+\'</div>\';}',
'  h+=\'<div class="actions">\';',
'  h+=\'<button class="save" onclick="saveDraft(\\\'\'+attr(it.key)+\'\\\')">Save draft</button>\';',
'  h+=\'<button class="send" \'+(sendable?"":"disabled")+\' onclick="send(\\\'\'+attr(it.key)+\'\\\',\\\'\'+attr(it.record_id||"")+\'\\\')">\'+(it.dmStatus==="Sent"?"Re-send DM":"Approve &amp; Send DM")+\'</button>\';',
'  h+=\'</div></div>\';',
'  return h;',
'}',
'function render(){',
'  document.getElementById("count").textContent=Q.length;',
'  document.getElementById("sentct").textContent=Q.filter(function(x){return x.dmStatus==="Sent";}).length;',
'  if(!Q.length){document.getElementById("list").innerHTML=\'<div class="empty">🎉 No creators need an open-collab DM right now.</div>\';return;}',
'  document.getElementById("list").innerHTML=Q.map(card).join("");',
'}',
'function load(){',
'  document.getElementById("list").innerHTML=\'<div class="empty">Loading queue…</div>\';',
'  fetch("/api/open-collab/queue",{credentials:"include"}).then(function(r){return r.json();}).then(function(d){Q=d.queue||[];render();}).catch(function(e){document.getElementById("list").innerHTML=\'<div class="err">Failed to load: \'+esc(e.message)+\'</div>\';});',
'}',
'function saveDraft(key){',
'  var ta=document.getElementById("ta-"+key);if(!ta)return;',
'  fetch("/api/open-collab/draft",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:key,draft:ta.value})}).then(function(r){return r.json();}).then(function(){var it=Q.find(function(x){return x.key===key;});if(it)it.draft=ta.value;}).catch(function(){});',
'}',
'function send(key,recordId){',
'  var it=Q.find(function(x){return x.key===key;});if(!it)return;',
'  var ta=document.getElementById("ta-"+key);var body=ta?ta.value:it.draft;',
'  if(!confirm("Send open-collab DM to @"+it.handle+" via Reacher ("+it.brand+")?"))return;',
'  var btns=document.querySelectorAll("#card-"+key+" button");btns.forEach(function(b){b.disabled=true;});',
'  fetch("/api/open-collab/send",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:key,body:body,record_id:recordId||undefined})})',
'   .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})',
'   .then(function(res){if(res.ok&&res.j.ok){it.dmStatus="Sent";it.automationId=res.j.automationId;it.lastError=null;it.draft=body;}else{it.dmStatus="Failed";it.lastError=res.j.error||"send failed";}render();})',
'   .catch(function(e){it.dmStatus="Failed";it.lastError=e.message;render();});',
'}',
'function sendAll(){',
'  var targets=Q.filter(function(x){return x.sendable!==false&&x.shopId&&x.dmStatus!=="Sent";});',
'  if(!targets.length){alert("Nothing to send — all sendable creators already done.");return;}',
'  if(!confirm("Send open-collab DMs to "+targets.length+" creators via Reacher? This is paced (~5s each) and runs in the background."))return;',
'  var sb=document.getElementById("sendall");sb.disabled=true;sb.textContent="Sending "+targets.length+"…";',
'  fetch("/api/open-collab/send-all",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({})})',
'   .then(function(r){return r.json();})',
'   .then(function(d){sb.disabled=false;sb.textContent="⚡ Send All";alert("Done. Sent "+(d.sent||0)+", failed "+(d.failed||0)+" of "+(d.total||0)+".");load();})',
'   .catch(function(e){sb.disabled=false;sb.textContent="⚡ Send All";alert("Send All error: "+e.message);load();});',
'}',
'load();',
'</script></body></html>'
  ].join('');
}

module.exports = { mount, _internals: { buildQueue, sendOpenCollabDm, defaultDm, fetchNeedsDmCreators } };
