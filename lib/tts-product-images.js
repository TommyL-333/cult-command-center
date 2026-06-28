// lib/tts-product-images.js
// ─────────────────────���───────────────────────────────────────────────────────
// Fetches TikTok Shop product images for a given brand using its per-shop token
// (brand.tiktokShopToken = { access_token, shop_cipher, refresh_token, expires_at }).
//
// Signing recipe is copied verbatim from dashboard-server.js signTTShop():
//   base = {app_secret}{api_path}{sortedParamStr}{bodyStr}{app_secret}
//   sign = HMAC-SHA256(app_secret, base) -> lowercase hex
//
// Returns a Map<productIdString, [imageUrl,...]> so the IC products route can
// merge images into the Reacher-sourced catalog. NEVER throws — on any failure
// it returns an empty/partial map so image enrichment silently no-ops.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const axios  = require('axios');

const TTS_BASE = 'https://open-api.tiktokglobalshop.com';

const path = require('path');
const DATA_DIR    = process.env.DATA_DIR || '/data';
const BRANDS_FILE = path.join(DATA_DIR, 'brands.json');

// Persist a refreshed token back to brands.json (best-effort, keyed by brand.id).
function _persistToken(brandId, token) {
  try {
    const bd = JSON.parse(fs.readFileSync(BRANDS_FILE, 'utf8'));
    const i = (bd.clients || []).findIndex(b => b.id === brandId);
    if (i !== -1) {
      bd.clients[i].tiktokShopToken = token;
      bd.clients[i].tiktokConnected = true;
      fs.writeFileSync(BRANDS_FILE, JSON.stringify(bd, null, 2));
    }
  } catch (_) { /* best-effort */ }
}

// Force-refresh a brand's TikTok Shop access_token via refresh_token.
// Mutates brand.tiktokShopToken in place AND persists to brands.json.
// Returns true on success, false otherwise. NEVER throws.
async function _refreshBrandToken(brand) {
  const t = brand && brand.tiktokShopToken;
  if (!t || !t.refresh_token) return false;
  try {
    const { data: rd } = await axios.get('https://auth.tiktok-shops.com/api/v2/token/refresh', {
      params: {
        app_key:       process.env.TIKTOK_SHOP_APP_KEY,
        app_secret:    process.env.TIKTOK_SHOP_APP_SECRET,
        refresh_token: t.refresh_token,
        grant_type:    'refresh_token',
      },
      timeout: 12000,
    });
    if (rd && rd.code === 0 && rd.data && rd.data.access_token) {
      const expVal = rd.data.access_token_expire_in;
      const _v = Number(expVal) || 0;
      const expiresAt = _v > 1e12 ? _v : (_v > 1e9 ? _v * 1000 : Date.now() + (_v || 86400) * 1000);
      const newTok = {
        ...t,
        access_token:  rd.data.access_token,
        refresh_token: rd.data.refresh_token || t.refresh_token,
        expires_at:    expiresAt,
      };
      brand.tiktokShopToken = newTok;      // mutate in place for this call
      _persistToken(brand.id, newTok);     // persist so it sticks
      return true;
    }
  } catch (_) { /* swallow */ }
  return false;
}

function signTTShop(apiPath, params, body = '') {
  const appSecret = process.env.TIKTOK_SHOP_APP_SECRET || '';
  const sorted = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'access_token')
    .sort();
  const paramStr = sorted.map(k => `${k}${params[k]}`).join('');
  const bodyStr  = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
  const base     = `${appSecret}${apiPath}${paramStr}${bodyStr}${appSecret}`;
  return crypto.createHmac('sha256', appSecret).update(base).digest('hex');
}

async function _signedCall(token, method, apiPath, params = {}, body = null) {
  const allParams = {
    app_key:   process.env.TIKTOK_SHOP_APP_KEY || '',
    timestamp: Math.floor(Date.now() / 1000),
    ...params,
  };
  if (token.shop_cipher) allParams.shop_cipher = token.shop_cipher;
  allParams.sign = signTTShop(apiPath, allParams, body);
  const config = {
    method,
    url: `${TTS_BASE}${apiPath}`,
    params: allParams,
    headers: { 'content-type': 'application/json', 'x-tts-access-token': token.access_token },
    timeout: 12000,
  };
  if (body) config.data = body;
  const { data } = await axios(config);
  return data;
}

// Brand-aware request: proactively refreshes an expired token, and reactively
// refreshes + retries once on a 105002 (expired credentials) response.
async function ttsRequest(brand, method, apiPath, params = {}, body = null) {
  let token = brand && brand.tiktokShopToken;
  if (!token || !token.access_token) throw new Error('no token');
  // Proactive: refresh if expired or within 2 min of expiry.
  const _maxSane = Date.now() + 400 * 86400 * 1000; // 400 days ceiling
  if (token.expires_at && (Date.now() > token.expires_at - 120000 || token.expires_at > _maxSane)) {
    await _refreshBrandToken(brand);
    token = brand.tiktokShopToken;
  }
  let data;
  try {
    data = await _signedCall(token, method, apiPath, params, body);
  } catch (e) {
    const code = e && e.response && e.response.data && e.response.data.error && e.response.data.error.code;
    if (code === 105002 && await _refreshBrandToken(brand)) {
      return _signedCall(brand.tiktokShopToken, method, apiPath, params, body);
    }
    throw e;
  }
  // Some TikTok errors come back as 200 with code in body.
  if (data && data.code === 105002 && await _refreshBrandToken(brand)) {
    return _signedCall(brand.tiktokShopToken, method, apiPath, params, body);
  }
  return data;
}

function extractImages(detail, base) {
  const src = detail?.main_images || detail?.images || base?.main_images || base?.images || [];
  if (!Array.isArray(src)) return [];
  return src.slice(0, 4)
    .map(img => img?.thumb_urls?.[0] || img?.urls?.[0] || img?.url_list?.[0] || img?.url || img)
    .filter(s => typeof s === 'string' && s.startsWith('http'));
}

/**
 * Build a map of productId -> image URLs for a brand.
 * @param {object} brand  brands.json client record (must have tiktokShopToken)
 * @param {number} limit  max products to fetch detail images for (default 30)
 * @returns {Promise<Object>} { [productId:string]: string[] }  (empty {} on failure)
 */
async function fetchProductImages(brand, limit = 30) {
  const out = {};
  const t = brand && brand.tiktokShopToken;
  if (!t || !t.access_token) return out;
  try {
    // 1. Paginate product list (page_size 50, up to 5 pages)
    let allRaw = [], pageToken = null;
    for (let page = 0; page < 5; page++) {
      const params = { page_size: 50 };
      if (pageToken) params.page_token = pageToken;
      const r = await ttsRequest(brand, 'POST', '/product/202309/products/search', params, {});
      const batch = r?.data?.products || [];
      allRaw.push(...batch);
      pageToken = r?.data?.next_page_token;
      if (!pageToken || batch.length === 0) break;
    }

    // 2. Fetch detail images for first `limit` products in parallel
    const slice = allRaw.slice(0, limit);
    const detailResults = await Promise.allSettled(
      slice.map(p => ttsRequest(brand, 'GET', `/product/202309/products/${p.id}`, {}))
    );
    const detailMap = {};
    detailResults.forEach((r2, i) => {
      if (r2.status === 'fulfilled') {
        const val = r2.value;
        if (val?.code === 0 && val?.data) detailMap[slice[i].id] = val.data;
        else if (val?.main_images)        detailMap[slice[i].id] = val;
      }
    });

    // 3. Build id -> images map (string keys for safe matching)
    for (const p of allRaw) {
      const imgs = extractImages(detailMap[p.id], p);
      if (imgs.length) out[String(p.id)] = imgs;
    }
  } catch (_) {
    // honest no-op: return whatever we have (possibly empty)
  }
  return out;
}


// extract a single representative image url from a product-search row
function firstImage(p) {
  const src = p && (p.main_images || p.images);
  if (!Array.isArray(src) || !src.length) return null;
  const img = src[0];
  return img?.thumb_urls?.[0] || img?.urls?.[0] || img?.url_list?.[0] || img?.url || (typeof img === 'string' ? img : null);
}

/**
 * fetchCatalog(brand) — returns the brand's ACTIVE TikTok Shop product catalog
 * DIRECTLY from the TikTok Shop Open API using the brand's per-shop token.
 * No Reacher dependency. Source of truth = our own connected TikTok app.
 *
 * Returns: [{ product_id:string, product_name:string, image:string|null, status:string }]
 * NEVER throws — returns [] on any failure (caller shows 'products unavailable').
 */
async function fetchCatalog(brand) {
  const t = brand && brand.tiktokShopToken;
  if (!t || !t.access_token) return [];
  const out = [];
  try {
    let pageToken = null;
    for (let page = 0; page < 5; page++) {
      const params = { page_size: 50 };
      if (pageToken) params.page_token = pageToken;
      // Default to ACTIVE products only so creators don't pick draft/deleted SKUs
      const r = await ttsRequest(brand, 'POST', '/product/202309/products/search', params, { status: 'ACTIVATE' });
      const batch = (r && r.data && r.data.products) || [];
      for (const p of batch) {
        if (!p || p.id == null) continue;
        out.push({
          product_id:   String(p.id),
          product_name: p.title || p.product_name || '(untitled product)',
          image:        firstImage(p) || null,
          status:       p.status || 'ACTIVE',
        });
      }
      pageToken = r && r.data && r.data.next_page_token;
      if (!pageToken || batch.length === 0) break;
    }

    // Product-search rows carry NO images — enrich from the per-product detail
    // endpoint (which returns main_images). Batched + capped to stay under rate
    // limits. Failures per-product silently leave image:null.
    const needImg = out.filter(p => !p.image).slice(0, 40);
    const BATCH = 8;
    for (let i = 0; i < needImg.length; i += BATCH) {
      const slice = needImg.slice(i, i + BATCH);
      const details = await Promise.all(slice.map(p =>
        ttsRequest(brand, 'GET', `/product/202309/products/${p.product_id}`, {})
          .then(d => (d && d.data) || null)
          .catch(() => null)
      ));
      for (let j = 0; j < slice.length; j++) {
        const imgs = extractImages(details[j], null);
        if (imgs.length) slice[j].image = imgs[0];
      }
    }
  } catch (e) {
    console.error('[tts-product-images] fetchCatalog failed for', brand && brand.id, '-', (e.response && e.response.status) || e.message);
    return out; // honest: return whatever we collected
  }
  return out;
}

module.exports = { fetchProductImages, fetchCatalog };
