/**
 * lib/product-resolver.js
 * IC Content Engine — resolves a brand's TikTok Shop product catalog.
 *
 * Source of truth: the affiliate read relay (Phase B1 in-house port).
 *   POST {BASE}/affiliate/shops/:numericShopId/products  ->  { data: [ {product_id, product_name, ...} ] }
 *
 * PRIMARY base = in-house sisyphus.cultcontent.cc (the migration target),
 * configurable via AFFILIATE_API_BASE. If the primary returns empty/errors we
 * FALL BACK to the legacy relay (consultants.cultcontent.cc) so a creator's
 * product dropdown is never silently empty during/after the host migration.
 *
 * fetchCatalog(numericShopId) returns the RAW data[] array (callers match on
 * String(p.product_id)); never throws — returns [] only if BOTH hosts fail.
 */
const axios = require('axios');

const PRIMARY_BASE  = (process.env.AFFILIATE_API_BASE || 'https://sisyphus.cultcontent.cc').replace(/\/+$/, '');
const FALLBACK_BASE = (process.env.AFFILIATE_API_FALLBACK || 'https://consultants.cultcontent.cc').replace(/\/+$/, '');

async function hit(base, numericShopId) {
  const url = `${base}/affiliate/shops/${encodeURIComponent(String(numericShopId))}/products`;
  const r = await axios.post(url, {}, { timeout: 15000, headers: { 'Content-Type': 'application/json' } });
  const data = r && r.data && Array.isArray(r.data.data) ? r.data.data
            : (Array.isArray(r && r.data) ? r.data : []);
  return Array.isArray(data) ? data : [];
}

async function fetchCatalog(numericShopId) {
  if (numericShopId == null || numericShopId === '') return [];
  // Primary (in-house)
  try {
    const data = await hit(PRIMARY_BASE, numericShopId);
    if (data.length) return data;
  } catch (e) {
    console.error('[product-resolver] primary failed for shop', numericShopId, '-', (e.response && e.response.status) || e.message);
  }
  // Fallback (legacy relay) — only if primary empty/errored and the hosts differ
  if (FALLBACK_BASE && FALLBACK_BASE !== PRIMARY_BASE) {
    try {
      const data = await hit(FALLBACK_BASE, numericShopId);
      if (data.length) return data;
    } catch (e) {
      console.error('[product-resolver] fallback failed for shop', numericShopId, '-', (e.response && e.response.status) || e.message);
    }
  }
  return [];
}

module.exports = { fetchCatalog, PRIMARY_BASE, FALLBACK_BASE };
