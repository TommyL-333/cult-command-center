// lib/tts-product-images.js
// ─────────────────────────────────────────────────────────────────────────────
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

async function ttsRequest(token, method, apiPath, params = {}, body = null) {
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
      const r = await ttsRequest(t, 'POST', '/product/202309/products/search', params, {});
      const batch = r?.data?.products || [];
      allRaw.push(...batch);
      pageToken = r?.data?.next_page_token;
      if (!pageToken || batch.length === 0) break;
    }

    // 2. Fetch detail images for first `limit` products in parallel
    const slice = allRaw.slice(0, limit);
    const detailResults = await Promise.allSettled(
      slice.map(p => ttsRequest(t, 'GET', `/product/202309/products/${p.id}`, {}))
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

module.exports = { fetchProductImages };
