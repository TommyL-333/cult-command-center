/**
 * lib/product-resolver.js
 * IC Content Engine — resolves a brand's TikTok Shop product catalog.
 *
 * Source of truth: the affiliate read relay (Phase B1 in-house port).
 *   POST {BASE}/affiliate/shops/:numericShopId/products  ->  { data: [ {product_id, product_name, ...} ] }
 *
 * Resilience model (added after Reacher upstream outage caused empty dropdowns
 * + script-gen 504s):
 *   - Short per-host timeout (8s) so worst case is bounded, never 30s.
 *   - In-memory last-good cache per shop (TTL 10min). If Reacher hangs/dies we
 *     instantly serve the last successful catalog instead of an empty list,
 *     and the caller never blocks long enough to 504.
 *   - never throws — returns [] only if BOTH hosts fail AND no cache exists.
 */
const axios = require('axios');

const PRIMARY_BASE  = (process.env.AFFILIATE_API_BASE || 'https://consultants.cultcontent.cc').replace(/\/+$/, '');
const FALLBACK_BASE = (process.env.AFFILIATE_API_FALLBACK || 'https://sisyphus.cultcontent.cc').replace(/\/+$/, '');

const HOST_TIMEOUT_MS = parseInt(process.env.PRODUCT_RESOLVER_TIMEOUT_MS || '8000', 10);
const CACHE_TTL_MS    = parseInt(process.env.PRODUCT_RESOLVER_CACHE_TTL_MS || String(10 * 60 * 1000), 10);

// shopId -> { at: epochMs, data: [] }
const _cache = new Map();

async function hit(base, numericShopId) {
  const url = `${base}/affiliate/shops/${encodeURIComponent(String(numericShopId))}/products`;
  const r = await axios.post(url, {}, { timeout: HOST_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } });
  const data = r && r.data && Array.isArray(r.data.data) ? r.data.data
            : (Array.isArray(r && r.data) ? r.data : []);
  return Array.isArray(data) ? data : [];
}

async function fetchCatalog(numericShopId) {
  if (numericShopId == null || numericShopId === '') return [];
  const key = String(numericShopId);

  // Primary (legacy relay — fast health, reaches Reacher upstream)
  try {
    const data = await hit(PRIMARY_BASE, numericShopId);
    if (data.length) { _cache.set(key, { at: Date.now(), data }); return data; }
  } catch (e) {
    console.error('[product-resolver] primary failed for shop', key, '-', (e.response && e.response.status) || e.code || e.message);
  }

  // Fallback (in-house relay) — only if primary empty/errored and hosts differ
  if (FALLBACK_BASE && FALLBACK_BASE !== PRIMARY_BASE) {
    try {
      const data = await hit(FALLBACK_BASE, numericShopId);
      if (data.length) { _cache.set(key, { at: Date.now(), data }); return data; }
    } catch (e) {
      console.error('[product-resolver] fallback failed for shop', key, '-', (e.response && e.response.status) || e.code || e.message);
    }
  }

  // Both hosts failed/empty — serve last-good cache if fresh enough.
  const cached = _cache.get(key);
  if (cached && (Date.now() - cached.at) < CACHE_TTL_MS && cached.data.length) {
    console.warn('[product-resolver] serving STALE cache for shop', key, '(', cached.data.length, 'products,', Math.round((Date.now() - cached.at) / 1000) + 's old) — upstream unavailable');
    return cached.data;
  }

  return [];
}

module.exports = { fetchCatalog, PRIMARY_BASE, FALLBACK_BASE };
