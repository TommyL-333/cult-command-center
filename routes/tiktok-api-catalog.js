/**
 * TikTok API Catalog — single source of truth for the API Map page.
 *
 * Two surfaces:
 *  - SHOP   = TikTok Shop Partner API (partner.tiktokshop.com), version 202309/202405 etc.
 *  - DEV    = TikTok for Developers / Open Platform (developers.tiktok.com) — Login Kit,
 *             Content Posting, Display, Business, Affiliate creator-side.
 *
 * access:
 *  - 'direct'      = we call it ourselves via our own TikTok app (client app or creator app)
 *  - 'third-party' = we get it through Reacher (or another vendor) today
 *  - 'none'        = we do NOT have access yet (roadmap target)
 *
 * verified:
 *  - true  = path/usage confirmed against our live code / a real call
 *  - false = catalogued from TikTok docs knowledge; exact version/path should be
 *            re-confirmed against the live partner/dev portal before relying on it.
 *
 * This file is intentionally data-only so it can be edited/extended without touching
 * the route logic. Update it as we bring endpoints in-house (access: none -> third-party -> direct).
 */

const SURFACES = {
  SHOP: { id: 'SHOP', label: 'TikTok Shop Partner API', host: 'partner.tiktokshop.com',
    docs: 'https://partner.tiktokshop.com/docv2' },
  DEV: { id: 'DEV', label: 'TikTok for Developers (Open Platform)', host: 'developers.tiktok.com',
    docs: 'https://developers.tiktok.com/doc/overview' },
};

// modules group endpoints. Each module has a surface + list of endpoints.
const MODULES = [
  // ── AUTHORIZATION ──────────────────────────────────────────────
  { key: 'auth', surface: 'SHOP', name: 'Authorization', icon: '🔑',
    summary: 'OAuth + token lifecycle for connecting brand shops to our client app.',
    endpoints: [
      { path: 'GET /authorization/202309/shops', name: 'Get Authorized Shops', access: 'direct', verified: true,
        usage: 'Resolve shop_id + shop_cipher for each connected brand. Backbone of every signed call.' },
      { path: 'POST /api/v2/token/get', name: 'Get Access Token', access: 'direct', verified: true,
        usage: 'Exchange auth_code for access_token during brand onboarding (client app).' },
      { path: 'POST /api/v2/token/refresh', name: 'Refresh Access Token', access: 'direct', verified: true,
        usage: 'Keep per-shop tokens alive (stored in TIKTOK_SHOP_TOKENS / relay).' },
    ]},

  // ── PRODUCT ────────────────────────────────────────────────────
  { key: 'product', surface: 'SHOP', name: 'Product', icon: '📦',
    summary: 'Product catalog read/write. Powers brief generation context + future catalog sync.',
    endpoints: [
      { path: 'POST /product/202309/products/search', name: 'Search Products', access: 'direct', verified: false,
        usage: 'Pull a brand\'s live product list for content briefs / promotion scoping.' },
      { path: 'GET /product/202309/products/{product_id}', name: 'Get Product Detail', access: 'direct', verified: false,
        usage: 'Price, SKU, stock for promotion floor-price logic.' },
      { path: 'POST /product/202309/products', name: 'Create Product', access: 'none', verified: false,
        usage: 'NOT USED. We do not manage brand catalogs directly yet.' },
      { path: 'GET /product/202405/categories', name: 'Get Categories', access: 'direct', verified: false,
        usage: 'Category tree for onboarding classification.' },
      { path: 'GET /product/202405/categories/{id}/assets', name: 'Get Authorized Category Assets', access: 'none', verified: false,
        usage: 'Category-required assets (size charts, certs). Roadmap: onboarding automation.' },
    ]},

  // ── PROMOTION ──────────────────────────────────────────────────
  { key: 'promotion', surface: 'SHOP', name: 'Promotion', icon: '🏷️',
    summary: 'Discounts/flash sales. We read promotions in-house now; create is the next win.',
    endpoints: [
      { path: 'GET /promotion/202309/activities', name: 'Get Activities (Promotions)', access: 'direct', verified: true,
        usage: 'get_tiktok_promotions tool — read ONGOING/NOT_START/EXPIRED promos per shop, signed directly.' },
      { path: 'GET /promotion/202309/activities/{id}', name: 'Get Activity Detail', access: 'direct', verified: false,
        usage: 'Discount + product scope detail for reporting.' },
      { path: 'POST /promotion/202309/activities', name: 'Create Activity', access: 'none', verified: false,
        usage: 'ROADMAP: auto-create launch promos during onboarding from product floor price. High priority.' },
      { path: 'POST /promotion/202309/activities/{id}/update', name: 'Update Activity', access: 'none', verified: false,
        usage: 'ROADMAP: adjust live promos.' },
    ]},

  // ── ORDER ──────────────────────────────────────────────────────
  { key: 'order', surface: 'SHOP', name: 'Order', icon: '🧾',
    summary: 'Order list + detail. Feeds GMV/net-revenue calculation.',
    endpoints: [
      { path: 'POST /order/202309/orders/search', name: 'Search Orders', access: 'direct', verified: false,
        usage: 'fetchNetGmvForBrand — order-level GMV for the client portal Overview tab.' },
      { path: 'GET /order/202309/orders', name: 'Get Order List', access: 'direct', verified: false,
        usage: 'Order timeseries for revenue reporting.' },
      { path: 'POST /order/202309/orders/detail/query', name: 'Get Order Detail', access: 'direct', verified: false,
        usage: 'Line items for net-of-refunds GMV.' },
    ]},

  // ── FINANCE ────────────────────────────────────────────────────
  { key: 'finance', surface: 'SHOP', name: 'Finance', icon: '💰',
    summary: 'Settlements, statements, payouts. Scope-gated (seller.finance.info).',
    endpoints: [
      { path: 'GET /finance/202309/statements', name: 'Get Statements', access: 'none', verified: false,
        usage: 'ROADMAP [SCOPE seller.finance.info]: true net-revenue + automated rev-share calc per brand. Biggest Financial Nymph unlock — replaces estimated net with TikTok-settled figures.' },
      { path: 'GET /finance/202309/order/statement_transactions', name: 'Get Statement Transactions', access: 'none', verified: false,
        usage: 'NOT YET. Per-order settlement for exact commission accounting.' },
    ]},
  // ── AFFILIATE (Shop-side / Seller) ─────────────────────────────
  { key: 'affiliate_seller', surface: 'SHOP', name: 'Affiliate — Seller Side', icon: '🤝',
    summary: 'The crown jewels: creator discovery, target collaborations, affiliate orders. This is what Reacher resells. Direct ownership = replacing Reacher.',
    endpoints: [
      { path: 'POST /affiliate_seller/202405/creators/search', name: 'Search Creators', access: 'third-party', verified: true,
        usage: 'Creator discovery. We use Reacher today. Direct path exists (sendCreatorTC resolves open_id via /affiliate/seller/202309/creators/search).' },
      { path: 'POST /affiliate_seller/202309/open_collaborations', name: 'Create Open Collaboration', access: 'third-party', verified: false,
        usage: 'Open collab campaigns. Via Reacher automations today.' },
      { path: 'POST /affiliate_seller/202309/target_collaborations', name: 'Create Target Collaboration (TC)', access: 'third-party', verified: true,
        usage: 'TC invites — currently via Reacher /tc-invite automation. Direct send blocked on scope; B2 target.' },
      { path: 'GET /affiliate_seller/202309/affiliate_orders', name: 'Get Affiliate Orders', access: 'third-party', verified: true,
        usage: 'Creator-attributed GMV/commission. Reacher summary today (get_reacher_data).' },
      { path: 'GET /affiliate_seller/202309/affiliate_creators/performance', name: 'Creator Performance', access: 'third-party', verified: true,
        usage: 'Per-creator GMV/videos/views. Reacher relay (now ported in-house read at /affiliate/*).' },
      { path: 'GET /affiliate_seller/202309/samples', name: 'Sample Requests', access: 'third-party', verified: true,
        usage: 'Sample request/approval funnel. Reacher /samples.' },
    ]},

  // ── FULFILLMENT / LOGISTICS ────────────────────────────────────
  { key: 'fulfillment', surface: 'SHOP', name: 'Fulfillment & Logistics', icon: '🚚',
    summary: 'Shipping, packages, labels. Brands self-manage; we have basic scope.',
    endpoints: [
      { path: 'POST /fulfillment/202309/packages/ship', name: 'Ship Package', access: 'none', verified: false,
        usage: 'NOT USED. Brands fulfill. Have seller.fulfillment.basic scope but no workflow.' },
      { path: 'GET /logistics/202309/warehouses', name: 'Get Warehouses', access: 'none', verified: false,
        usage: 'NOT USED.' },
    ]},

  // ── DATA / ANALYTICS ───────────────────────────────────────────
  { key: 'analytics', surface: 'SHOP', name: 'Data & Analytics', icon: '📊',
    summary: 'Shop performance analytics. Some via direct, GMV timeseries via relay.',
    endpoints: [
      { path: 'GET /analytics/202405/shops/performance', name: 'Shop Performance', access: 'none', verified: false,
        usage: 'ROADMAP: official shop-level analytics (impressions, conversion). Currently approximate via affiliate relay.' },
      { path: 'GET /analytics/202405/shop_products/performance', name: 'Product Performance', access: 'none', verified: false,
        usage: 'ROADMAP: per-product analytics.' },
    ]},

  // ════════════════ DEVELOPER PORTAL (Open Platform) ════════════════
  // ── LOGIN KIT ──────────────────────────────────────────────────
  { key: 'login_kit', surface: 'DEV', name: 'Login Kit', icon: '🔐',
    summary: 'OAuth for creator accounts. Powers our creator app authorization.',
    endpoints: [
      { path: 'GET /v2/oauth/authorize/', name: 'Authorize (creator)', access: 'direct', verified: true,
        usage: 'Creator app — creators authorize Cult Content (Inner Circle / creator portal).' },
      { path: 'POST /v2/oauth/token/', name: 'Fetch/Refresh Token', access: 'direct', verified: true,
        usage: 'Creator-side token lifecycle.' },
    ]},

  // ── CONTENT POSTING ────────────────────────────────────────────
  { key: 'content_posting', surface: 'DEV', name: 'Content Posting API', icon: '🎬',
    summary: 'Post video/photo to a creator account. THE blocker for Content Studio auto-publish.',
    endpoints: [
      { path: 'POST /v2/post/publish/video/init/', name: 'Direct Post Video', access: 'none', verified: false,
        usage: 'ROADMAP/BLOCKER: publish generated Content Studio videos to TikTok. SCOPE: video.publish + video.upload. Requires creator app audited/published. UNLOCKS: Content Studio one-click auto-post.' },
      { path: 'POST /v2/post/publish/content/init/', name: 'Post Photo/Carousel', access: 'none', verified: false,
        usage: 'ROADMAP: publish carousel/photo content. SCOPE: video.publish. UNLOCKS: Content Studio carousel auto-post.' },
      { path: 'POST /v2/post/publish/status/fetch/', name: 'Get Post Status', access: 'none', verified: false,
        usage: 'ROADMAP: poll publish_id status (PROCESSING/PUBLISH_COMPLETE/FAILED) after auto-post. SCOPE: video.publish.' },
    ]},

  // ── DISPLAY API ────────────────────────────────────────────────
  { key: 'display', surface: 'DEV', name: 'Display API', icon: '👁️',
    summary: 'Read a creator\'s profile + video list. Useful for verifying handles / video counts.',
    endpoints: [
      { path: 'GET /v2/user/info/', name: 'Get User Info', access: 'none', verified: false,
        usage: 'ROADMAP: verify creator handle + follower/likes count at signup. SCOPE: user.info.basic (+ user.info.stats for counts). UNLOCKS: kill manual handle entry on IC/creator signup.' },
      { path: 'GET /v2/video/list/', name: 'List Videos', access: 'none', verified: false,
        usage: 'ROADMAP [SCOPE video.list]: auto-count Inner Circle videos (the 20/mo commitment) instead of handle-matching.' },
    ]},

  // ── AFFILIATE (Creator-side, Open Platform) ────────────────────
  { key: 'affiliate_creator', surface: 'DEV', name: 'Affiliate — Creator Side', icon: '⭐',
    summary: 'Creator-facing affiliate (showcase, samples). Distinct from Shop seller-side affiliate.',
    endpoints: [
      { path: 'GET /affiliate/creator/showcase', name: 'Creator Showcase', access: 'none', verified: false,
        usage: 'ROADMAP: read what products a creator is promoting.' },
    ]},

  // ── BUSINESS / ADS ─────────────────────────────────────────────
  { key: 'business_ads', surface: 'DEV', name: 'Business & Ads', icon: '📣',
    summary: 'Marketing API / Spark Ads / partnership-ad codes. Relevant to whitelisted Meta-style ads roadmap.',
    endpoints: [
      { path: 'POST /v2/business/video/publish/', name: 'Business Video Publish', access: 'none', verified: false,
        usage: 'ROADMAP: business-account posting.' },
      { path: 'Spark Ads / TTAM auth codes', name: 'Spark Ads Authorization', access: 'none', verified: false,
        usage: 'ROADMAP: creator-whitelisted ads (parallel to the Meta partnership-ads workstream).' },
    ]},
];

module.exports = { SURFACES, MODULES };
