/**
 * Cult Content — Command Center Dashboard Server
 * Serves the dashboard UI and proxies API calls to GHL, Railway, and stubs.
 */

require('dotenv').config({ override: true });
const express      = require('express');
const axios        = require('axios');
const path         = require('path');
const fs           = require('fs');
const multer       = require('multer');
const crypto       = require('crypto');
const Anthropic    = require('@anthropic-ai/sdk');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');

// ─── Data directory — use Railway Volume in prod, __dirname locally ───────────
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SNAP_FILE          = path.join(DATA_DIR, 'snapshots.json');
const QUEUE_FILE         = path.join(DATA_DIR, 'upload-queue.json');
const AGENTS_FILE        = path.join(DATA_DIR, 'agents.json');
const TIKTOK_TOKENS_FILE = path.join(DATA_DIR, '.tiktok-tokens.json');
const UPLOAD_DIR         = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();

// ─── Security: HTTPS redirect in production ───────────────────────────────────
app.set('trust proxy', 1); // trust Cloudflare / Railway proxy
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

// ─── Security: HTTP headers via Helmet ───────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // dashboard uses inline scripts — disable CSP for now
  crossOriginEmbedderPolicy: false,
}));

// ─── Security: Rate limiting ──────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute window
  max: 120,                  // 120 requests/min per IP (generous for a dashboard)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down.' },
});
app.use('/api/', apiLimiter);

// ─── Security: Cloudflare Access authentication ───────────────────────────────
// Cloudflare Access injects CF-Access-Authenticated-User-Email on every request.
// If CF_ACCESS_AUD is set, we enforce this header — unauthenticated requests get 401.
const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || 'cultcontent.cc')
  .split(',').map(d => d.trim().toLowerCase());

function requireAuth(req, res, next) {
  // Skip auth in local dev (no CF_ACCESS_AUD configured)
  if (!process.env.CF_ACCESS_AUD) return next();

  const email = req.headers['cf-access-authenticated-user-email'];
  if (!email) {
    return res.status(401).sendFile(path.join(__dirname, 'dashboard', '401.html'));
  }

  const domain = email.split('@')[1]?.toLowerCase();
  if (!ALLOWED_DOMAINS.includes(domain)) {
    return res.status(403).send(`Access denied. ${email} is not authorized.`);
  }

  // Attach user email to request for downstream use
  req.userEmail = email;
  next();
}

app.use(express.json());

// ─── Lark API helpers ─────────────────────────────────────────────────────────
const LARK_BASE          = 'https://open.larksuite.com/open-apis';
const LARK_ALERT_CHAT_ID = process.env.LARK_ALERT_CHAT_ID || 'oc_e7fa4126968dc76eaeca1d815e706e46';

async function larkTenantToken() {
  const r = await axios.post(`${LARK_BASE}/auth/v3/tenant_access_token/internal`, {
    app_id:     process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET,
  }, { timeout: 8_000 });
  if (r.data.code !== 0) throw new Error(`Lark auth failed: ${r.data.msg}`);
  return r.data.tenant_access_token;
}

async function larkCopyTemplateDoc({ docToken, title }) {
  // Copies the template via drive/v1 (bot needs Files permission, not wiki admin)
  const token = await larkTenantToken();
  const r = await axios.post(
    `${LARK_BASE}/drive/v1/files/${docToken}/copy`,
    { name: title, type: 'docx', folder_token: '' },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 }
  );
  if (r.data.code !== 0) throw new Error(`Lark copy doc failed: ${r.data.msg}`);

  // Set permissions: org members = edit, external link = view only
  const newToken = r.data.data?.file?.token;
  if (newToken) {
    await axios.patch(
      `${LARK_BASE}/drive/v1/permissions/${newToken}/public?type=docx`,
      { link_share_entity: 'tenant_editable', external_access_entity: 'open', invite_external: false },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 }
    ).catch(e => console.warn('[lark] Permission set failed:', e.message));
  }

  return r.data;
}

async function larkSendChatMessage({ chatId, text }) {
  const token = await larkTenantToken();
  const r = await axios.post(
    `${LARK_BASE}/im/v1/messages?receive_id_type=chat_id`,
    { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 }
  );
  if (r.data.code !== 0) throw new Error(`Lark send message failed: ${r.data.msg}`);
  return r.data;
}

// ─── GHL Webhook: client onboarding form → auto-add client ───────────────────
// This route is intentionally registered BEFORE requireAuth so GHL can call it
// without a Cloudflare Access session. Verified by WEBHOOK_SECRET query param.
app.post('/api/webhooks/ghl-client-onboard', async (req, res) => {
  // Verify shared secret
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const body = req.body;

    // GHL sends field values using either the field label or a custom key — normalise both
    function field(key, ...aliases) {
      const keys = [key, ...aliases];
      for (const k of keys) {
        if (body[k] !== undefined && body[k] !== '') return body[k];
      }
      return null;
    }

    // ── Extract form fields ──────────────────────────────────────────────────
    const brandName    = field('Brand Name', 'brand_name', 'brandName') || 'New Client';
    const firstName    = field('First Name', 'first_name', 'firstName') || '';
    const lastName     = field('Last Name',  'last_name',  'lastName')  || '';
    const email        = field('Email', 'email')       || '';
    const phone        = field('Phone', 'phone')       || '';
    const website      = field('Website', 'website')   || '';
    const tiktokShop   = field('TikTok Shop Registered', 'tiktok_shop', 'tiktokShopRegistered') || '';
    const shopify      = field('Shopify Integrated', 'shopify', 'shopifyIntegrated') || '';
    const sellico      = field('Sellico', 'sellico') || '';
    const tiktokAM     = field('TikTok Account Manager', 'tiktok_am', 'tiktokAM') || '';
    const reviewsIo    = field('Reviews.io', 'reviews_io', 'reviewsIo') || '';
    const fbt          = field('FBT', 'fbt') || '';
    const brandContent = field('Brand Content', 'brand_content', 'brandContent') || '';
    const joinBrands   = field('JoinBrands Budget', 'joinbrands_budget', 'joinBrandsBudget') || '';

    // ── Create brand entry ───────────────────────────────────────────────────
    const brandsData = loadBrands();
    const brandId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const newBrand = {
      id:          brandId,
      createdAt:   new Date().toISOString(),
      name:        brandName,
      contactName: `${firstName} ${lastName}`.trim(),
      email,
      phone,
      website,
      industry:    '',
      products:    '',
      audience:    '',
      voice:       '',
      contentPillars: '',
      tiktokHandle: '',
      cta:         '',
      source:      'ghl-onboarding-form',
    };
    brandsData.clients.push(newBrand);
    saveBrands(brandsData);

    // ── Pre-check Growth Partners tasks based on form answers ────────────────
    // Map "yes" / "Yes" / checkbox truthy values
    const isYes = (v) => v && /^(yes|true|1|on|checked)$/i.test(String(v).trim());

    const gpData = loadGP();
    if (!gpData.partners) gpData.partners = {};
    const tasks = {};

    // onboarding
    tasks['contract_signed']    = false;
    tasks['brand_brief_filled'] = false;
    tasks['brand_approved']     = false;
    tasks['onboarding_call']    = false;

    // unit economics
    tasks['cogs_provided']      = false;
    tasks['margins_confirmed']  = false;
    tasks['commission_set']     = false;

    // shop ops
    tasks['shop_account']       = isYes(tiktokShop);
    tasks['shopify']            = isYes(shopify);
    tasks['sellico']            = isYes(sellico);
    tasks['whitelisting_eligible'] = isYes(tiktokAM);
    tasks['reviews']            = isYes(reviewsIo);
    tasks['fbt']                = isYes(fbt);
    tasks['product_samples']    = false;
    tasks['bundles_enabled']    = false;

    // affiliate
    tasks['ugc_source']         = isYes(joinBrands);
    tasks['creator_list']       = false;
    tasks['outreach_started']   = false;
    tasks['gmv_10k']            = false;
    tasks['gmv_50k']            = false;

    // video
    tasks['video_plan']         = isYes(brandContent);
    tasks['first_batch_live']   = false;
    tasks['10_videos_live']     = false;
    tasks['top_performer_id']   = false;

    // paid media
    tasks['spark_ads_enabled']  = false;
    tasks['first_campaign']     = false;
    tasks['roas_positive']      = false;

    // live
    tasks['live_eligible']      = false;
    tasks['first_live']         = false;
    tasks['live_regular']       = false;

    gpData.partners[brandId] = { tasks, updatedAt: new Date().toISOString() };
    saveGP(gpData);

    console.log(`[webhook] New client onboarded from GHL form: ${brandName} (${brandId})`);

    // ── Lark: create affiliate resource hub doc + alert (non-blocking) ──────────
    if (process.env.LARK_APP_ID && process.env.LARK_APP_SECRET) {
      setImmediate(async () => {
        try {
          // Copy the template doc via drive API (wiki copy requires wiki admin role)
          const TEMPLATE_DOC_TOKEN = 'RuLZdNSSkouiinxp340uXfEgtjg';
          const copyResult = await larkCopyTemplateDoc({
            docToken: TEMPLATE_DOC_TOKEN,
            title:    `${brandName} — Affiliate Resource Hub`,
          });
          const newDocToken = copyResult.data?.file?.token;
          const wikiUrl = newDocToken
            ? `https://cedw5xj2shl.usttp.larksuite.com/docx/${newDocToken}`
            : 'https://cedw5xj2shl.usttp.larksuite.com';

          // Post alert to Cult Content — Account Alerts channel
          const contactLine = [firstName, lastName].filter(Boolean).join(' ');
          const msg = [
            `🎉 New brand onboarded: ${brandName}`,
            contactLine ? `👤 Contact: ${contactLine}${email ? ` (${email})` : ''}` : null,
            website     ? `🌐 Website: ${website}` : null,
            `📚 Affiliate Resource Hub: ${wikiUrl}`,
          ].filter(Boolean).join('\n');

          await larkSendChatMessage({ chatId: LARK_ALERT_CHAT_ID, text: msg });

          console.log(`[webhook] Lark wiki created for ${brandName}: ${wikiUrl}`);
        } catch (larkErr) {
          console.warn('[webhook] Lark integration skipped:', larkErr.message);
        }
      });
    }

    // ── Optionally trigger Shopify brand import ──────────────────────────────
    // (non-blocking — we respond success first, then attempt the import)
    if (website && isYes(shopify)) {
      const shopDomain = website.replace(/^https?:\/\//i, '').replace(/\/$/, '');
      setImmediate(async () => {
        try {
          await axios.post(`http://localhost:${CFG.port}/api/brands/shopify-import`, {
            shopDomain,
            brandId,
          });
        } catch (e) {
          console.warn('[webhook] Shopify import skipped:', e.message);
        }
      });
    }

    res.json({ ok: true, brandId, brandName });
  } catch (err) {
    console.error('[webhook] ghl-client-onboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: delete brand by ID (webhook-secret protected, no CF Access needed) ─
app.delete('/api/webhooks/brand/:brandId', (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.query.secret !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const { brandId } = req.params;
  const brands = loadBrands();
  const before = brands.clients.length;
  brands.clients = brands.clients.filter(b => b.id !== brandId);
  if (brands.clients.length === before) return res.status(404).json({ error: 'Brand not found' });
  saveBrands(brands);
  const gp = loadGP();
  if (gp.partners) delete gp.partners[brandId];
  saveGP(gp);
  console.log(`[admin] Deleted brand ${brandId}`);
  res.json({ ok: true, brandId });
});

// Public routes — registered BEFORE requireAuth so no login needed
app.use('/uploads', express.static(UPLOAD_DIR));

app.use(requireAuth); // all other routes require auth in production

// Serve index.html with no-cache to prevent Cloudflare/browser serving stale versions
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});
app.get('/index.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'dashboard')));
app.use('/tools', express.static(path.join(__dirname)));

const CFG = {
  ghlApiKey:  process.env.GHL_API_KEY  || 'pit-012c1650-1032-46f0-b293-72720e727a0b',
  locationId: process.env.GHL_LOC_ID   || 'c216j58Vx9XxYa7WYMiA',
  railwayUrl: process.env.RAILWAY_URL  || 'https://cultcontent-server-production.up.railway.app',
  port:       process.env.PORT || process.env.DASHBOARD_PORT || 3457,
};

const ghl = axios.create({
  baseURL: 'https://services.leadconnectorhq.com',
  headers: {
    Authorization: `Bearer ${CFG.ghlApiKey}`,
    'Content-Type': 'application/json',
    Version: '2021-07-28',
  },
});

// ─── Simple TTL cache ──────────────────────────────────────────────────────────
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  const data = await fn();
  cache.set(key, { data, ts: Date.now() });
  return data;
}

// ─── Snapshot store ────────────────────────────────────────────────────────────
function loadSnaps() {
  try { if (fs.existsSync(SNAP_FILE)) return JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8')); }
  catch (e) { console.error('snap load:', e.message); }
  return {};
}
function saveSnaps(data) {
  try { fs.writeFileSync(SNAP_FILE, JSON.stringify(data)); }
  catch (e) { console.error('snap save:', e.message); }
}
// Record metrics for a platform/handle. De-dupes within 2 hours.
function recordSnap(platform, handle, metrics) {
  const snaps = loadSnaps();
  if (!snaps[platform]) snaps[platform] = {};
  if (!snaps[platform][handle]) snaps[platform][handle] = [];
  const arr = snaps[platform][handle];
  const now = Date.now();
  const last = arr[arr.length - 1];
  if (last && now - last.ts < 7_200_000) return; // skip if < 2h since last snap
  arr.push({ ts: now, ...metrics });
  if (arr.length > 365) arr.splice(0, arr.length - 365); // keep ~1yr at daily
  saveSnaps(snaps);
}

// ─── TikTok token helpers ──────────────────────────────────────────────────────
const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2';
const tiktokAuthState = new Map(); // PKCE state store (short-lived, in-memory)

function loadTikTokTokens() {
  try { if (fs.existsSync(TIKTOK_TOKENS_FILE)) return JSON.parse(fs.readFileSync(TIKTOK_TOKENS_FILE, 'utf8')); }
  catch(e) {}
  return {};
}
function saveTikTokTokens(tokens) {
  try { fs.writeFileSync(TIKTOK_TOKENS_FILE, JSON.stringify(tokens, null, 2)); }
  catch(e) { console.error('TikTok token save:', e.message); }
}
function getTikTokToken(account = 'personal') {
  const t = loadTikTokTokens()[account];
  if (!t || Date.now() > t.expires_at - 60_000) return null;
  return t.access_token;
}

// ─── GHL routes ───────────────────────────────────────────────────────────────
app.get('/api/ghl/contacts', async (req, res) => {
  try {
    const data = await cached('contacts', 60_000, async () => {
      const { data } = await ghl.get('/contacts/', {
        params: { locationId: CFG.locationId, limit: 25, sortBy: 'date_added' },
      });
      return data;
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// Stage priority — higher = closer to close
const STAGE_PRIORITY = {
  // Sales pipeline
  '8be01a87-16c1-4741-ba34-b5827ae598df': { name: 'Leads',              pipeline: 'Sales', priority: 1 },
  '8c0bd16c-e0f9-42b4-9e3c-e4464f07e127': { name: 'Engaged',            pipeline: 'Sales', priority: 2 },
  '22223b31-6904-49d1-8b38-bc8bb6104926': { name: 'Asked to Rebook',    pipeline: 'Sales', priority: 3 },
  'c295a69d-9794-43e8-a48b-705529c621bb': { name: 'No Show',            pipeline: 'Sales', priority: 1 },
  'd268eec7-da68-4d15-a5cf-627a309fa64c': { name: 'Booked',             pipeline: 'Sales', priority: 4 },
  '22d39138-ff86-49ac-8076-51444eb462d4': { name: 'Pitched',            pipeline: 'Sales', priority: 5 },
  '8de4bef0-77c5-4711-a306-38a5c90fdaeb': { name: 'Progressing',       pipeline: 'Sales', priority: 6 },
  '812366ea-bfe5-4283-9201-45fdc1443da2': { name: 'Hotlist',            pipeline: 'Sales', priority: 7 },
  'dc34a26b-1407-4337-a5a9-c7ad512aebdd': { name: 'Contract Signed',   pipeline: 'Sales', priority: 8 },
  '9460436e-3bc2-4b40-b225-c9437642c8cc': { name: 'Funding',           pipeline: 'Sales', priority: 9 },
  '6e634d48-b9fe-4e36-bb75-36c20bc15f26': { name: 'Down Payment',      pipeline: 'Sales', priority: 10 },
  'f668d4de-cd45-4466-87c7-3225f1b4f1b1': { name: 'Closed (Paid)',     pipeline: 'Sales', priority: 11 },
  // Client Onboarding
  'af7cd927-068b-4ff9-9f9a-1eef11e2822b': { name: 'DFY Active',        pipeline: 'Onboarding', priority: 3 },
  '01d509a7-a5ed-4750-b054-4566eb383e50': { name: 'DWY Active',        pipeline: 'Onboarding', priority: 2 },
  'c99a4890-ecb5-413f-96e6-d402dfbd8493': { name: 'DIY Active',        pipeline: 'Onboarding', priority: 1 },
  'b9436609-7d8d-48e2-a99d-09d265c7fd24': { name: 'Churned',           pipeline: 'Onboarding', priority: 0 },
  // TAP Acquisition
  '6debbdd0-216d-4427-b1d5-407d66eec493': { name: 'TAP Prospect',      pipeline: 'TAP', priority: 1 },
  '66b7c504-8b92-45b7-bc0e-b115ade1c6ea': { name: 'TAP Registered',    pipeline: 'TAP', priority: 2 },
  '07070943-cefb-490e-8b9a-9d3118cd1087': { name: 'Strategy Call',     pipeline: 'TAP', priority: 3 },
  '5ef53f71-042f-4252-b39f-d98822e54491': { name: 'Nurture',           pipeline: 'TAP', priority: 1 },
  '02f59d08-f127-425c-ac46-bfb0d05f9dbc': { name: 'Disqualified',      pipeline: 'TAP', priority: 0 },
};

// Known pipeline IDs — fetched once via /api/ghl/pipelines
const PIPELINE_IDS = [
  'Iuz4OdYK1lCynyHsL8Yf', // Sales
  'YUSTwu6HU6CaLeCsxknn', // Client Onboarding
  'cUapXHqp33s4yBipkYSd', // TAP Acquisition
  'gB4FFca2PBGzerClsyJb', // Support Channel Requests
];

app.get('/api/ghl/opportunities', async (req, res) => {
  try {
    const data = await cached('opportunities', 60_000, async () => {
      // Fetch each pipeline in parallel so we don't hit the 100-opp cap
      const results = await Promise.allSettled(
        PIPELINE_IDS.map(pid =>
          ghl.get('/opportunities/search', {
            params: { location_id: CFG.locationId, pipeline_id: pid, limit: 100 },
          }).then(r => r.data.opportunities || [])
        )
      );
      const allOpps = results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value);
      // Annotate each opportunity with stage name + pipeline + priority
      const opps = allOpps.map(o => ({
        ...o,
        stageName:    STAGE_PRIORITY[o.pipelineStageId]?.name     || 'Unknown',
        pipelineName: STAGE_PRIORITY[o.pipelineStageId]?.pipeline  || 'Other',
        stagePriority:STAGE_PRIORITY[o.pipelineStageId]?.priority  || 0,
      }));
      return { opportunities: opps, total: opps.length };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/ghl/appointments', async (req, res) => {
  try {
    const data = await cached('appointments', 60_000, async () => {
      // GHL requires a calendarId — fetch all calendars first, then merge events
      const { data: calData } = await ghl.get('/calendars/', {
        params: { locationId: CFG.locationId },
      });
      const calendars = (calData.calendars || []).slice(0, 10); // cap at 10 calendars
      if (!calendars.length) return { events: [] };

      const now = Date.now();
      const end = now + 14 * 24 * 60 * 60 * 1000;

      const results = await Promise.allSettled(
        calendars.map(cal =>
          ghl.get('/calendars/events', {
            params: { locationId: CFG.locationId, calendarId: cal.id, startTime: now, endTime: end },
          }).then(r => r.data.events || [])
        )
      );
      const events = results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value)
        .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
        .slice(0, 25);

      return { events };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/ghl/workflows', async (req, res) => {
  try {
    const data = await cached('workflows', 300_000, async () => {
      const { data } = await ghl.get('/workflows/', {
        params: { locationId: CFG.locationId },
      });
      return data;
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/ghl/conversations', async (req, res) => {
  try {
    const data = await cached('conversations', 60_000, async () => {
      const { data } = await ghl.get('/conversations/search', {
        params: { locationId: CFG.locationId, limit: 10 },
      });
      return data;
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// ─── Railway health ────────────────────────────────────────────────────────────
app.get('/api/railway/health', async (req, res) => {
  try {
    const data = await cached('railway', 30_000, async () => {
      const { data } = await axios.get(`${CFG.railwayUrl}/health`, { timeout: 5000 });
      return { ...data, status: 'online', url: CFG.railwayUrl };
    });
    res.json(data);
  } catch (e) {
    res.json({ status: 'offline', error: e.message, url: CFG.railwayUrl });
  }
});

// ─── Cache control ─────────────────────────────────────────────────────────────
app.post('/api/clear-cache', (req, res) => {
  cache.clear();
  res.json({ ok: true });
});

// ─── Buffer content pipeline ───────────────────────────────────────────────────
app.get('/api/buffer/stats', async (req, res) => {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) return res.json({ connected: false });

  try {
    const data = await cached('buffer_stats', 120_000, async () => {
      const orgId = process.env.BUFFER_ORG_ID || '69d6ddee1fcceb5bb1faa168';
      const { data: gql } = await axios.post(
        'https://api.buffer.com/graphql',
        {
          query: `{
            posts(input:{organizationId:"${orgId}",filter:{status:[scheduled]},sort:[{field:dueAt,direction:asc}]},first:100){
              edges{node{id dueAt channelId channelService status text}}
              pageInfo{hasNextPage}
            }
          }`,
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      const posts = (gql.data?.posts?.edges || []).map(e => e.node);
      const byPlatform = {};
      for (const p of posts) {
        byPlatform[p.channelService] = (byPlatform[p.channelService] || 0) + 1;
      }
      return {
        connected: true,
        scheduledTotal: posts.length,
        hasMore: gql.data?.posts?.pageInfo?.hasNextPage || false,
        byPlatform,
        nextPost: posts[0] || null,
        upcoming: posts.slice(0, 5),
      };
    });
    res.json(data);
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

// ─── YouTube stats (multi-channel) ───────────────────────────────────────────
const YT_CHANNEL_LABELS = { 'Cult-Content-CC': 'Cult Content', 'tommylynch5162': 'Tommy Lynch' };

async function fetchYTChannel(handle, key) {
  const { data } = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
    params: { part: 'statistics,snippet', forHandle: handle, key }
  });
  const ch = data.items?.[0];
  if (!ch) return null;
  const channelId = ch.id;
  const { data: vData } = await axios.get('https://www.googleapis.com/youtube/v3/search', {
    params: { part: 'snippet', channelId, order: 'date', maxResults: 50, type: 'video', key }
  });
  const videoIds = (vData.items || []).map(v => v.id.videoId).filter(Boolean).join(',');
  let videos = [];
  if (videoIds) {
    const { data: vsData } = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: { part: 'statistics,snippet', id: videoIds, key }
    });
    videos = (vsData.items || []).map(v => ({
      id: v.id, title: v.snippet.title, publishedAt: v.snippet.publishedAt,
      thumbnail: v.snippet.thumbnails?.default?.url,
      views: Number(v.statistics.viewCount || 0),
      likes: Number(v.statistics.likeCount || 0),
      comments: Number(v.statistics.commentCount || 0),
    }));
  }
  return {
    handle, label: YT_CHANNEL_LABELS[handle] || ch.snippet.title,
    channelName: ch.snippet.title,
    subscribers: Number(ch.statistics.subscriberCount || 0),
    totalViews: Number(ch.statistics.viewCount || 0),
    videoCount: Number(ch.statistics.videoCount || 0),
    recentVideos: videos,
  };
}

app.get('/api/youtube/stats', async (req, res) => {
  try {
    const data = await cached('youtube', 300_000, async () => {
      if (!process.env.YOUTUBE_API_KEY) return { connected: false };
      const key = process.env.YOUTUBE_API_KEY;
      const handles = (process.env.YOUTUBE_CHANNELS || 'Cult-Content-CC').split(',').map(h => h.trim());
      const results = await Promise.allSettled(handles.map(h => fetchYTChannel(h, key)));
      const channels = results
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);
      channels.forEach(ch => recordSnap('youtube', ch.handle, { subscribers: ch.subscribers, totalViews: ch.totalViews, videoCount: ch.videoCount }));
      return { connected: true, channels };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ connected: false, error: e.response?.data?.error?.message || e.message });
  }
});

// ─── Social stats (TikTok + Instagram + X + LinkedIn via Apify) ───────────────
const SOCIAL_HANDLES = {
  tiktok: [
    { handle: process.env.TIKTOK_HANDLE_PERSONAL || '', label: 'Tommy Lynch' },
    { handle: process.env.TIKTOK_HANDLE_BRAND    || '', label: 'Cult Content' },
  ].filter(h => h.handle),
  instagram: [
    { handle: process.env.IG_HANDLE_PERSONAL || 'tommy.lynch_', label: 'Tommy Lynch' },
    { handle: process.env.IG_HANDLE_BRAND    || '',              label: 'Cult Content' },
  ].filter(h => h.handle),
  twitter: [
    { handle: process.env.X_HANDLE_PERSONAL || '', label: 'Tommy Lynch' },
    { handle: process.env.X_HANDLE_BRAND    || '', label: 'Cult Content' },
  ].filter(h => h.handle),
  linkedin: [
    { handle: process.env.LINKEDIN_HANDLE_PERSONAL || '', label: 'Tommy Lynch',  type: 'personal' },
    { handle: process.env.LINKEDIN_HANDLE_BRAND    || '', label: 'Cult Content', type: 'company'  },
  ].filter(h => h.handle),
};

app.get('/api/social/stats', async (req, res) => {
  try {
    const data = await cached('social', 600_000, async () => {
      if (!process.env.APIFY_API_KEY) return { connected: false };

      const results = { connected: true, tiktok: [], instagram: [] };

      const token = process.env.APIFY_API_KEY;

      // TikTok profiles — try Display API first (if tokens present), fall back to Apify
      if (SOCIAL_HANDLES.tiktok.length > 0) {
        const ttTokens = loadTikTokTokens();
        const ttPairs = [
          { key: 'personal', cfg: SOCIAL_HANDLES.tiktok[0] },
          { key: 'brand',    cfg: SOCIAL_HANDLES.tiktok[1] },
        ].filter(p => p.cfg && getTikTokToken(p.key));

        if (ttPairs.length > 0) {
          // Display API path
          for (const { key, cfg } of ttPairs) {
            try {
              const { data: r } = await axios.get(`${TIKTOK_API_BASE}/user/info/`, {
                headers: { Authorization: `Bearer ${getTikTokToken(key)}` },
                params: { fields: 'display_name,avatar_url,follower_count,likes_count,video_count' },
              });
              if (r.error?.code === 'ok') {
                const u = r.data.user;
                const entry = { label: cfg.label, handle: cfg.handle, followers: u.follower_count || 0, likes: u.likes_count || 0, videos: u.video_count || 0, avatar: u.avatar_url, source: 'display_api' };
                results.tiktok.push(entry);
                recordSnap('tiktok', cfg.handle, { followers: entry.followers, likes: entry.likes, videos: entry.videos });
              }
            } catch(e) { console.error(`TikTok Display API (${key}):`, e.message); }
          }
        } else {
          // Apify fallback
          try {
            const { data: runData } = await axios.post(
              `https://api.apify.com/v2/acts/clockworks~tiktok-profile-scraper/run-sync-get-dataset-items?token=${token}&timeout=60&memory=256`,
              { profiles: SOCIAL_HANDLES.tiktok.map(h => `https://www.tiktok.com/@${h.handle}`), resultsType: 'profiles', maxProfilesPerQuery: 1 },
              { timeout: 90000 }
            );
            results.tiktok = (runData || []).map(item => {
              const h = item.authorMeta?.name;
              const config = SOCIAL_HANDLES.tiktok.find(s => s.handle === h);
              return { label: config?.label || item.authorMeta?.nickName, handle: h, followers: item.authorMeta?.fans || 0, likes: item.authorMeta?.heart || 0, videos: item.authorMeta?.video || 0, avatar: item.authorMeta?.avatar };
            });
            results.tiktok.forEach(a => recordSnap('tiktok', a.handle, { followers: a.followers, likes: a.likes, videos: a.videos }));
          } catch(e) {
            const status = e.response?.status;
            console.error('TikTok Apify error:', e.response?.data || e.message);
            if (status === 402) results.apifyBillingRequired = true;
          }
        }
      }

      // Instagram profiles via Apify
      if (SOCIAL_HANDLES.instagram.length > 0) {
        try {
          const { data: runData } = await axios.post(
            `https://api.apify.com/v2/acts/apify~instagram-profile-scraper/run-sync-get-dataset-items?token=${token}&timeout=60&memory=256`,
            { usernames: SOCIAL_HANDLES.instagram.map(h => h.handle) },
            { timeout: 90000 }
          );
          results.instagram = (runData || []).map(item => {
            const config = SOCIAL_HANDLES.instagram.find(s => s.handle === item.username);
            return {
              label: config?.label || item.username,
              handle: item.username,
              followers: item.followersCount || 0,
              following: item.followsCount || 0,
              posts: item.postsCount || 0,
              avatar: item.profilePicUrl,
            };
          });
          results.instagram.forEach(a => recordSnap('instagram', a.handle, { followers: a.followers, following: a.following, posts: a.posts }));
        } catch (e) {
          const status = e.response?.status;
          console.error('Instagram Apify error:', e.response?.data || e.message);
          if (status === 402) results.apifyBillingRequired = true;
        }
      }

      results.twitter = [];
      results.linkedin = [];

      return results;
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ connected: false, error: e.message });
  }
});

// ─── Twitter / X stats (via Apify pratikdani~twitter-profile-scraper) ──────────
app.get('/api/twitter/stats', async (req, res) => {
  try {
    const data = await cached('twitter', 1_800_000, async () => {
      const token = process.env.APIFY_API_KEY;
      if (!token) return { connected: false };

      const handles = [
        { handle: process.env.X_HANDLE_PERSONAL || 'thlynch3', label: 'Tommy Lynch' },
        process.env.X_HANDLE_BRAND ? { handle: process.env.X_HANDLE_BRAND, label: 'Cult Content' } : null,
      ].filter(Boolean);

      const results = await Promise.allSettled(
        handles.map(h =>
          axios.post(
            `https://api.apify.com/v2/acts/pratikdani~twitter-profile-scraper/run-sync-get-dataset-items?token=${token}&memory=256&timeout=60`,
            { url: `https://twitter.com/${h.handle}` },
            { timeout: 90_000 }
          ).then(r => ({ handle: h.handle, label: h.label, raw: (r.data || [])[0] }))
        )
      );

      const accounts = results
        .filter(r => r.status === 'fulfilled' && r.value?.raw)
        .map(r => {
          const { handle, label, raw } = r.value;
          return {
            handle,
            label,
            followers:  raw.sub_count   || 0,
            following:  raw.friends      || 0,
            posts:      raw.statuses_count || 0,
            avatar:     raw.avatar       || null,
            name:       raw.name         || label,
          };
        });

      accounts.forEach(a => recordSnap('twitter', a.handle, { followers: a.followers, following: a.following, posts: a.posts }));

      return { connected: accounts.length > 0, accounts };
    });
    res.json(data);
  } catch (e) {
    console.error('Twitter stats error:', e.message);
    res.json({ connected: false, error: e.message, accounts: [] });
  }
});

// ─── LinkedIn stats (via Apify harvestapi~linkedin-profile-scraper) ───────────
app.get('/api/linkedin/stats', async (req, res) => {
  try {
    const data = await cached('linkedin', 1_800_000, async () => {
      const token = process.env.APIFY_API_KEY;
      if (!token) return { connected: false };

      const profiles = [
        process.env.LINKEDIN_HANDLE_PERSONAL
          ? { url: `https://www.linkedin.com/in/${process.env.LINKEDIN_HANDLE_PERSONAL}/`,  label: 'Tommy Lynch',  type: 'personal' }
          : null,
        process.env.LINKEDIN_HANDLE_BRAND
          ? { url: `https://www.linkedin.com/company/${process.env.LINKEDIN_HANDLE_BRAND}/`, label: 'Cult Content', type: 'company' }
          : null,
      ].filter(Boolean);

      // Scrape all profiles in one batch call
      const { data: runData } = await axios.post(
        `https://api.apify.com/v2/acts/harvestapi~linkedin-profile-scraper/run-sync-get-dataset-items?token=${token}&memory=256&timeout=90`,
        { urls: profiles.map(p => p.url) },
        { timeout: 120_000 }
      );

      const accounts = (runData || []).map(item => {
        const url = item.linkedinUrl || '';
        const config = profiles.find(p => url.includes(p.label === 'Cult Content' ? 'company/' : 'in/'));
        // Match by URL path
        const matched = profiles.find(p => {
          const pPath = p.url.replace(/^https:\/\/www\.linkedin\.com/, '').replace(/\/$/, '');
          return url.includes(pPath.replace(/\/$/, '').split('/').pop());
        }) || profiles[0];
        return {
          label:       matched?.label || item.name || item.firstName,
          type:        matched?.type  || 'personal',
          handle:      item.publicIdentifier || item.universalName,
          followers:   item.followerCount    || 0,
          connections: item.connectionsCount || 0,
          name:        item.name || `${item.firstName || ''} ${item.lastName || ''}`.trim(),
          avatar:      item.profilePicture?.url || item.logo || null,
          headline:    item.headline || item.tagline || null,
        };
      });

      accounts.forEach(a => recordSnap('linkedin', a.handle, { followers: a.followers, connections: a.connections || 0 }));

      return { connected: accounts.length > 0, accounts };
    });
    res.json(data);
  } catch (e) {
    console.error('LinkedIn stats error:', e.message);
    res.json({ connected: false, error: e.message, accounts: [] });
  }
});

// ─── GHL pipeline stages (for stage name lookup) ──────────────────────────────
app.get('/api/ghl/pipelines', async (req, res) => {
  try {
    const data = await cached('pipelines', 600_000, async () => {
      const { data } = await ghl.get('/opportunities/pipelines', {
        params: { locationId: CFG.locationId },
      });
      return data;
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// ─── Performance history & deltas ─────────────────────────────────────────────
app.get('/api/performance/history', (req, res) => {
  const snaps = loadSnaps();
  const now = Date.now();
  const result = {};

  for (const [platform, handles] of Object.entries(snaps)) {
    result[platform] = {};
    for (const [handle, arr] of Object.entries(handles)) {
      if (!arr.length) continue;
      const current = arr[arr.length - 1];
      // Find closest snapshot before each lookback window
      const find = (ms) => {
        const target = now - ms;
        return arr.slice().reverse().find(s => s.ts <= target) || null;
      };
      const ago7d  = find(7  * 86_400_000);
      const ago30d = find(30 * 86_400_000);
      const ago90d = find(90 * 86_400_000);
      result[platform][handle] = {
        current,
        history: arr,
        delta: {
          '7d':  ago7d  ? { followers: current.followers - ago7d.followers,  ts: ago7d.ts  } : null,
          '30d': ago30d ? { followers: current.followers - ago30d.followers, ts: ago30d.ts } : null,
          '90d': ago90d ? { followers: current.followers - ago90d.followers, ts: ago90d.ts } : null,
        },
      };
    }
  }
  res.json(result);
});

// ─── Upload queue helpers ─────────────────────────────────────────────────────
function loadQueue() {
  try { if (fs.existsSync(QUEUE_FILE)) return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); }
  catch (e) {}
  return [];
}
function saveQueue(q) {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2)); }
  catch (e) { console.error('queue save:', e.message); }
}

// Multer — store in /uploads, preserve original extension
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext  = path.extname(file.originalname) || '.mp4';
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },   // 500 MB cap
  fileFilter: (_, file, cb) => cb(null, /video|audio|mp4|mov|avi|webm|mp3|m4a|wav/i.test(file.mimetype + file.originalname)),
});

// POST /api/proposals/publish — saves HTML to UPLOAD_DIR (public via CF bypass) and returns a shareable link
app.post('/api/proposals/publish', express.json({ limit: '5mb' }), (req, res) => {
  try {
    const { html } = req.body;
    if (!html) return res.status(400).json({ error: 'No HTML provided' });
    const id = require('crypto').randomBytes(12).toString('hex');
    const filename = `proposal-${id}.html`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), html, 'utf8');
    // Use the Railway raw URL — bypasses Cloudflare Access so prospects can view without auth
    const baseUrl = 'https://cult-command-center-production.up.railway.app';
    res.json({ ok: true, url: `${baseUrl}/uploads/${filename}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/upload/video
app.post('/api/upload/video', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const localUrl = `/uploads/${req.file.filename}`;
  const meta = {
    id:          req.file.filename,
    originalName: req.file.originalname,
    filename:    req.file.filename,
    size:        req.file.size,
    title:       req.body.title        || path.basename(req.file.originalname, path.extname(req.file.originalname)),
    description: req.body.description  || '',
    platforms:   req.body.platforms    ? req.body.platforms.split(',').map(s => s.trim()) : [],
    status:      'staged',
    uploadedAt:  new Date().toISOString(),
    path:        req.file.path,
    localUrl,
  };
  const q = loadQueue();
  q.unshift(meta);
  saveQueue(q);
  res.json({ ok: true, video: meta });
});

// GET /api/upload/queue
app.get('/api/upload/queue', (req, res) => {
  res.json(loadQueue());
});

// DELETE /api/upload/queue/:id
app.delete('/api/upload/queue/:id', (req, res) => {
  const q = loadQueue().filter(v => v.id !== req.params.id);
  // Remove file from disk
  const target = path.join(UPLOAD_DIR, req.params.id);
  if (fs.existsSync(target)) fs.unlinkSync(target);
  saveQueue(q);
  res.json({ ok: true });
});

// PATCH /api/upload/queue/:id — update status, or upsert if not found (for Arcads entries)
app.patch('/api/upload/queue/:id', (req, res) => {
  const q = loadQueue();
  const idx = q.findIndex(v => v.id === req.params.id);
  if (idx >= 0) {
    q[idx] = { ...q[idx], ...req.body };
  } else {
    // Upsert — used by Arcads to add URL-based entries without file upload
    q.unshift({ id: req.params.id, ...req.body });
  }
  saveQueue(q);
  res.json({ ok: true });
});

// GET /api/ghl/consultants — pull real form submission dates from the onboarding form
const CONSULTANT_FORM_ID = 'yKOFTYIE2Li3eLxxSXpW';
app.get('/api/ghl/consultants', async (req, res) => {
  try {
    const data = await cached('consultants', 120_000, async () => {
      const { data } = await ghl.get('/forms/submissions', {
        params: { locationId: CFG.locationId, formId: CONSULTANT_FORM_ID, limit: 100 },
      });
      const subs = (data.submissions || [])
        .filter(s => s.name && !/^(test|tommy lynch|george washington|prosperous life|dream big)/i.test(s.name.trim()))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const now = Date.now();
      const day = 86_400_000;
      return {
        total:     subs.length,
        thisWeek:  subs.filter(s => now - new Date(s.createdAt).getTime() < 7  * day).length,
        thisMonth: subs.filter(s => now - new Date(s.createdAt).getTime() < 30 * day).length,
        recent: subs.slice(0, 5).map(s => ({
          name:      s.name,
          createdAt: s.createdAt,
        })),
      };
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// POST /api/consultant/trigger — proxy to Railway webhook
app.post('/api/consultant/trigger', async (req, res) => {
  try {
    const { data } = await axios.post(
      `${CFG.railwayUrl}/consultant-onboard`,
      req.body,
      { timeout: 30_000 }
    );
    res.json({ ok: true, result: data });
  } catch (e) {
    const msg = e.response?.data?.error || e.response?.data?.message || e.message;
    res.json({ ok: false, error: msg });
  }
});

// ─── Arcads AI Video API ──────────────────────────────────────────────────────
const ARCADS_BASE = 'https://external-api.arcads.ai';
function arcadsClient() {
  const tok = 'Basic ' + Buffer.from(
    `${process.env.ARCADS_CLIENT_ID}:${process.env.ARCADS_CLIENT_SECRET}`
  ).toString('base64');
  return axios.create({ baseURL: ARCADS_BASE, headers: { Authorization: tok, 'Content-Type': 'application/json' } });
}

// GET /api/arcads/actors — list situations (actors) with optional filters
app.get('/api/arcads/actors', async (req, res) => {
  try {
    if (!process.env.ARCADS_CLIENT_ID) return res.json({ connected: false });
    const data = await cached('arcads_actors', 3_600_000, async () => {
      const { data } = await arcadsClient().get('/v1/situations?limit=100');
      return data;
    });
    res.json({ connected: true, ...data });
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// GET /api/arcads/stats — aggregate video counts across all scripts
app.get('/api/arcads/stats', async (req, res) => {
  try {
    if (!process.env.ARCADS_CLIENT_ID) return res.json({ connected: false });
    const productId = process.env.ARCADS_PRODUCT_ID;
    const { data } = await arcadsClient().get(`/v1/products/${productId}/folders`);
    const scripts = data.items.flatMap(f =>
      (f.scripts || []).map(s => ({ ...s, folderName: f.name, folderId: f.id }))
    );
    // Fetch video status for all scripts in parallel (cap at 20 most recent)
    const recent = scripts.slice(0, 20);
    const videoResults = await Promise.allSettled(
      recent.map(s => arcadsClient().get(`/v1/scripts/${s.id}/videos`).then(r => r.data))
    );
    const scriptStats = recent.map((s, i) => {
      const vids = videoResults[i].status === 'fulfilled'
        ? (Array.isArray(videoResults[i].value) ? videoResults[i].value : [])
        : [];
      const done    = vids.filter(v => v.videoStatus === 'completed' || v.videoUrl).length;
      const pending = vids.filter(v => v.videoStatus === 'pending' || v.videoStatus === 'processing' || v.videoStatus === 'generating').length;
      const failed  = vids.filter(v => v.videoStatus === 'failed' || v.videoStatus === 'error').length;
      const firstUrl = vids.find(v => v.videoUrl)?.videoUrl;
      return { id: s.id, name: s.name, folderName: s.folderName, done, pending, failed, firstUrl };
    });
    const totals = { scripts: scripts.length, done: 0, pending: 0, failed: 0 };
    scriptStats.forEach(s => { totals.done += s.done; totals.pending += s.pending; totals.failed += s.failed; });
    res.json({ connected: true, totals, scripts: scriptStats });
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// GET /api/arcads/scripts — list all scripts across folders
app.get('/api/arcads/scripts', async (req, res) => {
  try {
    if (!process.env.ARCADS_CLIENT_ID) return res.json({ connected: false });
    const productId = process.env.ARCADS_PRODUCT_ID;
    const { data } = await arcadsClient().get(`/v1/products/${productId}/folders`);
    const scripts = data.items.flatMap(f =>
      (f.scripts || []).map(s => ({ ...s, folderName: f.name, folderId: f.id }))
    );
    res.json({ connected: true, scripts, folders: data.items.map(f => ({ id: f.id, name: f.name })) });
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// POST /api/arcads/scripts — create a new script with actor assignments
app.post('/api/arcads/scripts', async (req, res) => {
  try {
    const { name, text, situationIds, folderId } = req.body;
    if (!name || !text || !situationIds?.length) return res.status(400).json({ error: 'name, text, and situationIds are required' });
    const videos = situationIds.map(id => ({ situationId: id }));
    const { data } = await arcadsClient().post('/v1/scripts', {
      folderId: folderId || process.env.ARCADS_FOLDER_ID,
      name, text, videos,
    });
    res.json({ ok: true, script: data });
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// POST /api/arcads/scripts/:id/generate — kick off video generation
app.post('/api/arcads/scripts/:id/generate', async (req, res) => {
  try {
    const { data } = await arcadsClient().post(`/v1/scripts/${req.params.id}/generate`);
    res.json({ ok: true, result: data });
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// GET /api/arcads/scripts/:id/videos — poll for generation status + download URLs
app.get('/api/arcads/scripts/:id/videos', async (req, res) => {
  try {
    const { data } = await arcadsClient().get(`/v1/scripts/${req.params.id}/videos`);
    res.json(Array.isArray(data) ? data : []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/buffer/post — post a video or text to Buffer from staging queue
app.post('/api/buffer/post', async (req, res) => {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) return res.json({ ok: false, error: 'No Buffer token' });
  try {
    const { channelId, text, mediaUrl, scheduledAt } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId is required' });
    const orgId = process.env.BUFFER_ORG_ID || '69d6ddee1fcceb5bb1faa168';
    const input = {
      organizationId: orgId,
      channelIds: [channelId],
      content: {
        text: text || '',
        ...(mediaUrl ? { mediaUrls: [mediaUrl] } : {}),
      },
      ...(scheduledAt ? { scheduledAt } : { dueAt: null }),
    };
    const { data: gql } = await axios.post(
      'https://api.buffer.com/graphql',
      {
        query: `mutation CreatePost($input: CreatePostInput!) {
          createPost(input: $input) {
            ... on PostActionSuccess { post { id dueAt status channelService } }
            ... on NotFoundError { message }
            ... on UnauthorizedError { message }
            ... on UnexpectedError { message }
            ... on RestProxyError { message }
            ... on LimitReachedError { message }
            ... on InvalidInputError { message }
          }
        }`,
        variables: { input },
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    if (gql.errors) return res.json({ ok: false, error: gql.errors[0]?.message });
    const result = gql.data?.createPost;
    if (result?.message) return res.json({ ok: false, error: result.message });
    res.json({ ok: true, post: result?.post });
  } catch (e) { res.status(500).json({ ok: false, error: e.response?.data || e.message }); }
});

// POST /api/buffer/post-to-channels — post to multiple Buffer channels at once
// Body: { channelIds: string[], text: string, mediaUrl?: string, scheduledAt?: string }
app.post('/api/buffer/post-to-channels', async (req, res) => {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) return res.status(400).json({ ok: false, error: 'BUFFER_ACCESS_TOKEN not configured' });

  const { channelIds, text, mediaUrl, scheduledAt } = req.body;
  if (!channelIds?.length) return res.status(400).json({ error: 'channelIds array is required' });

  const orgId = process.env.BUFFER_ORG_ID || '69d6ddee1fcceb5bb1faa168';
  const BUFFER_GQL = 'https://api.buffer.com/graphql';
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const results = [];
  for (const channelId of channelIds) {
    try {
      const input = {
        organizationId: orgId,
        channelIds: [channelId],
        content: {
          text: text || '',
          ...(mediaUrl ? { mediaUrls: [mediaUrl] } : {}),
        },
        ...(scheduledAt ? { scheduledAt } : {}),
      };
      const { data: gql } = await axios.post(
        BUFFER_GQL,
        {
          query: `mutation CreatePost($input: CreatePostInput!) {
            createPost(input: $input) {
              ... on PostActionSuccess { post { id dueAt status channelService } }
              ... on PostActionError { message }
            }
          }`,
          variables: { input },
        },
        { headers }
      );
      const result = gql.data?.createPost;
      if (gql.errors) {
        results.push({ channelId, ok: false, error: gql.errors[0]?.message });
      } else if (result?.message) {
        results.push({ channelId, ok: false, error: result.message });
      } else {
        results.push({ channelId, ok: true, post: result?.post });
      }
    } catch (e) {
      results.push({ channelId, ok: false, error: e.response?.data || e.message });
    }
  }

  const allOk = results.every(r => r.ok);
  res.json({ ok: allOk, results });
});

// GET /api/buffer/channels — list Buffer channels for posting UI
app.get('/api/buffer/channels', async (req, res) => {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) return res.json({ channels: [] });
  try {
    const data = await cached('buffer_channels', 3_600_000, async () => {
      const orgId = process.env.BUFFER_ORG_ID || '69d6ddee1fcceb5bb1faa168';
      const { data: gql } = await axios.post(
        'https://api.buffer.com/graphql',
        {
          query: `{
            channels(input:{organizationId:"${orgId}"}) {
              id name service serviceId avatar
            }
          }`,
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      return gql.data?.channels || [];
    });
    res.json({ channels: data });
  } catch (e) { res.json({ channels: [], error: e.message }); }
});

// ─── Reacher / TikTok Affiliate Manager ───────────────────────────────────────
// All Reacher calls proxy through Railway (which holds REACHER_API_KEY).

// GET /api/reacher/stats?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
app.get('/api/reacher/stats', async (req, res) => {
  const { start_date, end_date } = req.query;
  const cacheKey = `reacher_stats:${start_date||''}:${end_date||''}`;
  try {
    const data = await cached(cacheKey, 5 * 60_000, async () => {
      const params = {};
      if (start_date) params.start_date = start_date;
      if (end_date)   params.end_date   = end_date;
      const { data } = await axios.get(`${CFG.railwayUrl}/affiliate/stats`, { params, timeout: 30_000 });
      return data;
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/reacher/timeseries  { start_date, end_date, granularity? }
app.post('/api/reacher/timeseries', async (req, res) => {
  try {
    const { data } = await axios.post(
      `${CFG.railwayUrl}/affiliate/agency/timeseries`,
      req.body, { timeout: 30_000 }
    );
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reacher/shops/:shopId/funnel', async (req, res) => {
  const { shopId } = req.params;
  try {
    const data = await cached(`reacher_funnel_${shopId}`, 5 * 60_000, async () => {
      const { data } = await axios.get(`${CFG.railwayUrl}/affiliate/shops/${shopId}/funnel`, { timeout: 15_000 });
      return data;
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reacher/shops/:shopId/creators', async (req, res) => {
  const { shopId } = req.params;
  try {
    const { data } = await axios.post(
      `${CFG.railwayUrl}/affiliate/shops/${shopId}/creators`,
      req.body, { timeout: 15_000 }
    );
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/reacher/shops — list all shops
app.get('/api/reacher/shops', async (req, res) => {
  try {
    const data = await cached('reacher_shops', 5 * 60_000, async () => {
      const { data } = await axios.get(`${CFG.railwayUrl}/affiliate/shops`, { timeout: 15_000 });
      return data;
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/reacher/shops/:shopId/automations
app.get('/api/reacher/shops/:shopId/automations', async (req, res) => {
  const { shopId } = req.params;
  try {
    const data = await cached(`reacher_automations_${shopId}`, 5 * 60_000, async () => {
      const { data } = await axios.get(`${CFG.railwayUrl}/affiliate/shops/${shopId}/automations`, { timeout: 15_000 });
      return data;
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/reacher/shops/:shopId/creators/top
app.get('/api/reacher/shops/:shopId/creators/top', async (req, res) => {
  const { shopId } = req.params;
  try {
    const data = await cached(`reacher_top_creators_${shopId}`, 5 * 60_000, async () => {
      const { data } = await axios.get(`${CFG.railwayUrl}/affiliate/shops/${shopId}/creators/top`, { timeout: 15_000 });
      return data;
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/reacher/shops/:shopId/videos
app.post('/api/reacher/shops/:shopId/videos', async (req, res) => {
  const { shopId } = req.params;
  try {
    const { data } = await axios.post(
      `${CFG.railwayUrl}/affiliate/shops/${shopId}/videos`,
      req.body, { timeout: 15_000 }
    );
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/reacher/shops/:shopId/samples
app.post('/api/reacher/shops/:shopId/samples', async (req, res) => {
  const { shopId } = req.params;
  try {
    const { data } = await axios.post(
      `${CFG.railwayUrl}/affiliate/shops/${shopId}/samples`,
      req.body, { timeout: 15_000 }
    );
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/command  { text, context?, source? }
// Fires message to Lark alerts channel via Railway.
app.post('/api/command', async (req, res) => {
  try {
    const { data } = await axios.post(
      `${CFG.railwayUrl}/command`,
      { ...req.body, source: 'Command Center' },
      { timeout: 10_000 }
    );
    res.json(data);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── Skool community stats (scrape public about page) ─────────────────────────
app.get('/api/skool/stats', async (req, res) => {
  try {
    const data = await cached('skool_stats', 10 * 60_000, async () => {
      const { data: html } = await axios.get('https://www.skool.com/cult-content/about', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        timeout: 10_000,
      });
      const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!match) throw new Error('Could not find page data');
      const pageData = JSON.parse(match[1]);
      const meta = pageData?.props?.pageProps?.currentGroup?.metadata || {};
      const price = (() => {
        try { const p = JSON.parse(meta.displayPrice || '{}'); return p.amount ? p.amount / 100 : null; } catch { return null; }
      })();
      return {
        connected:    true,
        name:         meta.displayName || 'Cult Content',
        slug:         'cult-content',
        description:  meta.description || '',
        members:      meta.totalMembers || 0,
        online:       meta.totalOnlineMembers || 0,
        admins:       meta.totalAdmins || 0,
        courses:      meta.numCourses || 0,
        modules:      meta.numModules || 0,
        posts:        meta.totalPosts || 0,
        price,
        currency:     'usd',
        logoUrl:      meta.logoUrl || '',
        fetched_at:   new Date().toISOString(),
      };
    });
    res.json(data);
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

// ─── Skool recent joins (stored from Railway webhook receiver) ─────────────────
app.get('/api/skool/events', async (req, res) => {
  try {
    const { data } = await axios.get(`${CFG.railwayUrl}/skool-events`, { timeout: 5_000 });
    res.json(data);
  } catch (e) {
    res.json({ events: [], error: e.message });
  }
});

// ─── Stubs (OAuth integrations — connect later) ────────────────────────────────
app.get('/api/gmail/stats',  (_, res) => res.json({ connected: false }));
app.get('/api/gcal/events',  (_, res) => res.json({ connected: false }));
app.get('/api/lark/data',    (_, res) => res.json({ connected: false }));

// ─── Agent Manager ────────────────────────────────────────────────────────────
function loadAgents() {
  try { if (fs.existsSync(AGENTS_FILE)) return JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')); }
  catch (e) { console.error('agents load:', e.message); }
  return { agents: [] };
}
function saveAgents(data) {
  try { fs.writeFileSync(AGENTS_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('agents save:', e.message); }
}

async function runAgent(agent) {
  const now = new Date().toISOString();
  const data = loadAgents();
  const idx  = data.agents.findIndex(a => a.id === agent.id);
  try {
    let result;
    if (agent.type === 'webhook') {
      const method  = (agent.action?.method || 'POST').toLowerCase();
      let payload = {};
      try { if (agent.action?.payload) payload = JSON.parse(agent.action.payload); } catch {}
      const resp = await (method === 'get'
        ? axios.get(agent.action.webhookUrl,  { params: payload, timeout: 15_000 })
        : axios.post(agent.action.webhookUrl, payload, { timeout: 15_000 }));
      result = { status: resp.status, data: resp.data };
    } else if (agent.type === 'command') {
      const resp = await axios.post(`${CFG.railwayUrl}/command`, {
        text:    agent.action?.commandText || agent.name,
        context: agent.name,
        source:  'Agent Manager',
      }, { timeout: 10_000 });
      result = resp.data;
    } else {
      result = { note: 'GHL workflow agents are managed via GHL directly.' };
    }
    if (idx >= 0) {
      data.agents[idx] = { ...data.agents[idx], lastRunAt: now, lastRunStatus: 'ok',
        lastRunResult: JSON.stringify(result).slice(0, 500), runCount: (data.agents[idx].runCount || 0) + 1 };
      saveAgents(data);
    }
    return { ok: true, result };
  } catch (e) {
    if (idx >= 0) {
      data.agents[idx] = { ...data.agents[idx], lastRunAt: now, lastRunStatus: 'error', lastRunResult: e.message };
      saveAgents(data);
    }
    return { ok: false, error: e.message };
  }
}

app.get('/api/agents', (req, res) => res.json(loadAgents()));

app.post('/api/agents', (req, res) => {
  const { name, description, type, enabled, scheduleIntervalMs, action, tags } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
  const data = loadAgents();
  const agent = {
    id: crypto.randomUUID(), name, description: description || '', type,
    enabled: enabled !== false, scheduleIntervalMs: Number(scheduleIntervalMs) || 0,
    action: action || {}, tags: tags || [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastRunAt: null, lastRunStatus: null, lastRunResult: null, runCount: 0,
  };
  data.agents.unshift(agent);
  saveAgents(data);
  res.json({ ok: true, agent });
});

app.put('/api/agents/:id', (req, res) => {
  const data = loadAgents();
  const idx  = data.agents.findIndex(a => a.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Agent not found' });
  data.agents[idx] = { ...data.agents[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
  saveAgents(data);
  res.json({ ok: true, agent: data.agents[idx] });
});

app.delete('/api/agents/:id', (req, res) => {
  const data   = loadAgents();
  const before = data.agents.length;
  data.agents  = data.agents.filter(a => a.id !== req.params.id);
  if (data.agents.length === before) return res.status(404).json({ error: 'Agent not found' });
  saveAgents(data);
  res.json({ ok: true });
});

app.post('/api/agents/:id/run', async (req, res) => {
  const agent = loadAgents().agents.find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(await runAgent(agent));
});

// Scheduled agent runner — checks every 60 s
setInterval(() => {
  const { agents } = loadAgents();
  const now = Date.now();
  for (const agent of agents) {
    if (!agent.enabled || !agent.scheduleIntervalMs) continue;
    const lastRun = agent.lastRunAt ? new Date(agent.lastRunAt).getTime() : 0;
    if (now - lastRun >= agent.scheduleIntervalMs) {
      console.log(`[scheduler] Running agent: ${agent.name}`);
      runAgent(agent).catch(e => console.error('[scheduler] Error:', e.message));
    }
  }
}, 60_000);

// ─── Affiliate Agent routes ──────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Affiliate Agent — routes.js
// New Express routes to append to dashboard-server.js.
//
// Insertion point: paste these after the existing /api/reacher/* block
// (around line 910, after the /api/command route).
//
// Dependencies already in scope in dashboard-server.js:
//   app     — Express instance
//   axios   — axios instance (or use the ghl axios instance for GHL calls)
//   CFG     — { railwayUrl }
//   cached  — cached(key, ttlMs, fn) helper
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /api/affiliate/blast ─────────────────────────────────────────────────
// Body: { message: string, audience: string, channel: string, shopId?: string }
// Fires a creator blast message via the chosen channel.
//
// STUB: Returns a synthetic success response until the real send integration
// (Reacher DM / Email / SMS) is wired up on the Railway server.
app.post('/api/affiliate/blast', async (req, res) => {
  const { message, audience, channel, shopId } = req.body || {};

  // Basic validation
  if (!message || !audience || !channel) {
    return res.status(400).json({ ok: false, error: 'message, audience, and channel are required' });
  }

  // STUB: In production, forward to Railway:
  //   const { data } = await axios.post(`${CFG.railwayUrl}/affiliate/blast`, req.body, { timeout: 15_000 });
  //   return res.json(data);

  try {
    // Derive a plausible send count from S.reacher state (not accessible server-side here,
    // so we return a placeholder count). Replace with real count from Reacher API.
    const stubSentCount = audience === 'all_funnel' ? 42
      : audience === 'active_posters' ? 18
      : audience === 'non_starters'   ? 11
      : audience === 'sample_approved'? 24
      : 10;

    // Log for observability
    console.log(`[affiliate/blast] audience=${audience} channel=${channel} shopId=${shopId||'all'} msg="${message.slice(0,60)}"`);

    res.json({ ok: true, sent: stubSentCount, audience, channel });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/affiliate/promotion ────────────────────────────────────────────
// Body: { shopId: string, commission: number, type: string, duration: number }
// Creates a new promotion for a shop.
//
// STUB: Returns a synthetic promoId until Reacher / TikTok Shop promotions API
// integration is built on the Railway server.
app.post('/api/affiliate/promotion', async (req, res) => {
  const { shopId, commission, type, duration } = req.body || {};

  // Basic validation
  if (!shopId) {
    return res.status(400).json({ ok: false, error: 'shopId is required' });
  }
  if (commission == null || commission < 5 || commission > 40) {
    return res.status(400).json({ ok: false, error: 'commission must be between 5 and 40' });
  }
  if (!type) {
    return res.status(400).json({ ok: false, error: 'type is required' });
  }

  // STUB: In production, forward to Railway:
  //   const { data } = await axios.post(`${CFG.railwayUrl}/affiliate/shops/${shopId}/promotions`, {
  //     commission, type, duration
  //   }, { timeout: 15_000 });
  //   return res.json(data);

  try {
    const promoId = 'promo_' + Date.now();

    console.log(`[affiliate/promotion] shop=${shopId} commission=${commission}% type=${type} duration=${duration}d → ${promoId}`);

    res.json({
      ok:      true,
      promoId,
      shopId,
      commission,
      type,
      duration,
      createdAt: new Date().toISOString(),
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/affiliate/promotions/:shopId ─────────────────────────────────────
// Returns active promotions for a given shop.
//
// STUB: Returns an empty promotions array until Reacher promotions API
// is wired up. The front-end manage panel handles the empty state gracefully.
app.get('/api/affiliate/promotions/:shopId', async (req, res) => {
  const { shopId } = req.params;

  // STUB: In production, forward to Railway:
  //   const data = await cached(`affiliate_promos_${shopId}`, 60_000, async () => {
  //     const { data } = await axios.get(`${CFG.railwayUrl}/affiliate/shops/${shopId}/promotions`, { timeout: 15_000 });
  //     return data;
  //   });
  //   return res.json(data);

  try {
    console.log(`[affiliate/promotions] fetching promotions for shop=${shopId}`);

    // STUB: empty list — replace with real fetch
    res.json({ ok: true, shopId, promotions: [] });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ─── Shop Ops Agent routes ───────────────────────────────────────────────────
// ─── Shop Ops Agent — Express routes ─────────────────────────────────────────
// Paste these app.get / app.post blocks into dashboard-server.js
// alongside the existing Reacher routes (after line ~910).

// GET /api/shopops/promotions — returns stub promotion list
app.get('/api/shopops/promotions', async (req, res) => {
  try {
    // STUB — replace with real DB/cache lookup when persistence is wired up
    res.json({ promotions: [] });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// POST /api/shopops/promotion — launch a new promotion
// Body: { shopId, type, commission, duration, tier }
app.post('/api/shopops/promotion', async (req, res) => {
  try {
    const { shopId, type, commission, duration, tier } = req.body;

    // Basic validation
    if (!shopId)                               return res.status(400).json({ error: 'shopId is required' });
    if (!type)                                 return res.status(400).json({ error: 'type is required' });
    if (!commission || commission < 5 || commission > 40)
                                               return res.status(400).json({ error: 'commission must be 5–40' });
    if (!duration)                             return res.status(400).json({ error: 'duration is required' });

    // STUB — replace with real Reacher API call or DB write when ready
    // Example future call:
    //   const { data } = await axios.post(`${CFG.railwayUrl}/affiliate/shops/${shopId}/promotions`, req.body);
    //   res.json({ ok: true, promotion: data });

    res.json({ ok: true, promotionId: `promo_stub_${Date.now()}` });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// POST /api/shopops/outreach/:shopId — trigger outreach for a shop's creators
app.post('/api/shopops/outreach/:shopId', async (req, res) => {
  try {
    const { shopId } = req.params;
    if (!shopId) return res.status(400).json({ error: 'shopId is required' });

    // STUB — replace with real Reacher outreach call when ready
    // Example future call:
    //   const { data } = await axios.post(
    //     `${CFG.railwayUrl}/affiliate/shops/${shopId}/outreach`,
    //     req.body, { timeout: 15_000 }
    //   );
    //   res.json({ ok: true, queued: data.queued });

    res.json({ ok: true, queued: 12 });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// POST /api/shopops/reengage — re-engage all stuck creators agency-wide
// Stuck = currently in 'content-pending' or 'content-unfulfilled' funnel stage
app.post('/api/shopops/reengage', async (req, res) => {
  try {
    // STUB — replace with real re-engagement logic when ready
    // Example future call:
    //   const { data } = await axios.post(
    //     `${CFG.railwayUrl}/affiliate/agency/reengage`,
    //     { stages: ['content-pending', 'content-unfulfilled'] }, { timeout: 20_000 }
    //   );
    //   res.json({ ok: true, count: data.count });

    res.json({ ok: true, count: 8 });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});


// ─── Paid Media Agent routes ─────────────────────────────────────────────────
// ─── Paid Media Agent — routes.js ────────────────────────────────────────────
//
// Paste these routes into dashboard-server.js (after the Arcads block works well
// as a reference). The cached() helper and axios are already available there.
//
// Env vars required:
//   TIKTOK_ADS_ACCESS_TOKEN   — long-lived access token from TikTok Marketing API
//   TIKTOK_ADS_ADVERTISER_ID  — your TikTok advertiser account ID
//
// TikTok Marketing API v1.3
//   Base URL : https://business-api.tiktok.com/open_api/v1.3
//   Auth     : header "Access-Token: <token>" (no Bearer prefix)
//   All GETs return { code, message, data: { list, page_info } }
//
// ─────────────────────────────────────────────────────────────────────────────

const TIKTOK_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

// ── Shared TikTok GET helper ──────────────────────────────────────────────────
async function ttGet(path, params = {}) {
  const token = process.env.TIKTOK_ADS_ACCESS_TOKEN;
  const { data: body } = await axios.get(`${TIKTOK_BASE}${path}`, {
    headers: { 'Access-Token': token },
    params:  {
      advertiser_id: process.env.TIKTOK_ADS_ADVERTISER_ID,
      ...params,
    },
  });
  if (body.code !== 0) throw new Error(`TikTok API error ${body.code}: ${body.message}`);
  return body.data;
}

// ── Shared TikTok POST helper ─────────────────────────────────────────────────
async function ttPost(path, payload = {}) {
  const token = process.env.TIKTOK_ADS_ACCESS_TOKEN;
  const { data: body } = await axios.post(`${TIKTOK_BASE}${path}`, payload, {
    headers: {
      'Access-Token':  token,
      'Content-Type': 'application/json',
    },
  });
  if (body.code !== 0) throw new Error(`TikTok API error ${body.code}: ${body.message}`);
  return body.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/paidmedia/tiktok/summary
//
// Combines campaign list + integrated report metrics into a single response.
// Returns:
// {
//   connected: true,
//   campaigns: [{ id, name, status, budget, spend, impressions, clicks, ctr, cpc }],
//   totals:    { spend, impressions, clicks, ctr, cpc, conversions, roas },
//   topAds:    [{ id, name, spend, impressions, ctr }],
//   monthlyBudget: <sum of daily budgets * days in month>,
// }
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/paidmedia/tiktok/summary', async (req, res) => {
  try {
    if (!process.env.TIKTOK_ADS_ACCESS_TOKEN) {
      return res.json({ connected: false, error: 'Add TIKTOK_ADS_ACCESS_TOKEN and TIKTOK_ADS_ADVERTISER_ID to .env' });
    }

    const data = await cached('tiktok_summary', 300_000, async () => {

      // ── 1. Fetch campaign list ──────────────────────────────────────────────
      const campData = await ttGet('/campaign/get/', {
        page:      1,
        page_size: 100,
        fields:    JSON.stringify([
          'campaign_id', 'campaign_name', 'status',
          'budget', 'budget_mode', 'operation_status',
        ]),
      });
      const rawCampaigns = campData.list || [];

      // ── 2. Fetch integrated report (last 30 days) ───────────────────────────
      const today = new Date();
      const end   = today.toISOString().slice(0, 10);
      const start = new Date(today);
      start.setDate(start.getDate() - 30);
      const startDate = start.toISOString().slice(0, 10);

      const reportData = await ttGet('/report/integrated/get/', {
        report_type:  'BASIC',
        data_level:   'AUCTION_CAMPAIGN',
        dimensions:   JSON.stringify(['campaign_id']),
        metrics:      JSON.stringify([
          'spend', 'impressions', 'clicks', 'ctr', 'cpc',
          'conversion', 'total_purchase_value',
        ]),
        start_date:   startDate,
        end_date:     end,
        page_size:    100,
      });
      const reportRows = reportData.list || [];

      // Build a lookup: campaign_id → metrics
      const metricsMap = {};
      for (const row of reportRows) {
        const id = row.dimensions?.campaign_id;
        if (id) metricsMap[id] = row.metrics || {};
      }

      // ── 3. Fetch ad-level report for top creatives ─────────────────────────
      let topAds = [];
      try {
        const adReport = await ttGet('/report/integrated/get/', {
          report_type:  'BASIC',
          data_level:   'AUCTION_AD',
          dimensions:   JSON.stringify(['ad_id']),
          metrics:      JSON.stringify(['ad_name', 'spend', 'impressions', 'ctr']),
          start_date:   startDate,
          end_date:     end,
          page_size:    50,
          order_field:  'spend',
          order_type:   'DESC',
        });
        topAds = (adReport.list || []).slice(0, 10).map(row => ({
          id:          row.dimensions?.ad_id,
          name:        row.metrics?.ad_name || 'Unnamed Ad',
          spend:       parseFloat(row.metrics?.spend       || 0),
          impressions: parseInt(row.metrics?.impressions   || 0, 10),
          ctr:         parseFloat(row.metrics?.ctr         || 0),
        }));
      } catch (_) {
        // Non-fatal — top creative data is optional
      }

      // ── 4. Merge campaign list + metrics ───────────────────────────────────
      const campaigns = rawCampaigns.map(c => {
        const id = String(c.campaign_id);
        const m  = metricsMap[id] || {};
        return {
          id,
          name:        c.campaign_name,
          status:      c.operation_status || c.status,
          budget:      parseFloat(c.budget || 0),
          spend:       parseFloat(m.spend       || 0),
          impressions: parseInt(m.impressions   || 0, 10),
          clicks:      parseInt(m.clicks        || 0, 10),
          ctr:         parseFloat(m.ctr         || 0),
          cpc:         parseFloat(m.cpc         || 0),
          conversions: parseInt(m.conversion    || 0, 10),
          revenue:     parseFloat(m.total_purchase_value || 0),
        };
      });

      // ── 5. Aggregate totals ────────────────────────────────────────────────
      const totals = campaigns.reduce(
        (acc, c) => {
          acc.spend       += c.spend;
          acc.impressions += c.impressions;
          acc.clicks      += c.clicks;
          acc.conversions += c.conversions;
          acc.revenue     += c.revenue;
          return acc;
        },
        { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 }
      );
      totals.ctr  = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
      totals.cpc  = totals.clicks > 0      ? totals.spend / totals.clicks               : 0;
      totals.roas = totals.spend > 0       ? totals.revenue / totals.spend              : null;

      // ── 6. Estimated monthly budget (sum of daily budgets × days in month) ─
      const now           = new Date();
      const daysInMonth   = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const activeBudgets = campaigns
        .filter(c => c.status === 'ENABLE' || c.status === 'active')
        .reduce((s, c) => s + (c.budget || 0), 0);
      const monthlyBudget = activeBudgets * daysInMonth;

      return { connected: true, campaigns, totals, topAds, monthlyBudget };
    });

    res.json(data);
  } catch (e) {
    res.status(500).json({ connected: false, error: e.response?.data || e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/paidmedia/tiktok/report?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
//
// Time-series report — account-level daily metrics for charting.
// Returns: { connected, rows: [{ date, spend, impressions, clicks, ctr, cpc }] }
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/paidmedia/tiktok/report', async (req, res) => {
  try {
    if (!process.env.TIKTOK_ADS_ACCESS_TOKEN) {
      return res.json({ connected: false, error: 'Add TIKTOK_ADS_ACCESS_TOKEN to .env' });
    }

    const { start_date, end_date } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date and end_date are required' });
    }

    const cacheKey = `tiktok_report_${start_date}_${end_date}`;
    const data = await cached(cacheKey, 300_000, async () => {
      const reportData = await ttGet('/report/integrated/get/', {
        report_type:  'BASIC',
        data_level:   'AUCTION_ADVERTISER',
        dimensions:   JSON.stringify(['stat_time_day']),
        metrics:      JSON.stringify([
          'spend', 'impressions', 'clicks', 'ctr', 'cpc', 'conversion',
        ]),
        start_date,
        end_date,
        page_size: 100,
        order_field: 'stat_time_day',
        order_type:  'ASC',
      });

      const rows = (reportData.list || []).map(row => ({
        date:        row.dimensions?.stat_time_day?.slice(0, 10),
        spend:       parseFloat(row.metrics?.spend       || 0),
        impressions: parseInt(row.metrics?.impressions   || 0, 10),
        clicks:      parseInt(row.metrics?.clicks        || 0, 10),
        ctr:         parseFloat(row.metrics?.ctr         || 0),
        cpc:         parseFloat(row.metrics?.cpc         || 0),
        conversions: parseInt(row.metrics?.conversion    || 0, 10),
      }));

      return { connected: true, rows, start_date, end_date };
    });

    res.json(data);
  } catch (e) {
    res.status(500).json({ connected: false, error: e.response?.data || e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/paidmedia/tiktok/campaign/:id/status
//
// Body: { status: 'ENABLE' | 'DISABLE' }
// Calls TikTok /campaign/status/update/ to pause or resume a campaign.
// Returns: { ok: true } or { ok: false, error }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/paidmedia/tiktok/campaign/:id/status', async (req, res) => {
  try {
    if (!process.env.TIKTOK_ADS_ACCESS_TOKEN) {
      return res.json({ ok: false, error: 'Add TIKTOK_ADS_ACCESS_TOKEN to .env' });
    }

    const { id }     = req.params;
    const { status } = req.body;

    if (!['ENABLE', 'DISABLE'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'status must be ENABLE or DISABLE' });
    }

    await ttPost('/campaign/status/update/', {
      advertiser_id: process.env.TIKTOK_ADS_ADVERTISER_ID,
      campaign_ids:  [id],
      opt_status:    status,
    });

    // Bust the summary cache so next load reflects the change
    cache.delete('tiktok_summary');

    res.json({ ok: true, campaign_id: id, status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.response?.data || e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/paidmedia/tiktok/pause-all
//
// Pauses all currently ENABLE campaigns for this advertiser.
// STUB — implement after confirming credentials work.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/paidmedia/tiktok/pause-all', async (req, res) => {
  try {
    if (!process.env.TIKTOK_ADS_ACCESS_TOKEN) {
      return res.json({ ok: false, error: 'Add TIKTOK_ADS_ACCESS_TOKEN to .env' });
    }

    // STUB: In production, fetch all active campaign IDs then batch-disable them.
    // TikTok allows up to 20 campaign_ids per /campaign/status/update/ call.
    //
    // Example implementation:
    //   const campData = await ttGet('/campaign/get/', { page_size: 100 });
    //   const activeIds = campData.list
    //     .filter(c => c.operation_status === 'ENABLE')
    //     .map(c => String(c.campaign_id));
    //   // Batch into chunks of 20
    //   for (let i = 0; i < activeIds.length; i += 20) {
    //     const chunk = activeIds.slice(i, i + 20);
    //     await ttPost('/campaign/status/update/', {
    //       advertiser_id: process.env.TIKTOK_ADS_ADVERTISER_ID,
    //       campaign_ids:  chunk,
    //       opt_status:    'DISABLE',
    //     });
    //   }
    //   cache.delete('tiktok_summary');
    //   return res.json({ ok: true, paused: activeIds.length });

    res.json({
      ok:      true,
      stub:    true,
      message: 'Pause All is a stub. Uncomment the implementation in routes.js when ready.',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.response?.data || e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/paidmedia/meta/summary
//
// STUB — Meta Ads API integration is not yet implemented.
// Requires: META_ADS_ACCESS_TOKEN, META_ADS_ACCOUNT_ID
// Docs: https://developers.facebook.com/docs/marketing-api/insights
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/paidmedia/meta/summary', async (req, res) => {
  // STUB
  res.json({
    connected: false,
    error:     'Meta Ads not yet connected. Add META_ADS_ACCESS_TOKEN and META_ADS_ACCOUNT_ID to .env.',
    stub:      true,
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/shortvideo/loop/run
// Autonomous weekly content loop: analyze → ideate → script → schedule
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/shortvideo/loop/run', async (req, res) => {
  const { postCount = 5 } = req.body || {};
  const LOOP_LOG_FILE = path.join(__dirname, 'loop-history.json');

  // Step 1: pull recent video performance from Arcads
  let analyzed = 0, topVideos = [];
  try {
    const arcadsKey = process.env.ARCADS_API_KEY;
    if (arcadsKey) {
      const r = await axios.get('https://external-api.arcads.ai/api/v1/videos', {
        auth: { username: arcadsKey, password: '' },
        params: { limit: 50 }
      });
      const videos = r.data?.videos || r.data?.data || [];
      const cutoff = Date.now() - 7 * 86_400_000;
      topVideos = videos
        .filter(v => new Date(v.createdAt || v.created_at || 0).getTime() > cutoff)
        .sort((a, b) => (b.views || 0) - (a.views || 0))
        .slice(0, 10);
      analyzed = topVideos.length;
    }
  } catch (e) { console.error('Loop step 1:', e.message); }

  // Step 2+3: call Claude API — cult-ideator + cult-script-writer
  let ideas = 0, scripts = 0, ideaText = '', scriptText = '';
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const perfContext = topVideos.length
        ? topVideos.map((v,i) => `${i+1}. "${v.name||v.scriptName||'Untitled'}" — ${v.views||0} views`).join('\n')
        : 'No recent video data. Generate fresh TikTok shop content ideas.';

      const ideaMsg = await client.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 1024,
        messages: [{ role: 'user', content:
          `You are the Cult Ideator. Based on this week's performance:\n\n${perfContext}\n\nGenerate ${postCount} TikTok video ideas. Each: Hook (3s) · Concept (1 sentence) · Format. Numbered list.`
        }]
      });
      ideaText = ideaMsg.content[0]?.text || '';
      ideas = (ideaText.match(/^\d+\./gm) || []).length || postCount;

      const scriptMsg = await client.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 2048,
        messages: [{ role: 'user', content:
          `You are the Cult Script Writer. Write a TikTok script (under 60s) for each idea:\n\n${ideaText}\n\nEach script: Hook · Body (3-5 beats) · CTA. Under 150 words each.`
        }]
      });
      scriptText = scriptMsg.content[0]?.text || '';
      scripts = (scriptText.match(/^\d+\./gm) || []).length || ideas;
    } else {
      ideas = postCount; scripts = postCount; // stub
    }
  } catch (e) { console.error('Loop step 2:', e.message); ideas = postCount; scripts = postCount; }

  // Step 4: create Buffer ideas with generated scripts
  // Channel IDs (from Buffer account 69d6ddee1fcceb5bb1faa168 — "My Organization"):
  //   TikTok  tommylynch_     : 69d7f3cd031bfa423ce82b4a
  //   Instagram tommy.lynch_  : 69d6de31031bfa423ce369cf
  //   Instagram cultcontent.cc: 69d70072031bfa423ce3fc25
  let scheduled = 0;
  const bufferToken = process.env.BUFFER_ACCESS_TOKEN;
  if (bufferToken && scriptText) {
    // Parse individual scripts — split on lines starting with a number+period
    // e.g. "1. Title\n..." or "**1.**" patterns Claude commonly uses
    const scriptBlocks = scriptText
      .split(/\n(?=\*{0,2}\d+[\.\)]\*{0,2}\s)/)
      .map(s => s.trim())
      .filter(s => s.length > 20);
    const BUFFER_GQL = 'https://api.buffer.com/graphql';
    const targetChannelId = process.env.BUFFER_TIKTOK_CHANNEL_ID || '69d7f3cd031bfa423ce82b4a';

    for (const block of scriptBlocks.slice(0, postCount)) {
      try {
        // Extract title from first line (e.g. "1. Hook Title")
        const firstLine = block.split('\n')[0].replace(/^\d+\.\s*/, '').trim();
        const body      = block.trim();

        // Create as a Buffer idea so Tommy can review before scheduling
        await axios.post(BUFFER_GQL, {
          query: `mutation CreateIdea($input: CreateIdeaInput!) {
            createIdea(input: $input) {
              ... on Idea { id }
              ... on IdeaResponse { idea { id } }
              ... on InvalidInputError { message }
              ... on UnexpectedError { message }
              ... on LimitReachedError { message }
            }
          }`,
          variables: {
            input: {
              organizationId: '69d6ddee1fcceb5bb1faa168',
              content: {
                title: firstLine.slice(0, 100),
                text:  body.slice(0, 2000),
                services: ['tiktok']
              }
            }
          }
        }, {
          headers: {
            Authorization: `Bearer ${bufferToken}`,
            'Content-Type': 'application/json'
          }
        });
        scheduled++;
      } catch (e) {
        console.error('Loop Buffer idea error:', e.response?.data || e.message);
      }
    }
  }

  // Persist run log
  try {
    let history = fs.existsSync(LOOP_LOG_FILE) ? JSON.parse(fs.readFileSync(LOOP_LOG_FILE, 'utf8')) : [];
    history.push({ at: new Date().toISOString(), analyzed, ideas, scripts, scheduled });
    fs.writeFileSync(LOOP_LOG_FILE, JSON.stringify(history.slice(-100)));
  } catch (_) {}

  res.json({ ok: true, analyzed, ideas, scripts, scheduled });
});

app.get('/api/shortvideo/loop/history', (req, res) => {
  const LOOP_LOG_FILE = path.join(__dirname, 'loop-history.json');
  try {
    if (fs.existsSync(LOOP_LOG_FILE))
      return res.json({ ok: true, history: JSON.parse(fs.readFileSync(LOOP_LOG_FILE, 'utf8')) });
  } catch (_) {}
  res.json({ ok: true, history: [] });
});

// ─── Shopify Auto-Import ──────────────────────────────────────────────────────

app.post('/api/brands/shopify-import', async (req, res) => {
  let { storeUrl } = req.body || {};
  if (!storeUrl) return res.json({ ok: false, error: 'storeUrl is required' });

  // Normalise URL → just the domain
  storeUrl = storeUrl.replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0];
  const base = `https://${storeUrl}`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const apifyToken = process.env.APIFY_API_KEY;
    let rawData = { products: [], collections: [], homepageMarkdown: '', aboutMarkdown: '' };

    // 1. Products — Shopify public JSON API (free, no credits)
    try {
      const { data } = await axios.get(`${base}/products.json?limit=50`, { timeout: 10_000 });
      rawData.products = (data.products || []).map(p => ({
        title:       p.title,
        type:        p.product_type,
        tags:        p.tags?.slice(0, 8) || [],
        description: p.body_html?.replace(/<[^>]+>/g, '').slice(0, 300) || '',
        minPrice:    Math.min(...(p.variants || []).map(v => parseFloat(v.price) || 0)),
        maxPrice:    Math.max(...(p.variants || []).map(v => parseFloat(v.price) || 0)),
      }));
    } catch(e) { console.error('Shopify products fetch failed:', e.message); }

    // 2. Collections — content pillar seeds
    try {
      const { data } = await axios.get(`${base}/collections.json?limit=50`, { timeout: 10_000 });
      rawData.collections = (data.collections || [])
        .map(c => c.title)
        .filter(t => !t.match(/^\d+$|sale|discount|aff|outlet|secret/i))
        .slice(0, 20);
    } catch(e) { console.error('Shopify collections fetch failed:', e.message); }

    // 3. Homepage + About page via Apify rag-web-browser
    if (apifyToken) {
      const pagesToFetch = [base, `${base}/pages/about`];
      try {
        const { data: ragData } = await axios.post(
          `https://api.apify.com/v2/acts/apify~rag-web-browser/run-sync-get-dataset-items?token=${apifyToken}&timeout=30&memory=256`,
          { query: pagesToFetch.join('\n'), maxResults: 2 },
          { timeout: 60_000 }
        );
        (ragData || []).forEach(r => {
          const md = r.markdown || '';
          if (r.url?.includes('/about')) rawData.aboutMarkdown = md.slice(0, 3000);
          else rawData.homepageMarkdown = md.slice(0, 3000);
        });
      } catch(e) { console.error('Apify rag-web-browser failed:', e.message); }
    }

    // 4. Build summary for Claude
    const priceRange = rawData.products.length
      ? `$${Math.min(...rawData.products.map(p => p.minPrice)).toFixed(0)}–$${Math.max(...rawData.products.map(p => p.maxPrice)).toFixed(0)}`
      : 'unknown';

    const productList = rawData.products.slice(0, 20)
      .map(p => `- ${p.title}${p.type ? ` (${p.type})` : ''} — $${p.minPrice.toFixed(0)}${p.description ? `: ${p.description.slice(0,120)}` : ''}`)
      .join('\n');

    const collectionList = rawData.collections.join(', ');

    const prompt = `You are a brand strategist. Based on the Shopify store data below, generate a structured brand profile for a content agency that will be writing TikTok scripts for this brand.

Store URL: ${storeUrl}
Price range: ${priceRange}

Products (top 20):
${productList || 'No product data available'}

Collections: ${collectionList || 'None'}

Homepage copy:
${rawData.homepageMarkdown || 'Not available'}

About page:
${rawData.aboutMarkdown || 'Not available'}

Return JSON only — fill every field as specifically as possible from the actual data. Do not invent claims not supported by the data:
{
  "name": "brand name",
  "industry": "one-line industry/niche description",
  "products": "summary of what they sell, key products, and price range",
  "audience": "who buys this — demographics, interests, what problem it solves",
  "voice": "brand voice and tone based on their actual copy — 2-3 sentences describing how they write and speak",
  "contentPillars": "3–5 content topics ideal for TikTok, comma-separated",
  "proofPoints": "any real proof points visible in the data (reviews mentioned, awards, certifications, specific claims) — leave blank if none found",
  "cta": "most logical CTA for TikTok content (e.g. shop the link in bio, TikTok Shop below)",
  "avoidTopics": "topics or language that would clash with the brand based on their positioning",
  "extraContext": "anything else a TikTok script writer needs to know about this brand — key differentiators, origin story if mentioned, notable features"
}`;

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = msg.content[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const profile = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    res.json({
      ok: true,
      profile,
      meta: {
        productsFound:    rawData.products.length,
        collectionsFound: rawData.collections.length,
        homepageFetched:  !!rawData.homepageMarkdown,
        aboutFetched:     !!rawData.aboutMarkdown,
      }
    });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Growth Partners — Task Persistence ───────────────────────────────────────
const GP_FILE = path.join(DATA_DIR, 'growth-partners.json');

function loadGP() {
  try { return JSON.parse(fs.readFileSync(GP_FILE, 'utf8')); }
  catch(_) { return { partners: {} }; }
}
function saveGP(data) {
  fs.writeFileSync(GP_FILE, JSON.stringify(data, null, 2));
}

// GET /api/growth-partners/:clientId — get task state for one client
app.get('/api/growth-partners/:clientId', (req, res) => {
  const data = loadGP();
  const partner = data.partners[req.params.clientId] || { tasks: {} };
  res.json(partner);
});

// PUT /api/growth-partners/:clientId/tasks/:taskId — toggle a task
app.put('/api/growth-partners/:clientId/tasks/:taskId', (req, res) => {
  const { clientId, taskId } = req.params;
  const { done, doneAt } = req.body || {};
  const data = loadGP();
  if (!data.partners[clientId]) data.partners[clientId] = { tasks: {}, createdAt: new Date().toISOString() };
  data.partners[clientId].tasks[taskId] = { done: !!done, doneAt: doneAt || null };
  saveGP(data);
  res.json({ ok: true });
});

// POST /api/growth-partners/add-prospect — create GHL contact + opportunity from Shopify scrape
app.post('/api/growth-partners/add-prospect', async (req, res) => {
  const { name, email, company, profile } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  try {
    // 1. Create contact
    const cRes = await ghl.post('/contacts/', {
      locationId: CFG.locationId,
      firstName: name.split(' ')[0] || name,
      lastName:  name.split(' ').slice(1).join(' ') || '',
      name,
      email: email || undefined,
      companyName: company || profile?.name || undefined,
      tags: ['growth-partner-prospect'],
    });
    const contactId = cRes.data?.contact?.id;
    if (!contactId) throw new Error('Contact creation failed: ' + JSON.stringify(cRes.data));

    // 2. Create opportunity in Lead stage
    const oRes = await ghl.post('/opportunities/', {
      locationId:      CFG.locationId,
      name,
      pipelineId:      'W5PxjulbNVh52Gqlkmzm',
      pipelineStageId: '93bc4029-7dbd-4598-8862-cb7ac7784016', // Lead
      contactId,
      status: 'open',
    });
    const oppId = oRes.data?.opportunity?.id;

    // Bust pipeline cache
    cache.delete('pipeline:growth-partners');

    res.json({ ok: true, contactId, oppId });
  } catch (err) {
    console.error('add-prospect:', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
  }
});

// ─── Client Brand Management ──────────────────────────────────────────────────
const BRANDS_FILE = path.join(DATA_DIR, 'brands.json');

function loadBrands() {
  try { return JSON.parse(fs.readFileSync(BRANDS_FILE, 'utf8')); }
  catch(_) { return { clients: [] }; }
}
function saveBrands(data) {
  fs.writeFileSync(BRANDS_FILE, JSON.stringify(data, null, 2));
}

// GET /api/brands — list all client brands
app.get('/api/brands', (req, res) => {
  res.json(loadBrands());
});

// POST /api/brands — create a new client brand
app.post('/api/brands', (req, res) => {
  const data = loadBrands();
  const brand = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    createdAt: new Date().toISOString(),
    ...req.body,
  };
  data.clients.push(brand);
  saveBrands(data);
  res.json({ ok: true, brand });
});

// PUT /api/brands/:id — update a client brand
app.put('/api/brands/:id', (req, res) => {
  const data = loadBrands();
  const idx = data.clients.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.json({ ok: false, error: 'Brand not found' });
  data.clients[idx] = { ...data.clients[idx], ...req.body, id: req.params.id };
  saveBrands(data);
  res.json({ ok: true, brand: data.clients[idx] });
});

// DELETE /api/brands/:id — delete a client brand
app.delete('/api/brands/:id', (req, res) => {
  const data = loadBrands();
  data.clients = data.clients.filter(b => b.id !== req.params.id);
  saveBrands(data);
  res.json({ ok: true });
});

// ─── Video Production Pipeline ────────────────────────────────────────────────

// Brand profiles — mirrors PROD_BRANDS in the frontend
const PROD_BRANDS = {
  cultcontent: {
    name: 'Cult Content',
    audience: 'E-commerce brand owners and TikTok Shop sellers who want to grow through affiliate marketing',
    niche: 'TikTok Shop affiliate program management, e-commerce growth strategies, creator outreach and partnerships',
    voice: 'Professional but direct. Data-driven and tactical. B2B tone — speak to business owners, not consumers. Every piece of content should position Cult Content as the authority on TikTok Shop growth.',
    contentPillars: ['TikTok Shop setup & optimization', 'Affiliate recruitment & management', 'Creator partnership strategies', 'E-commerce brand growth', 'Case studies & results'],
    avoidTopics: ['Personal lifestyle content', 'Overly casual or meme-heavy formats', 'Anything consumer-facing rather than B2B'],
    cta: 'Follow for more TikTok Shop growth strategies / Link in bio for a free affiliate audit',
    tiktokHandles: ['cultcontent.cc'],
  },
  tommy: {
    name: 'Tommy Lynch Personal Brand',
    audience: 'Aspiring creators, young entrepreneurs, and people who want to build online income through content and e-commerce',
    niche: 'Entrepreneurship, building brands online, the creator economy, TikTok Shop from a founder perspective, personal growth through business',
    voice: 'Authentic, first-person, aspirational. Show the journey — wins AND struggles. Speak like a peer, not a guru. Relatable but ambitious. More casual than Cult Content.',
    contentPillars: ['Behind-the-scenes of building Cult Content', 'Lessons from running a TikTok agency', 'Creator economy insights', 'Personal entrepreneurship journey', 'Mindset and productivity'],
    avoidTopics: ['Overly polished or corporate content', 'Generic hustle-porn advice', 'Anything that feels fake or scripted'],
    cta: 'Follow for the journey / DM me if you want to build on TikTok',
    tiktokHandles: ['tommylynch_'],
  },
};

// Returns a compact brand context string for Claude prompts
// Works for both built-in brands (PROD_BRANDS) and client brands from brands.json
function getBrandContext(brandId) {
  // Check built-in brands first
  const builtin = PROD_BRANDS[brandId];
  if (builtin) {
    return `Brand: ${builtin.name}
Audience: ${builtin.audience}
Niche: ${builtin.niche}
Voice & tone: ${builtin.voice}
Content pillars: ${builtin.contentPillars.join(', ')}
Avoid: ${builtin.avoidTopics.join(', ')}
CTA style: ${builtin.cta}`;
  }
  // Check client brands from file
  const clients = loadBrands().clients;
  const client = clients.find(b => b.id === brandId);
  if (client) {
    const lines = [
      `Brand: ${client.name}`,
      client.industry        ? `Industry: ${client.industry}` : null,
      client.products        ? `Products/Services: ${client.products}` : null,
      client.audience        ? `Target audience: ${client.audience}` : null,
      client.niche           ? `Niche: ${client.niche}` : null,
      client.voice           ? `Voice & tone: ${client.voice}` : null,
      client.contentPillars  ? `Content pillars: ${client.contentPillars}` : null,
      client.proofPoints     ? `Real proof points they can use: ${client.proofPoints}` : null,
      client.avoidTopics     ? `Avoid: ${client.avoidTopics}` : null,
      client.cta             ? `CTA style: ${client.cta}` : null,
      client.extraContext    ? `Additional context: ${client.extraContext}` : null,
    ].filter(Boolean);
    return lines.join('\n');
  }
  return 'Brand: Unknown — generate content appropriate for a TikTok Shop seller.';
}

// POST /api/production/analyze
// Analyzes own or competitor videos and returns insights + hooks
app.post('/api/production/analyze', async (req, res) => {
  const { source = 'own', handle, days = 30, brand, compVideoPaste = '' } = req.body || {};
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const apifyToken = process.env.APIFY_API_KEY;
    let videoContext = '';
    let tiktokVideos = [];

    // ── Helper: fetch recent TikTok videos for a handle via Apify ──────────
    const fetchTikTokVideos = async (ttHandle, maxVideos = 20) => {
      if (!apifyToken) return [];
      const cleanHandle = ttHandle.replace(/^@/, '');
      const profileUrl = `https://www.tiktok.com/@${cleanHandle}`;
      try {
        const { data } = await axios.post(
          `https://api.apify.com/v2/acts/clockworks~tiktok-profile-scraper/run-sync-get-dataset-items?token=${apifyToken}&timeout=90&memory=512`,
          { profiles: [profileUrl], resultsType: 'videos', maxVideosPerQuery: maxVideos },
          { timeout: 120_000 }
        );
        // Filter out error entries
        const videos = (data || []).filter(v => !v.error);
        return videos.map(v => ({
          id:        v.id,
          caption:   v.text || '',
          views:     v.playCount || 0,
          likes:     v.diggCount || 0,
          comments:  v.commentCount || 0,
          shares:    v.shareCount || 0,
          bookmarks: v.collectCount || 0,
          created:   v.createTime ? new Date(v.createTime * 1000).toISOString().split('T')[0] : '',
          duration:  v.videoMeta?.duration || 0,
          url:       `https://www.tiktok.com/@${cleanHandle}/video/${v.id}`,
        }));
      } catch(e) {
        console.error('TikTok Apify video fetch error:', e.response?.data || e.message);
        return [];
      }
    };

    if (source === 'own') {
      // Resolve which TikTok handles to scrape based on the selected brand
      let handles = [];
      if (brand && PROD_BRANDS[brand]?.tiktokHandles) {
        // Built-in brand (cultcontent / tommy)
        handles = PROD_BRANDS[brand].tiktokHandles;
      } else if (brand) {
        // Client brand — use tiktokHandle from brands.json
        const clientBrand = loadBrands().clients.find(b => b.id === brand);
        if (clientBrand?.tiktokHandle) handles = [clientBrand.tiktokHandle];
      }
      // Fall back to env vars only if no brand-specific handles found
      if (!handles.length) {
        handles = [process.env.TIKTOK_HANDLE_PERSONAL, process.env.TIKTOK_HANDLE_BRAND].filter(Boolean);
      }

      // Fetch real TikTok video data for all handles in parallel
      const allResults = await Promise.all(handles.map(h => fetchTikTokVideos(h, 30)));
      tiktokVideos = allResults.flat();

      // Filter to the requested lookback window
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().split('T')[0];
      const recentVideos = tiktokVideos.filter(v => !v.created || v.created >= cutoff);
      const videosForAnalysis = recentVideos.length > 0 ? recentVideos : tiktokVideos;

      // Sort by views descending for Claude to see top performers first
      videosForAnalysis.sort((a, b) => b.views - a.views);

      if (videosForAnalysis.length > 0) {
        const topN = videosForAnalysis.slice(0, 20);
        const totalViews = topN.reduce((s, v) => s + v.views, 0);
        const avgViews = Math.round(totalViews / topN.length);
        const topVideo = topN[0];
        videoContext = `TikTok handles: @${handles.join(', @')}
Analysis window: last ${days} days
Total videos analysed: ${videosForAnalysis.length}
Average views per video: ${avgViews.toLocaleString()}
Top video: "${topVideo.caption.slice(0, 120)}" — ${topVideo.views.toLocaleString()} views, ${topVideo.likes.toLocaleString()} likes

Recent videos (sorted by views, top 20):
${topN.map((v, i) => `${i+1}. [${v.views.toLocaleString()} views | ${v.likes.toLocaleString()} likes | ${v.shares} shares | ${v.duration}s] "${v.caption.slice(0, 100)}"`).join('\n')}`;
      } else {
        videoContext = `TikTok handles: @${handles.join(', @')}. No video data returned from Apify. Generate strategic content ideas based on Cult Content's niche: helping e-commerce sellers build TikTok Shop brands and affiliate programs.`;
      }

      // Supplement with YouTube data
      try {
        const snap = loadSnaps();
        const ytSnaps = snap['youtube'] || {};
        const ytHandle = Object.keys(ytSnaps)[0];
        if (ytHandle) {
          const recent = (ytSnaps[ytHandle] || []).slice(-3);
          videoContext += `\n\nYouTube snapshots (last 3): ${JSON.stringify(recent)}`;
        }
      } catch(_) {}

    } else {
      // Competitor / inspiration mode
      const cleanHandle = (handle || '').replace(/^@/, '');
      let liveVideos = [];

      // Try Apify scrape (requires credits — will be empty if billing is needed)
      if (cleanHandle && apifyToken) {
        liveVideos = await fetchTikTokVideos(cleanHandle, 20);
      }

      if (liveVideos.length > 0) {
        // Live scraped data
        liveVideos.sort((a, b) => b.views - a.views);
        const avgViews = Math.round(liveVideos.reduce((s, v) => s + v.views, 0) / liveVideos.length);
        videoContext = `Competitor TikTok: @${cleanHandle} (live scraped data)
Total videos scraped: ${liveVideos.length}
Average views: ${avgViews.toLocaleString()}
Top video: "${liveVideos[0].caption.slice(0, 120)}" — ${liveVideos[0].views.toLocaleString()} views

Top 15 videos by views:
${liveVideos.slice(0, 15).map((v, i) => `${i+1}. [${v.views.toLocaleString()} views | ${v.likes.toLocaleString()} likes | ${v.duration}s] "${v.caption.slice(0, 100)}"`).join('\n')}`;
        tiktokVideos = liveVideos;

      } else if (compVideoPaste.trim()) {
        // Manual paste fallback — real captions the user copied from the competitor's profile
        const pastedCaptions = compVideoPaste.trim().split('\n').map(l => l.trim()).filter(Boolean);
        videoContext = `Competitor TikTok: @${cleanHandle || 'unknown'} (manually pasted captions — no live scrape)
The user copied these video captions directly from the competitor's TikTok profile:

${pastedCaptions.map((c, i) => `${i+1}. "${c}"`).join('\n')}

Analyse the patterns, hooks, topics, and formats visible in these captions. Infer what's working based on the language and framing used.`;

      } else {
        // No data at all — be honest, don't hallucinate
        videoContext = cleanHandle
          ? `Competitor TikTok handle: @${cleanHandle}. No live video data available (Apify credits needed) and no captions were pasted. Do NOT invent specific videos, stats, or results. Instead, provide general strategic recommendations for what typically works in this brand's niche.`
          : `No competitor handle or video data provided. Provide general strategic recommendations based on the brand profile.`;
      }
    }

    const brandContext = getBrandContext(brand);

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `You are a TikTok content strategist. Analyze the data below and identify what's actually working.

IMPORTANT: Only draw insights from real data provided. If the data source says "no live scrape" or "manually pasted", base insights strictly on what was given — do not invent engagement numbers, view counts, or claim specific videos performed well unless that data is explicitly in the input.

${brandContext}

Data:
${videoContext}

Return JSON only:
{
  "topFormats": ["format1", "format2", "format3"],
  "topHooks": ["hook1 — derived from real captions/patterns in the data", "hook2", "hook3", "hook4", "hook5"],
  "topTopics": ["topic1", "topic2", "topic3"],
  "insights": ["insight grounded in actual data provided", "insight 2", "insight 3"],
  "recommendation": "one specific, actionable sentence on what to make next — honest about what the data does and doesn't show"
}`
      }]
    });

    const text = msg.content[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    res.json({ ok: true, analysis, source, handle, videoCount: tiktokVideos.length });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /api/production/ideate
// Generates N video ideas from analysis results
app.post('/api/production/ideate', async (req, res) => {
  const { analysis, count = 3, context: userContext = '', brand } = req.body || {};
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const brandContext = getBrandContext(brand);

    const analysisBlock = analysis
      ? `Performance analysis:\n${JSON.stringify(analysis)}`
      : 'No performance analysis provided — generate ideas based purely on the brand profile below.';

    const contextBlock = userContext
      ? `\nAdditional direction from the creator:\n"${userContext}"\nPrioritise this direction above all else when choosing topics and angles.`
      : '';

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are a TikTok content strategist. Generate exactly ${count} video ideas for this brand. Every idea must fit the brand's voice, target audience, and content pillars.

${brandContext}

${analysisBlock}${contextBlock}

Return JSON only — an array of exactly ${count} ideas:
[
  {
    "title": "short video title written in brand voice",
    "hook": "exact first 3 seconds hook script in brand voice — no fabricated stats or results; use [X] as a placeholder if a number is needed",
    "concept": "1 sentence concept",
    "format": "e.g. Tutorial / Story / Listicle / POV / Day-in-life",
    "whyItWorks": "1 sentence reason it fits this brand and audience"
  }
]`
      }]
    });

    const text = msg.content[0]?.text || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const ideas = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    res.json({ ok: true, ideas: ideas.slice(0, count) });
  } catch(e) {
    res.json({ ok: false, error: e.message, ideas: [] });
  }
});

// POST /api/production/scripts
// Generates full scripts for an array of ideas
app.post('/api/production/scripts', async (req, res) => {
  const { ideas = [], brand } = req.body || {};
  if (!ideas.length) return res.json({ ok: false, error: 'No ideas provided', scripts: [] });

  const brandContext = getBrandContext(brand);

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const scripts = [];

    for (const idea of ideas) {
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Write a TikTok script (under 60 seconds) for this video idea. Every word must sound natural and match the brand voice — not corporate, not generic.

${brandContext}

Idea:
Title: ${idea.title}
Hook: ${idea.hook}
Concept: ${idea.concept}
Format: ${idea.format}

CRITICAL RULES — never break these:
- Never invent statistics, numbers, or results the creator hasn't verified (no "I helped 50 sellers", "audited 100 accounts", "$10k in 30 days" unless it's a known real fact)
- Never make claims the creator can't personally back up
- If the hook uses a number or result, use a placeholder like [X] so the creator can fill in their real figure
- Keep it honest and specific to what the creator actually knows and does

Return JSON only:
{
  "title": "${idea.title}",
  "hook": "exact hook words (3-5 sec) — written in brand voice, no fabricated stats",
  "intro": "intro beat (5-8 sec) — sets up the payoff",
  "body": ["beat 1 — specific point + what to say/show", "beat 2", "beat 3"],
  "cta": "call to action in brand voice (3-5 sec)",
  "totalDuration": "estimated seconds as a number",
  "bRollNotes": "brief practical filming notes"
}`
        }]
      });

      const text = msg.content[0]?.text || '{}';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const script = jsonMatch ? JSON.parse(jsonMatch[0]) : { title: idea.title, error: 'Parse failed' };
      scripts.push({ ...script, idea });
    }

    res.json({ ok: true, scripts });
  } catch(e) {
    res.json({ ok: false, error: e.message, scripts: [] });
  }
});

// POST /api/whisper-transcribe
// Transcribes voice memo using OpenAI Whisper REST API
// Expects multipart/form-data with field "audio"
app.post('/api/whisper-transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.json({ ok: false, error: 'File not received — check format (mp4/mov/webm)', text: '' });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    try { fs.unlinkSync(req.file.path); } catch(_) {}
    return res.json({ ok: false, error: 'OPENAI_API_KEY not configured on server', text: '' });
  }

  // Whisper hard limit is 25 MB
  const WHISPER_MAX = 25 * 1024 * 1024;
  if (req.file.size > WHISPER_MAX) {
    try { fs.unlinkSync(req.file.path); } catch(_) {}
    const mb = (req.file.size / 1024 / 1024).toFixed(1);
    return res.json({ ok: false, error: `File is ${mb} MB — Whisper limit is 25 MB. Trim the video or add transcript manually.`, text: '' });
  }

  try {
    const FormData = require('form-data');
    const fd = new FormData();
    fd.append('file', fs.createReadStream(req.file.path), {
      filename: req.file.originalname || 'video.mp4',
      contentType: req.file.mimetype || 'video/mp4',
    });
    fd.append('model', 'whisper-1');

    const whisperRes = await axios.post('https://api.openai.com/v1/audio/transcriptions', fd, {
      headers: { ...fd.getHeaders(), Authorization: `Bearer ${OPENAI_API_KEY}` },
      timeout: 120_000,
    });

    const text = whisperRes.data.text || '';
    console.log(`[whisper] transcribed "${req.file.originalname}" — ${text.length} chars`);
    res.json({ ok: true, text });
  } catch(e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error('[whisper] transcription error:', msg);
    res.json({ ok: false, error: msg, text: '' });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch(_) {}
  }
});

// POST /api/production/rewrite-scripts
// Rewrites existing scripts based on user feedback
// Body: { scripts: [...], feedback: string, brand: string }
app.post('/api/production/rewrite-scripts', async (req, res) => {
  const { scripts = [], feedback, brand } = req.body || {};
  if (!scripts.length) return res.json({ ok: false, error: 'No scripts provided', scripts: [] });
  if (!feedback?.trim()) return res.json({ ok: false, error: 'No feedback provided', scripts: [] });

  const brandContext = getBrandContext(brand);

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const rewritten = [];

    for (const script of scripts) {
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Rewrite the following TikTok script based on the feedback below. Keep the same general concept and structure — just apply the requested changes. Every word must still sound natural and match the brand voice.

${brandContext}

FEEDBACK FROM CREATOR:
${feedback}

CURRENT SCRIPT:
Title: ${script.title}
Hook: ${script.hook}
Intro: ${script.intro}
Body: ${(script.body || []).join(' | ')}
CTA: ${script.cta}
Filming notes: ${script.bRollNotes || 'none'}

CRITICAL RULES — never break these:
- Never invent statistics, numbers, or results the creator hasn't verified
- If a number is needed, use a placeholder like [X] so the creator can fill in their real figure
- Keep it honest, specific, and grounded in what the creator actually knows and does
- Apply the feedback faithfully — don't ignore or minimise what they asked for

Return JSON only (same structure as the original):
{
  "title": "string",
  "hook": "string",
  "intro": "string",
  "body": ["beat 1", "beat 2", "beat 3"],
  "cta": "string",
  "totalDuration": number,
  "bRollNotes": "string"
}`
        }]
      });

      const text = msg.content[0]?.text || '{}';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const rewrittenScript = jsonMatch ? JSON.parse(jsonMatch[0]) : { ...script, error: 'Parse failed' };
      rewritten.push({ ...rewrittenScript, idea: script.idea });
    }

    res.json({ ok: true, scripts: rewritten });
  } catch(e) {
    res.json({ ok: false, error: e.message, scripts: [] });
  }
});

// POST /api/production/calendar/push
// Pushes a batch of video entries to Lark Bitable content calendar
// Body: { entries: [{ title, script, hook, platform, publishDate, status, videoUrl? }] }
app.post('/api/production/calendar/push', async (req, res) => {
  const { entries = [], appToken, tableId } = req.body || {};
  if (!entries.length) return res.json({ ok: false, error: 'No entries to push' });

  const LARK_APP_ID     = process.env.LARK_APP_ID;
  const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
  if (!LARK_APP_ID || !LARK_APP_SECRET) {
    return res.json({ ok: false, error: 'LARK_APP_ID and LARK_APP_SECRET not set in .env' });
  }

  try {
    // Get tenant access token
    const { data: authData } = await axios.post('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET
    });
    const token = authData.tenant_access_token;
    if (!token) throw new Error('Failed to get Lark access token');

    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const results = [];

    for (const entry of entries) {
      const { data: recData } = await axios.post(
        `https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
        {
          fields: {
            'Title':        entry.title || '',
            'Hook':         entry.hook || '',
            'Script':       entry.scriptText || '',
            'Platform':     entry.platform || 'TikTok',
            'Publish Date': entry.publishDate ? new Date(entry.publishDate).getTime() : undefined,
            'Status':       entry.status || 'Scripted',
            'Video URL':    entry.videoUrl || '',
            'Notes':        entry.notes || '',
          }
        },
        { headers }
      );
      results.push({ title: entry.title, record_id: recData.data?.record?.record_id });
    }

    res.json({ ok: true, pushed: results.length, results });
  } catch(e) {
    console.error('Lark calendar push error:', e.response?.data || e.message);
    res.json({ ok: false, error: e.response?.data?.msg || e.message });
  }
});

// ─── TikTok OAuth + Display API + Content Posting API ─────────────────────────
// Required .env: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET
// Tokens persisted in .tiktok-tokens.json (expire after 24h, refreshable)

// GET /api/tiktok/auth?account=personal|brand
// Redirects user to TikTok's OAuth page to authorize the app
app.get('/api/tiktok/auth', (req, res) => {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  if (!clientKey) return res.status(400).send('<h2>Add TIKTOK_CLIENT_KEY to .env and restart the server.</h2>');

  const account = req.query.account === 'brand' ? 'brand' : 'personal';
  const state   = crypto.randomBytes(16).toString('hex');
  tiktokAuthState.set(state, { account, ts: Date.now() });
  // Clean stale states
  for (const [k, v] of tiktokAuthState) { if (Date.now() - v.ts > 600_000) tiktokAuthState.delete(k); }

  const redirectUri = `http://localhost:${CFG.port}/api/tiktok/callback`;
  const params = new URLSearchParams({
    client_key:    clientKey,
    scope:         'user.info.basic,user.info.stats,video.list,video.upload,video.publish',
    response_type: 'code',
    redirect_uri:  redirectUri,
    state,
  });
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`);
});

// GET /api/tiktok/callback — exchanges auth code for access token
app.get('/api/tiktok/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.send(`<h2>TikTok auth error: ${error}</h2><p>${error_description}</p>`);

  const stateData = tiktokAuthState.get(state);
  if (!stateData) return res.send('<h2>Invalid or expired state. Please try again.</h2>');
  tiktokAuthState.delete(state);

  const clientKey    = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const redirectUri  = `http://localhost:${CFG.port}/api/tiktok/callback`;

  try {
    const { data: tok } = await axios.post(
      'https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    if (tok.error) throw new Error(tok.error_description || tok.error);

    const tokens = loadTikTokTokens();
    tokens[stateData.account] = {
      access_token:  tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at:    Date.now() + (tok.expires_in * 1000),
      open_id:       tok.open_id,
      scope:         tok.scope,
    };
    saveTikTokTokens(tokens);
    cache.delete('social'); // bust so Performance tab re-fetches with Display API

    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#12101a;color:#fff">
      <h2 style="color:#00f2ea">TikTok Connected!</h2>
      <p>Account: <strong>${stateData.account}</strong></p>
      <p style="color:#7a7268;margin-top:4px;font-size:13px">Open ID: ${tok.open_id}</p>
      <a href="http://localhost:${CFG.port}" style="display:inline-block;margin-top:28px;padding:12px 28px;background:#00f2ea;color:#12101a;border-radius:8px;text-decoration:none;font-weight:700">← Back to Dashboard</a>
    </body></html>`);
  } catch(e) {
    res.send(`<h2 style="color:red">Token exchange failed</h2><pre>${e.message}</pre>`);
  }
});

// GET /api/tiktok/disconnect?account=personal|brand
app.get('/api/tiktok/disconnect', (req, res) => {
  const account = req.query.account === 'brand' ? 'brand' : 'personal';
  const tokens  = loadTikTokTokens();
  delete tokens[account];
  saveTikTokTokens(tokens);
  cache.delete('social');
  res.json({ ok: true, account });
});

// GET /api/tiktok/status — connection state + expiry info
app.get('/api/tiktok/status', (req, res) => {
  const tokens = loadTikTokTokens();
  const summary = (key) => {
    const t = tokens[key];
    if (!t) return { connected: false };
    return { connected: Date.now() < t.expires_at - 60_000, open_id: t.open_id, expires_at: t.expires_at, scope: t.scope };
  };
  res.json({ configured: !!process.env.TIKTOK_CLIENT_KEY, personal: summary('personal'), brand: summary('brand') });
});

// GET /api/tiktok/profile?account=personal|brand — Display API profile stats
app.get('/api/tiktok/profile', async (req, res) => {
  const account = req.query.account === 'brand' ? 'brand' : 'personal';
  const token   = getTikTokToken(account);
  if (!token) return res.json({ connected: false, error: `Not connected. Open /api/tiktok/auth?account=${account}` });

  try {
    const data = await cached(`tiktok_profile_${account}`, 300_000, async () => {
      const { data: r } = await axios.get(`${TIKTOK_API_BASE}/user/info/`, {
        headers: { Authorization: `Bearer ${token}` },
        params:  { fields: 'display_name,avatar_url,follower_count,following_count,likes_count,video_count,username' },
      });
      if (r.error?.code !== 'ok') throw new Error(r.error?.message || 'Display API error');
      const u = r.data.user;
      return { connected: true, account, username: u.username, display_name: u.display_name, avatar: u.avatar_url, followers: u.follower_count, following: u.following_count, likes: u.likes_count, videos: u.video_count };
    });
    res.json(data);
  } catch(e) { res.json({ connected: false, error: e.message }); }
});

// GET /api/tiktok/videos?account=personal|brand&max_count=20
app.get('/api/tiktok/videos', async (req, res) => {
  const account  = req.query.account === 'brand' ? 'brand' : 'personal';
  const maxCount = Math.min(parseInt(req.query.max_count) || 20, 20);
  const token    = getTikTokToken(account);
  if (!token) return res.json({ connected: false, videos: [] });

  try {
    const data = await cached(`tiktok_videos_${account}`, 300_000, async () => {
      const { data: r } = await axios.post(`${TIKTOK_API_BASE}/video/list/`,
        { max_count: maxCount },
        {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          params:  { fields: 'id,create_time,title,cover_image_url,share_url,like_count,comment_count,share_count,view_count,duration' },
        }
      );
      if (r.error?.code !== 'ok') throw new Error(r.error?.message || 'Display API error');
      return { connected: true, videos: r.data?.videos || [] };
    });
    res.json(data);
  } catch(e) { res.json({ connected: false, videos: [], error: e.message }); }
});

// POST /api/tiktok/post
// Body: { videoId, caption, account: 'personal'|'brand', isDraft?: boolean }
// Uploads a locally staged video to TikTok via Content Posting API
app.post('/api/tiktok/post', async (req, res) => {
  const { videoId, caption = '', account = 'personal', isDraft = false } = req.body || {};
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  const token = getTikTokToken(account);
  if (!token) return res.json({ ok: false, error: `TikTok not connected for ${account}. Visit /api/tiktok/auth?account=${account}` });

  const q     = loadQueue();
  const entry = q.find(v => v.id === videoId);
  if (!entry) return res.status(404).json({ error: 'Video not in queue' });

  if (!entry.localUrl) return res.status(400).json({ error: 'Only locally uploaded videos can be posted via TikTok API (no Arcads URL path).' });
  const videoPath = path.join(UPLOAD_DIR, path.basename(entry.localUrl));
  if (!fs.existsSync(videoPath)) return res.status(400).json({ error: `Video file not found on disk: ${videoPath}` });

  try {
    const fileSize = fs.statSync(videoPath).size;

    // 1. Init upload
    const { data: initResp } = await axios.post(`${TIKTOK_API_BASE}/post/publish/video/init/`, {
      post_info: {
        title:          (caption || entry.title || 'New video').slice(0, 150),
        privacy_level:  isDraft ? 'SELF_ONLY' : 'PUBLIC_TO_EVERYONE',
        disable_duet:   false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source:            'FILE_UPLOAD',
        video_size:        fileSize,
        chunk_size:        fileSize,
        total_chunk_count: 1,
      },
    }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

    if (initResp.error?.code !== 'ok') throw new Error(initResp.error?.message || 'Init failed');
    const { publish_id, upload_url } = initResp.data;

    // 2. Upload file as single chunk
    const fileBuffer = fs.readFileSync(videoPath);
    await axios.put(upload_url, fileBuffer, {
      headers: {
        'Content-Type':  'video/mp4',
        'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
        'Content-Length': fileSize,
      },
      maxBodyLength:   Infinity,
      maxContentLength: Infinity,
    });

    res.json({ ok: true, publish_id, account, is_draft: isDraft });
  } catch(e) {
    console.error('TikTok post error:', e.response?.data || e.message);
    res.json({ ok: false, error: e.response?.data?.error?.message || e.message });
  }
});

// GET /api/tiktok/post/status/:publishId?account=personal|brand
app.get('/api/tiktok/post/status/:publishId', async (req, res) => {
  const { publishId } = req.params;
  const token = getTikTokToken(req.query.account || 'personal');
  if (!token) return res.json({ status: 'error', error: 'Not connected' });
  try {
    const { data: r } = await axios.post(`${TIKTOK_API_BASE}/post/publish/status/fetch/`,
      { publish_id: publishId },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    res.json({ status: r.data?.status || 'unknown', data: r.data });
  } catch(e) { res.json({ status: 'error', error: e.message }); }
});

// ─── Weekly Report Generator ──────────────────────────────────────────────────
app.post('/api/reports/weekly', async (req, res) => {
  const { data, period, reportType = 'weekly' } = req.body;
  if (!data) return res.status(400).json({ ok: false, error: 'No data provided' });
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const periodLabel = period || (reportType === 'monthly' ? 'This Month' : 'This Week');
    const msg = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are a TikTok Shop financial analyst. Analyse this raw Seller Center data and return a clean ${reportType} performance digest.

Calculate:
- Total GMV
- Total Orders
- Average Order Value (GMV ÷ Orders)
- Refund Rate % (Refunds ÷ Orders × 100)
- Top 3 products by GMV
- Week-over-week or period-over-period change if prior data is present
- One-line trend read
- One specific recommended action (not generic — be specific to the numbers)

Return EXACTLY this format:

📊 ${reportType === 'monthly' ? 'Monthly' : 'Weekly'} Numbers — ${periodLabel}

💰 GMV: $X,XXX
📦 Orders: XX
🧾 AOV: $XX.XX
↩️ Refund Rate: X.X%

🏆 Top Products:
1. [Product] — $X,XXX (XX orders)
2. [Product] — $X,XXX (XX orders)
3. [Product] — $X,XXX (XX orders)

📈 vs Last Period: GMV ▲/▼ X% | Orders ▲/▼ X% (omit if no prior data)

💡 Read: [one sentence trend read]
⚡ Action: [one specific action based on the numbers]

Raw data:
${data}`
      }]
    });
    const digest = msg.content[0].text;
    res.json({ ok: true, digest, period: periodLabel });
  } catch (e) {
    console.error('Weekly report error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/reports/send — send digest to Lark via Railway
app.post('/api/reports/send', async (req, res) => {
  const { digest, period } = req.body;
  if (!digest) return res.status(400).json({ ok: false, error: 'No digest provided' });
  try {
    const message = `📬 *Shop Performance Report — ${period || 'This Week'}*\n\n${digest}`;
    const { data } = await axios.post(
      `${CFG.railwayUrl}/command`,
      { text: message, source: 'Weekly Report' },
      { timeout: 10_000 }
    );
    res.json({ ok: true, sent: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Storista — TikTok Shop Video Publishing ──────────────────────────────────
const STORISTA_BASE = 'https://api-v2.storista.io';

function storistaClient() {
  return axios.create({
    baseURL: STORISTA_BASE,
    headers: {
      Authorization: `Bearer ${process.env.STORISTA_API_KEY || ''}`,
      'Content-Type': 'application/json',
    },
    timeout: 30_000,
  });
}

// GET /api/storista/accounts — list connected TikTok accounts
app.get('/api/storista/accounts', async (req, res) => {
  try {
    const { data } = await storistaClient().get('/v1/tiktok/accounts');
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/storista/products/:account — list TikTok Shop products for an account
app.get('/api/storista/products/:account', async (req, res) => {
  try {
    const { data } = await storistaClient().get(`/v1/tiktok/${req.params.account}/products`);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// POST /api/storista/upload — upload a video file to Storista (pre-sign → S3 PUT → media create)
// Accepts multipart form: video file OR a localPath pointing to an already-uploaded file
app.post('/api/storista/upload', upload.single('video'), async (req, res) => {
  let filePath = null;
  let tempFile = false;

  try {
    if (req.file) {
      filePath = req.file.path;
      tempFile = true;
    } else if (req.body.localPath) {
      // Resolve from UPLOAD_DIR
      const resolved = path.resolve(UPLOAD_DIR, path.basename(req.body.localPath));
      if (!fs.existsSync(resolved)) return res.status(400).json({ error: 'File not found' });
      filePath = resolved;
    } else {
      return res.status(400).json({ error: 'Provide a video file or localPath' });
    }

    const stat = fs.statSync(filePath);
    const filename = req.body.filename || path.basename(filePath);
    const s = storistaClient();

    // 1. Pre-sign
    const { data: presign } = await s.post('/v1/media/pre-sign', {
      filename,
      content_type: 'video/mp4',
      size: stat.size,
    });

    // 2. Upload to S3
    const fileBuffer = fs.readFileSync(filePath);
    await axios.put(presign.upload_url, fileBuffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': stat.size,
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120_000,
    });

    // 3. Create media record
    const { data: media } = await s.post('/v1/media/', {
      data: { upload_id: presign.upload_id, name: filename },
    });

    if (tempFile) fs.unlinkSync(filePath);

    res.json({ ok: true, media_id: media.id || media.upload_id || presign.upload_id, presign, media });
  } catch (e) {
    if (tempFile && filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.error('[storista] upload error:', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// POST /api/storista/publish — create + publish a TikTok Shop video
app.post('/api/storista/publish', async (req, res) => {
  const { account, video_id, product_id, product, product_link, caption } = req.body;
  if (!account || !video_id) return res.status(400).json({ error: 'account and video_id required' });

  try {
    const s = storistaClient();

    // 1. Create video record
    const { data: created } = await s.post(`/v1/tiktok/${account}/videos`, {
      video_id,
      product_id: product_id || '',
      product:    product    || '',
      product_link: product_link || '',
      caption:    caption    || '',
    });

    const vid_id = created.id || created.video_id;

    // 2. Publish it
    await s.post(`/v1/tiktok/${account}/videos/${vid_id}/publish`);

    res.json({ ok: true, video_id: vid_id, account });
  } catch (e) {
    console.error('[storista] publish error:', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/storista/status/:account/:videoId — poll publish status
app.get('/api/storista/status/:account/:videoId', async (req, res) => {
  try {
    const { data } = await storistaClient().get(
      `/v1/tiktok/${req.params.account}/videos/${req.params.videoId}`
    );
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data || e.message });
  }
});

// ─── Inventory Forecast Agent ─────────────────────────────────────────────────
// POST /api/inventory/forecast
// Runs all 6 stages via Claude and returns structured stage results.
app.post('/api/inventory/forecast', async (req, res) => {
  const { sellerData, creatorData, config = {} } = req.body;
  if (!sellerData) return res.status(400).json({ ok: false, error: 'sellerData is required' });

  const {
    leadTimeDays   = 90,
    minMarginPct   = 40,
    fbtSplitPct    = 60,
    spikeGrowthPct = 100,
    decayDropPct   = 40,
  } = config;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are an expert TikTok Shop inventory forecasting analyst. Analyse the data below and run all 6 stages of the forecasting framework. Return ONLY valid JSON — no markdown fences, no commentary outside the JSON.

CONFIG:
- Ocean freight lead time: ${leadTimeDays} days
- Min margin % for air freight bridge: ${minMarginPct}%
- FBT allocation: ${fbtSplitPct}% of each PO to FBT, ${100 - fbtSplitPct}% to own 3PL
- Spike flag trigger: daily sales growth ≥${spikeGrowthPct}% over 2 consecutive days OR creator video >100K views in <6h OR sample requests spike >50% above 14-day avg OR add-to-cart growing faster than orders
- Decay flag trigger: sales drop ≥${decayDropPct}% from peak with no recovery in 3 days OR affiliate post rate <50% of peak weekly videos

SELLER CENTER DATA:
${sellerData}

CREATOR / AFFILIATE SIGNALS (may be empty):
${creatorData || '(none provided — skip creator signal analysis, note this in Stage 2)'}

Return this exact JSON structure:
{
  "stages": [
    {
      "number": 1,
      "title": "Catalog Snapshot",
      "summary": "one-line summary of what was found",
      "narrative": "2-4 sentences of key findings and observations",
      "alert_count": 0,
      "gate": false,
      "skus": [
        { "SKU": "id", "Name": "name", "Group": "A/B/C", "On Hand": 0, "In Transit": 0, "Days Supply": 0, "Status": "OK/REORDER NOW/OVERSTOCK" }
      ]
    },
    {
      "number": 2,
      "title": "Signal Scan",
      "summary": "...",
      "narrative": "...",
      "alert_count": 0,
      "gate": false,
      "skus": [
        { "SKU": "id", "Name": "name", "Spike Probability": "HIGH/MED/LOW", "Signals": "description of what triggered it", "Sales Trend": "2-day change" }
      ]
    },
    {
      "number": 3,
      "title": "Spike Response Plan",
      "summary": "...",
      "narrative": "...",
      "alert_count": 0,
      "gate": true,
      "gate_number": 1,
      "skus": [
        { "SKU": "id", "Name": "name", "Current DoS": "X days", "DoS @ 3x": "X days", "DoS @ 5x": "X days", "Air Units": 0, "Air Est Cost": "$0", "Ocean Units": 0 }
      ],
      "decisions": [
        { "sku_id": "id", "sku_name": "name", "recommendation": "Place air bridge order of X units ($Y est) + ocean PO of Z units", "cost": "$X air + $Y ocean" }
      ]
    },
    {
      "number": 4,
      "title": "Decay Detection",
      "summary": "...",
      "narrative": "...",
      "alert_count": 0,
      "gate": true,
      "gate_number": 2,
      "skus": [
        { "SKU": "id", "Name": "name", "Peak Sales/Day": 0, "Current Sales/Day": 0, "Drop %": "0%", "Overstock Risk": "X units arriving in Y days", "Action": "Cancel PO / Reduce / Hold" }
      ],
      "decisions": [
        { "sku_id": "id", "sku_name": "name", "recommendation": "Cancel/reduce incoming PO of X units. Draft supplier comms attached.", "cost": null }
      ]
    },
    {
      "number": 5,
      "title": "Tail Reorder",
      "summary": "...",
      "narrative": "...",
      "alert_count": 0,
      "gate": false,
      "skus": [
        { "SKU": "id", "Name": "name", "Group": "B", "Avg Daily Demand": 0, "Safety Stock": 0, "Reorder Point": 0, "Reorder Qty": 0, "FBT Units": 0, "3PL Units": 0, "Flag": "Auto-reorder / Review trend / Skip" }
      ]
    },
    {
      "number": 6,
      "title": "Accuracy Check",
      "summary": "...",
      "narrative": "If this is the first run, note that there is no historical forecast data to compare against yet. Recommend thresholds to watch for the next review.",
      "alert_count": 0,
      "gate": true,
      "gate_number": 3,
      "skus": [],
      "decisions": [
        { "sku_id": "threshold_tuning", "sku_name": "Threshold Calibration", "recommendation": "Review spike and decay thresholds based on actuals at next monthly gate. Current settings: spike=${spikeGrowthPct}% growth, decay=${decayDropPct}% drop.", "cost": null }
      ]
    }
  ]
}

Be precise with numbers. If a field cannot be calculated from the data, use null or a short note. Do not fabricate sales figures — work only from the data provided.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    });

    let raw = msg.content[0].text.trim();
    // Strip markdown fences if model added them
    raw = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

    const parsed = JSON.parse(raw);
    res.json({ ok: true, ...parsed });
  } catch (e) {
    console.error('[inventory] forecast error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── TikTok Shop Partner API ───────────────────────────────────────────────────
// Portal: https://partner.tiktokshop.com
// Base:   https://open-api.tiktokglobalshop.com
// Auth:   OAuth 2.0 + HMAC-SHA256 request signing on every call
// Tokens: .tiktok-tokens.json key "shop"
// ═══════════════════════════════════════════════════════════════════════════════

const TTS_BASE = 'https://open-api.tiktokglobalshop.com';

// ── Signature algorithm ────────────────────────────────────────────────────────
// 1. Collect all query params (exclude "sign" and "access_token")
// 2. Sort by key name alphabetically
// 3. Build base string: {app_secret}{api_path}{key1}{val1}{key2}{val2}...{body}
// 4. HMAC-SHA256(app_secret, base_string) → uppercase hex
function signTTShop(apiPath, params, body = '') {
  const appSecret = process.env.TIKTOK_SHOP_APP_SECRET || '';
  const sorted = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'access_token')
    .sort();
  const paramStr = sorted.map(k => `${k}${params[k]}`).join('');
  const bodyStr  = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
  const base     = `${appSecret}${apiPath}${paramStr}${bodyStr}`;
  return crypto.createHmac('sha256', appSecret).update(base).digest('hex').toUpperCase();
}

// ── Build common query params + sign ──────────────────────────────────────────
function ttsParams(extra = {}, withShopCipher = true) {
  const tokens  = loadTikTokTokens();
  const shopTok = tokens.shop || {};
  const params  = {
    app_key:   process.env.TIKTOK_SHOP_APP_KEY || '',
    timestamp: Math.floor(Date.now() / 1000),
    ...extra,
  };
  if (withShopCipher && shopTok.shop_cipher) {
    params.shop_cipher = shopTok.shop_cipher;
  }
  return params;
}

// ── Signed request helper ──────────────────────────────────────────────────────
async function ttsRequest(method, apiPath, params = {}, body = null, opts = {}) {
  const tokens  = loadTikTokTokens();
  const shopTok = tokens.shop || {};

  const allParams = ttsParams(params, opts.withShopCipher !== false);
  allParams.sign  = signTTShop(apiPath, allParams, body);

  const config = {
    method,
    url: `${TTS_BASE}${apiPath}`,
    params: allParams,
    headers: {
      'content-type': 'application/json',
      'x-tts-access-token': shopTok.access_token || '',
    },
  };
  if (body) config.data = body;

  const { data } = await axios(config);
  return data;
}

// ── Token refresh ─────────────────────────────────────────────────────────────
async function refreshShopToken() {
  const tokens  = loadTikTokTokens();
  const shopTok = tokens.shop || {};
  if (!shopTok.refresh_token) return false;

  try {
    const { data } = await axios.post(`${TTS_BASE}/api/token/refresh`, null, {
      params: {
        app_key:       process.env.TIKTOK_SHOP_APP_KEY,
        app_secret:    process.env.TIKTOK_SHOP_APP_SECRET,
        refresh_token: shopTok.refresh_token,
        grant_type:    'refresh_token',
      },
    });
    if (data?.data?.access_token) {
      tokens.shop = {
        ...shopTok,
        access_token:  data.data.access_token,
        refresh_token: data.data.refresh_token || shopTok.refresh_token,
        expires_at:    Date.now() + (data.data.access_token_expire_in || 86400) * 1000,
      };
      saveTikTokTokens(tokens);
      return true;
    }
  } catch (e) {
    console.error('[tiktokshop] token refresh failed:', e.message);
  }
  return false;
}

// ── ttsGet / ttsPost helpers that auto-refresh expired tokens ─────────────────
async function ttsGet(apiPath, params = {}, opts = {}) {
  const tokens = loadTikTokTokens();
  const t = tokens.shop || {};
  if (t.expires_at && Date.now() > t.expires_at - 120_000) {
    await refreshShopToken();
  }
  return ttsRequest('GET', apiPath, params, null, opts);
}
async function ttsPost(apiPath, body = {}, params = {}, opts = {}) {
  const tokens = loadTikTokTokens();
  const t = tokens.shop || {};
  if (t.expires_at && Date.now() > t.expires_at - 120_000) {
    await refreshShopToken();
  }
  return ttsRequest('POST', apiPath, params, body, opts);
}

// ────────────────────────────────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────────────────────────────────

// GET /api/tiktokshop/status — connection state + expiry
app.get('/api/tiktokshop/status', (req, res) => {
  const tokens  = loadTikTokTokens();
  const shopTok = tokens.shop || {};
  const connected = !!(shopTok.access_token && Date.now() < (shopTok.expires_at || 0));
  res.json({
    connected,
    shop_id:     shopTok.shop_id     || null,
    shop_name:   shopTok.shop_name   || null,
    shop_cipher: shopTok.shop_cipher || null,
    expires_at:  shopTok.expires_at  || null,
    app_key_set: !!(process.env.TIKTOK_SHOP_APP_KEY),
    auth_url:    `/api/tiktokshop/auth`,
  });
});

// GET /api/tiktokshop/auth — redirect to TikTok Shop OAuth
app.get('/api/tiktokshop/auth', (req, res) => {
  const appKey      = process.env.TIKTOK_SHOP_APP_KEY;
  const redirectUri = process.env.TIKTOK_SHOP_REDIRECT_URI ||
    `https://cultcontent-server-production.up.railway.app/api/tiktok-shop/callback`;

  if (!appKey) {
    return res.status(500).json({ error: 'TIKTOK_SHOP_APP_KEY not set in .env' });
  }

  const authUrl = `https://auth.tiktok-shops.com/oauth/authorize?` +
    `app_key=${encodeURIComponent(appKey)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.redirect(authUrl);
});

// GET /api/tiktokshop/callback — exchange auth_code for access_token
app.get('/api/tiktokshop/callback', async (req, res) => {
  const { code, auth_code } = req.query;
  const authCode = code || auth_code;
  if (!authCode) return res.status(400).send('Missing auth_code');

  try {
    const { data } = await axios.post(`${TTS_BASE}/api/token/getbycode`, null, {
      params: {
        app_key:    process.env.TIKTOK_SHOP_APP_KEY,
        app_secret: process.env.TIKTOK_SHOP_APP_SECRET,
        auth_code:  authCode,
        grant_type: 'authorized_code',
      },
    });

    if (!data?.data?.access_token) {
      return res.status(500).json({ error: 'Token exchange failed', raw: data });
    }

    const tokens  = loadTikTokTokens();
    tokens.shop = {
      access_token:  data.data.access_token,
      refresh_token: data.data.refresh_token,
      expires_at:    Date.now() + (data.data.access_token_expire_in || 86400) * 1000,
      open_id:       data.data.open_id,
    };
    saveTikTokTokens(tokens);

    // Fetch shops to get shop_cipher
    try {
      const shopRes = await ttsGet('/authorization/202309/shops', {}, { withShopCipher: false });
      const shop    = shopRes?.data?.shops?.[0];
      if (shop) {
        tokens.shop.shop_cipher = shop.cipher;
        tokens.shop.shop_id     = shop.id;
        tokens.shop.shop_name   = shop.name;
        tokens.shop.shop_region = shop.region;
        saveTikTokTokens(tokens);
      }
    } catch (e) {
      console.warn('[tiktokshop] shop cipher fetch failed:', e.message);
    }

    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#111;color:#eee">
        <h2>✅ TikTok Shop connected!</h2>
        <p>Shop: <strong>${tokens.shop.shop_name || 'Unknown'}</strong></p>
        <p>Token expires: ${new Date(tokens.shop.expires_at).toLocaleString()}</p>
        <p><a href="/" style="color:#00f2ea">← Back to dashboard</a></p>
      </body></html>
    `);
  } catch (e) {
    console.error('[tiktokshop] callback error:', e.message);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/shops — list authorized shops
app.get('/api/tiktokshop/shops', async (req, res) => {
  try {
    const data = await cached('tts_shops', 3_600_000, () =>
      ttsGet('/authorization/202309/shops', {}, { withShopCipher: false })
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/orders?status=AWAITING_SHIPMENT&page_size=50 — search orders
app.get('/api/tiktokshop/orders', async (req, res) => {
  try {
    const {
      order_status = 'AWAITING_SHIPMENT',
      page_size    = 20,
      sort_field   = 'create_time',
      sort_order   = 'DESC',
      cursor,
    } = req.query;

    const params = { order_status, page_size, sort_field, sort_order };
    if (cursor) params.cursor = cursor;

    const data = await ttsPost('/order/202309/orders/search', {}, params);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/products?page_size=50&status=ACTIVATE — product catalog
app.get('/api/tiktokshop/products', async (req, res) => {
  try {
    const {
      status    = 'ACTIVATE',
      page_size = 20,
      page_token,
    } = req.query;

    const body = {
      status:     [status],
      page_size:  Number(page_size),
      page_token: page_token || undefined,
    };

    const data = await ttsPost('/product/202309/products/search', body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/products/:product_id — single product detail
app.get('/api/tiktokshop/products/:product_id', async (req, res) => {
  try {
    const data = await ttsGet(`/product/202309/products/${req.params.product_id}`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/finance/summary?start_date=2024-01-01&end_date=2024-12-31
app.get('/api/tiktokshop/finance/summary', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    // Convert dates to unix timestamps if provided
    const params = {};
    if (start_date) params.create_time_ge = Math.floor(new Date(start_date).getTime() / 1000);
    if (end_date)   params.create_time_lt = Math.floor(new Date(end_date).getTime() / 1000);

    const data = await ttsPost('/finance/202309/orders/search', {}, params);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/affiliate/creators?page_size=50 — list affiliated creators + perf
app.get('/api/tiktokshop/affiliate/creators', async (req, res) => {
  try {
    const { page_size = 50, page_token, sort_field = 'gmv', sort_order = 'DESC' } = req.query;
    const body = {
      page_size:   Number(page_size),
      sort_field,
      sort_order,
    };
    if (page_token) body.page_token = page_token;

    const data = await ttsPost('/affiliate/seller/202309/creators/search', body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/affiliate/products — products enrolled in affiliate program
app.get('/api/tiktokshop/affiliate/products', async (req, res) => {
  try {
    const { page_size = 50, page_token } = req.query;
    const body = { page_size: Number(page_size) };
    if (page_token) body.page_token = page_token;

    const data = await ttsPost('/affiliate/seller/202309/products/search', body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/affiliate/samples — sample requests from creators
app.get('/api/tiktokshop/affiliate/samples', async (req, res) => {
  try {
    const { status = 'PENDING', page_size = 50 } = req.query;
    const data = await ttsPost('/affiliate/seller/202309/sample_requests/search', {
      status:    [status],
      page_size: Number(page_size),
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/affiliate/orders — orders placed through affiliate links
app.get('/api/tiktokshop/affiliate/orders', async (req, res) => {
  try {
    const { page_size = 50, page_token, start_date, end_date } = req.query;
    const body = { page_size: Number(page_size) };
    if (page_token) body.page_token = page_token;
    if (start_date) body.create_time_ge = Math.floor(new Date(start_date).getTime() / 1000);
    if (end_date)   body.create_time_lt = Math.floor(new Date(end_date).getTime() / 1000);

    const data = await ttsPost('/affiliate/seller/202309/orders/search', body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// POST /api/tiktokshop/affiliate/creators/invite — invite a creator by open_id
app.post('/api/tiktokshop/affiliate/creators/invite', async (req, res) => {
  try {
    const { creator_open_id, product_ids = [], commission_rate } = req.body;
    if (!creator_open_id) return res.status(400).json({ error: 'creator_open_id required' });

    const body = { creator_open_id };
    if (product_ids.length) body.product_ids = product_ids;
    if (commission_rate)    body.commission_rate = commission_rate;

    const data = await ttsPost('/affiliate/seller/202309/creators/invite', body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// PATCH /api/tiktokshop/affiliate/samples/:request_id — approve or reject a sample request
app.patch('/api/tiktokshop/affiliate/samples/:request_id', async (req, res) => {
  try {
    const { action, rejection_reason } = req.body; // action: APPROVE | REJECT
    const body = { sample_request_ids: [req.params.request_id], action };
    if (rejection_reason) body.rejection_reason = rejection_reason;

    const data = await ttsPost('/affiliate/seller/202309/sample_requests/batch_update', body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/categories — product category tree
app.get('/api/tiktokshop/categories', async (req, res) => {
  try {
    const data = await cached('tts_categories', 86_400_000, () =>
      ttsGet('/product/202309/categories', { category_version: 'v2' })
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// GET /api/tiktokshop/webhooks — list registered webhooks
app.get('/api/tiktokshop/webhooks', async (req, res) => {
  try {
    const data = await ttsGet('/event/202309/webhooks');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// PUT /api/tiktokshop/webhooks — register / update a webhook URL for an event type
app.put('/api/tiktokshop/webhooks', async (req, res) => {
  try {
    const { event_type, address } = req.body;
    // Default webhook address points to Railway server
    const webhookUrl = address ||
      `https://cultcontent-server-production.up.railway.app/api/tiktok-shop/webhook`;
    const data = await ttsRequest('PUT', '/event/202309/webhooks', ttsParams(),
      { event_type, address: webhookUrl }
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// POST /api/tiktokshop/webhook — receive inbound TikTok Shop webhook events
// This mirrors the Railway server endpoint; having it here too helps local dev
app.post('/api/tiktokshop/webhook', express.raw({ type: '*/*' }), (req, res) => {
  try {
    const sig     = req.headers['x-tiktok-signature'] || '';
    const payload = req.body?.toString() || '';

    // Optional HMAC verification
    if (process.env.TIKTOK_SHOP_APP_SECRET && sig) {
      const expected = crypto
        .createHmac('sha256', process.env.TIKTOK_SHOP_APP_SECRET)
        .update(payload)
        .digest('hex');
      if (sig !== expected) {
        console.warn('[tiktokshop webhook] signature mismatch');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    let event;
    try { event = JSON.parse(payload); } catch { event = { raw: payload }; }
    console.log('[tiktokshop webhook]', event.type || 'unknown', JSON.stringify(event).slice(0, 200));

    // Invalidate relevant caches on key events
    if (event.type === 'ORDER_STATUS_CHANGE') cache.delete('tts_orders');
    if (event.type?.startsWith('PRODUCT_'))    cache.delete('tts_products');

    res.json({ ok: true });
  } catch (e) {
    console.error('[tiktokshop webhook] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Video — Cross-platform stats ─────────────────────────────────────────────
app.get('/api/video/cross-platform-stats', async (req, res) => {
  const force = req.query.force === '1';
  if (force) cache.delete('video_cross_platform_stats');
  try {
    const data = await cached('video_cross_platform_stats', 600_000, async () => {
      const videos = [];

      // 1. TikTok Display API — personal + brand
      for (const account of ['personal', 'brand']) {
        const token = getTikTokToken(account);
        if (!token) continue;
        try {
          const { data: r } = await axios.post(`${TIKTOK_API_BASE}/video/list/`,
            { max_count: 20 },
            {
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              params:  { fields: 'id,create_time,title,cover_image_url,share_url,like_count,comment_count,share_count,view_count,duration' },
            }
          );
          if (r.error?.code === 'ok') {
            for (const v of (r.data?.videos || [])) {
              videos.push({
                id:           `tiktok_${v.id}`,
                platform:     'tiktok',
                channelName:  account === 'brand' ? 'TikTok Brand' : 'TikTok Personal',
                title:        v.title || '',
                views:        v.view_count    || 0,
                likes:        v.like_count    || 0,
                comments:     v.comment_count || 0,
                shares:       v.share_count   || 0,
                engagements:  (v.like_count || 0) + (v.comment_count || 0) + (v.share_count || 0),
                date:         v.create_time ? new Date(v.create_time * 1000).toISOString() : null,
                thumbnailUrl: v.cover_image_url || null,
                videoUrl:     v.share_url || null,
              });
            }
          }
        } catch(e) { console.warn(`[cross-platform-stats] TikTok ${account}:`, e.message); }
      }

      // 2. Buffer published posts
      const bufferToken = process.env.BUFFER_ACCESS_TOKEN;
      if (bufferToken) {
        try {
          const gql = `{
            channels(first: 50) {
              edges {
                node {
                  id service name avatar
                  posts(first: 20, filter: { status: SENT }) {
                    edges {
                      node {
                        id text createdAt
                        statistics { impressions reach engagements clicks }
                      }
                    }
                  }
                }
              }
            }
          }`;
          const { data: bufResp } = await axios.post('https://api.bufferapp.com/graphql',
            { query: gql },
            { headers: { Authorization: `Bearer ${bufferToken}`, 'Content-Type': 'application/json' } }
          );
          const channels = bufResp?.data?.channels?.edges || [];
          for (const { node: ch } of channels) {
            for (const { node: post } of (ch.posts?.edges || [])) {
              const stats = post.statistics || {};
              videos.push({
                id:           `buffer_${post.id}`,
                platform:     (ch.service || 'social').toLowerCase(),
                channelName:  ch.name || ch.service || '',
                title:        (post.text || '').slice(0, 120),
                views:        stats.impressions  || 0,
                likes:        0,
                comments:     0,
                shares:       0,
                engagements:  stats.engagements  || 0,
                date:         post.createdAt || null,
                thumbnailUrl: null,
                videoUrl:     null,
              });
            }
          }
        } catch(e) { console.warn('[cross-platform-stats] Buffer:', e.message); }
      }

      // Sort by views descending
      videos.sort((a, b) => (b.views || 0) - (a.views || 0));
      return { videos };
    });

    res.json(data);
  } catch(e) {
    console.error('[cross-platform-stats]', e.message);
    res.json({ videos: [], error: e.message });
  }
});

// ─── Video — Generate caption ──────────────────────────────────────────────────
app.post('/api/video/generate-caption', async (req, res) => {
  const { transcript, platform = 'tiktok', tone = 'casual' } = req.body || {};
  if (!transcript) return res.status(400).json({ ok: false, error: 'transcript required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const systemPrompt = `You are a social media expert. Given a video transcript, write an engaging caption optimised for ${platform}.
Return ONLY valid JSON: {"caption": "...", "hashtags": ["tag1", "tag2", ...]}
- caption: punchy, platform-native tone. TikTok/Instagram: conversational, hooks-first, max 150 chars. LinkedIn: professional, max 300 chars. YouTube: descriptive, includes keywords.
- hashtags: 5-8 relevant hashtags WITHOUT the # symbol
- tone: ${tone} (casual | professional | educational | humorous)`;

    const msg = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 512,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: `Transcript:\n${transcript}` }],
    });

    let raw = msg.content?.[0]?.text || '';
    // Strip markdown fences
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(raw);
    res.json({ ok: true, caption: parsed.caption || '', hashtags: parsed.hashtags || [] });
  } catch(e) {
    console.error('[generate-caption]', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ─── Fireflies.ai — recent meeting list ──────────────────────────────────────
app.get('/api/fireflies/meetings', async (req, res) => {
  const keys = [process.env.FIREFLIES_API_KEY, process.env.FIREFLIES_API_KEY_2].filter(Boolean);
  if (!keys.length) return res.json({ connected: false, error: 'FIREFLIES_API_KEY not set' });

  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 7);
  const fromDateStr = fromDate.toISOString().split('T')[0]; // YYYY-MM-DD

  const query = `query {
    transcripts(limit: 50, fromDate: "${fromDateStr}") {
      id title date participants
      summary { short_summary action_items }
    }
  }`;

  const fetchFromKey = async (key) => {
    const r = await axios.post('https://api.fireflies.ai/graphql',
      { query },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } }
    );
    return r.data?.data?.transcripts || [];
  };

  try {
    // Fetch from all configured Fireflies accounts in parallel
    const results = await Promise.allSettled(keys.map(fetchFromKey));
    const seen = new Set();
    const allMeetings = [];
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const t of result.value) {
        if (seen.has(t.id)) continue; // dedupe across accounts
        seen.add(t.id);
        allMeetings.push(t);
      }
    }
    // Sort newest first
    allMeetings.sort((a, b) => (b.date || 0) - (a.date || 0));
    const meetings = allMeetings.map((t, i) => ({
      _idx:         i,
      id:           t.id,
      title:        t.title || 'Untitled Meeting',
      date:         t.date,
      participants: t.participants || [],
      summary:      t.summary || {},
    }));
    res.json({ connected: true, meetings, fromDate: fromDateStr, accountCount: keys.length });
  } catch (err) {
    console.error('fireflies:', err.response?.data || err.message);
    res.json({ connected: false, error: err.response?.data?.message || err.message });
  }
});

// ─── Fireflies.ai — full transcript for one meeting ──────────────────────────
app.get('/api/fireflies/transcript/:id', async (req, res) => {
  const keys = [process.env.FIREFLIES_API_KEY, process.env.FIREFLIES_API_KEY_2].filter(Boolean);
  if (!keys.length) return res.status(400).json({ error: 'FIREFLIES_API_KEY not set' });
  const query = `query Transcript($id: String!) {
    transcript(id: $id) {
      id title date participants
      summary { short_summary action_items keywords }
      sentences { speaker_name text start_time }
    }
  }`;
  const tryFetch = async (key) => {
    const r = await axios.post('https://api.fireflies.ai/graphql',
      { query, variables: { id: req.params.id } },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } }
    );
    return r.data?.data?.transcript || null;
  };
  try {
    // Try all accounts — transcript may live on any of them
    let t = null;
    for (const key of keys) {
      t = await tryFetch(key).catch(() => null);
      if (t?.sentences?.length) break; // found it
    }
    if (!t) return res.status(404).json({ error: 'Transcript not found on any connected account' });
    const lines = (t.sentences || []).map(s => `${s.speaker_name || 'Unknown'}: ${s.text}`);
    res.json({
      id:            t.id,
      title:         t.title,
      date:          t.date,
      participants:  t.participants || [],
      summary:       t.summary || {},
      transcript:    lines.join('\n'),
      sentenceCount: lines.length,
    });
  } catch (err) {
    console.error('fireflies/transcript:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GROWTH PARTNERS — pipeline, proposals, contracts, invoicing
// ══════════════════════════════════════════════════════════════════════════════

// Stage ID → name map for Growth Partners pipeline
const SEGMENT_STAGE_NAMES = {
  '93bc4029-7dbd-4598-8862-cb7ac7784016': 'Lead',
  '4c3cdb15-21e6-4c16-a892-8b419c0a45d9': 'Discovery Call',
  '7e6bf560-11d6-442a-b64f-3bf12f136d5a': 'Proposal Sent',
  '246fa975-94b0-423a-8529-b07601609291': 'Contract Signed',
  'addcb241-593d-4242-b7d5-afeff44cd0a2': 'Active',
  '47cb6c40-df0c-4ac9-b717-ca2bdec2536c': 'Long Term Nurture',
  '9f5e3c2d-0b84-4a7e-b6f1-2e9d8c7a5f3b': 'Churned',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890': 'Disqualified',
};

const GP_PIPELINE_ID = 'W5PxjulbNVh52Gqlkmzm';
const GHL_TOMMY_USER_ID = 'SGKDNf5YvSJgLoRTzIBN';

// ─── GET /api/pipeline/:segment ───────────────────────────────────────────────
// Unified pipeline loader. Currently handles growth-partners; others fall
// through to the existing /api/ghl/opportunities pattern.
app.get('/api/pipeline/:segment', async (req, res) => {
  const { segment } = req.params;

  const PIPELINE_MAP = {
    'growth-partners': GP_PIPELINE_ID,
    // add more segments → pipeline IDs here as needed
  };

  const pipelineId = PIPELINE_MAP[segment];
  if (!pipelineId) return res.status(404).json({ ok: false, error: `Unknown segment: ${segment}` });

  try {
    const data = await cached(`pipeline:${segment}`, 120_000, async () => {
      const r = await ghl.get('/opportunities/search', {
        params: { location_id: CFG.locationId, pipeline_id: pipelineId, limit: 100 },
      });
      const raw = r.data?.opportunities || [];

      // Annotate each opp with resolved stage name + contact
      const opps = raw.map(o => ({
        ...o,
        stageName: SEGMENT_STAGE_NAMES[o.pipelineStageId] || o.pipelineStage?.name || 'Lead',
        contact: {
          id:    o.contact?.id    || o.contactId || '',
          name:  o.contact?.name  || o.contactName || o.name || '',
          email: o.contact?.email || o.contactEmail || '',
        },
      }));

      // Group by stage — preserving display order
      const ORDER = ['Lead','Discovery Call','Proposal Sent','Contract Signed','Active','Long Term Nurture','Churned','Disqualified'];
      const stageMap = {};
      ORDER.forEach(n => { stageMap[n] = []; });
      opps.forEach(o => {
        const key = o.stageName;
        if (!stageMap[key]) stageMap[key] = [];
        stageMap[key].push(o);
      });

      const byStage = Object.entries(stageMap)
        .map(([name, opportunities]) => ({ name, opportunities }));

      return { total: opps.length, byStage, opportunities: opps };
    });
    res.json(data);
  } catch (err) {
    console.error(`pipeline:${segment}`, err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
  }
});

// ─── PUT /api/pipeline/:segment/:oppId/stage ──────────────────────────────────
app.put('/api/pipeline/:segment/:oppId/stage', async (req, res) => {
  const { segment, oppId } = req.params;
  const { stageId } = req.body || {};
  if (!stageId) return res.status(400).json({ ok: false, error: 'stageId required' });
  try {
    await ghl.put(`/opportunities/${oppId}`, { pipelineStageId: stageId });
    cache.delete(`pipeline:${segment}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('stage-update:', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
  }
});

// ─── GHL Contracts — list templates ──────────────────────────────────────────
app.get('/api/ghl/contract-templates', async (req, res) => {
  try {
    const r = await ghl.get('/proposals/templates', { params: { locationId: CFG.locationId } });
    const templates = (r.data?.data || [])
      .filter(t => !t.deleted)
      .map(t => ({ id: t.id, name: t.name, published: t.isPublished }));
    res.json({ ok: true, templates });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
  }
});

// ─── GHL Contracts — send template to contact ─────────────────────────────────
app.post('/api/ghl/send-contract', async (req, res) => {
  const { templateId, contactId } = req.body || {};
  if (!templateId || !contactId) return res.status(400).json({ ok: false, error: 'templateId and contactId required' });
  try {
    const r = await ghl.post('/proposals/templates/send', {
      locationId: CFG.locationId,
      templateId,
      contactId,
      userId: GHL_TOMMY_USER_ID,
    });
    res.json({ ok: true, data: r.data });
  } catch (err) {
    console.error('send-contract:', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
  }
});

// ─── GHL Invoice helpers ──────────────────────────────────────────────────────
const GHL_BUSINESS = {
  name: 'Cult Content', email: 'tommy@cultcontent.cc', phone: '(703) 851-3599', logoUrl: '',
  address: [{ line1: '5830 Wessex Lane', city: 'Alexandria', state: 'VA', postalCode: '22310', country: 'US' }],
};

async function ghlCreateAndSendInvoice({ contactId, contactName, contactEmail, name, items }) {
  const numRes = await ghl.get('/invoices/generate-invoice-number', { params: { altId: CFG.locationId, altType: 'location' } });
  const invoiceNumber = numRes.data?.invoiceNumber;
  const due = new Date(); due.setDate(due.getDate() + 7);
  const createRes = await ghl.post('/invoices/', {
    altId: CFG.locationId, altType: 'location',
    name, invoiceNumber, currency: 'USD',
    issueDate: new Date().toISOString().split('T')[0],
    dueDate: due.toISOString().split('T')[0],
    businessDetails: GHL_BUSINESS,
    contactDetails: { id: contactId, name: contactName || '', email: contactEmail || '' },
    discount: { type: 'percentage', value: 0 },
    items: items.map(i => ({ ...i, taxes: [], taxInclusive: false })),
  });
  const invoiceId = createRes.data?._id || createRes.data?.invoice?._id;
  if (!invoiceId) throw new Error('Invoice created but no ID returned — ' + JSON.stringify(createRes.data).slice(0, 200));
  await ghl.post(`/invoices/${invoiceId}/send`, {
    altId: CFG.locationId, altType: 'location',
    action: 'email', liveMode: true, userId: GHL_TOMMY_USER_ID,
  });
  return { invoiceId, invoiceNumber };
}

// ─── GHL Invoices — retainer (auto-sends with contract) ──────────────────────
app.post('/api/ghl/send-retainer-invoice', async (req, res) => {
  const { contactId, retainerAmount, contactName, contactEmail } = req.body || {};
  if (!contactId || !retainerAmount) return res.status(400).json({ ok: false, error: 'contactId and retainerAmount required' });
  const amount = parseFloat(String(retainerAmount).replace(/[^0-9.]/g, ''));
  if (!amount || isNaN(amount)) return res.status(400).json({ ok: false, error: 'Invalid retainer amount' });
  try {
    const { invoiceId } = await ghlCreateAndSendInvoice({
      contactId, contactName, contactEmail,
      name: `Monthly Retainer — ${contactName || 'Client'}`,
      items: [{ name: 'Monthly Management Retainer', description: 'TikTok Shop affiliate management, content strategy, weekly reporting, bi-weekly syncs.', qty: 1, amount, currency: 'USD' }],
    });
    res.json({ ok: true, invoiceId, amount });
  } catch (err) {
    console.error('send-retainer-invoice:', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
  }
});

// ─── GHL Invoices — monthly GMV performance fee ───────────────────────────────
app.post('/api/ghl/send-gmv-invoice', async (req, res) => {
  const { contactId, contactName, contactEmail, gmvAmount, gmvPercent, month } = req.body || {};
  if (!contactId || !gmvAmount || !gmvPercent) return res.status(400).json({ ok: false, error: 'contactId, gmvAmount, gmvPercent required' });
  const gmv = parseFloat(String(gmvAmount).replace(/[^0-9.]/g, ''));
  const pct = parseFloat(String(gmvPercent).replace(/[^0-9.]/g, ''));
  const fee = Math.round(gmv * (pct / 100) * 100) / 100;
  if (!fee || isNaN(fee)) return res.status(400).json({ ok: false, error: 'Invalid GMV or percent' });
  const label = month || new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  try {
    const { invoiceId } = await ghlCreateAndSendInvoice({
      contactId, contactName, contactEmail,
      name: `GMV Performance Fee — ${label}`,
      items: [{ name: `${pct}% GMV Performance Fee — ${label}`, description: `${pct}% of $${gmv.toLocaleString()} TikTok Shop GMV generated in ${label}.`, qty: 1, amount: fee, currency: 'USD' }],
    });
    res.json({ ok: true, invoiceId, gmv, pct, fee });
  } catch (err) {
    console.error('send-gmv-invoice:', err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data?.message || err.message });
  }
});

// ─── Shopify product scraper (public /products.json — no auth needed) ─────────
async function scrapeShopifyProducts(context) {
  const domains = [];

  // 1. Pull domains from any https:// URLs in the context
  const urlMatches = [...(context.matchAll(/https?:\/\/(?:www\.)?([a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,})/g))];
  domains.push(...urlMatches.map(m => m[1]));

  // 2. Pull domains from email addresses (e.g. john@orionbrand.com → orionbrand.com)
  const emailMatches = [...(context.matchAll(/[a-zA-Z0-9._%+\-]+@([a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,})/g))];
  domains.push(...emailMatches.map(m => m[1]));

  // 3. Try to extract brand name for domain guessing
  const brandMatch = context.match(/brand[:\s]+([A-Za-z0-9 &]+)/i) ||
                     context.match(/company[:\s]+([A-Za-z0-9 &]+)/i);
  if (brandMatch) {
    const slug = brandMatch[1].trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    domains.push(`${slug}.com`, `shop${slug}.com`, `${slug}.myshopify.com`, `try${slug}.com`);
  }

  for (const domain of [...new Set(domains)]) {
    // Skip obviously non-brand domains
    if (/google|gmail|zoom|calendly|meet\.|loom|slack|notion|drive\.|docs\.|youtube|instagram|tiktok|linkedin|twitter|facebook/.test(domain)) continue;
    try {
      const { data } = await axios.get(`https://${domain}/products.json?limit=10`, {
        timeout: 6000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research bot)' },
      });
      if (data?.products?.length > 0) {
        const products = data.products.slice(0, 12).map(p => {
          // Collect all variant prices to find the real range
          const prices = p.variants.map(v => parseFloat(v.price || 0)).filter(x => x > 0);
          const comparePrices = p.variants.map(v => parseFloat(v.compare_at_price || 0)).filter(x => x > 0);
          const minPrice = prices.length ? Math.min(...prices) : 0;
          const maxPrice = prices.length ? Math.max(...prices) : 0;
          const avgPrice = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length * 100) / 100 : 0;
          const compareAtPrice = comparePrices.length ? Math.max(...comparePrices) : null;
          return {
            title: p.title,
            priceRange: minPrice === maxPrice ? `$${minPrice}` : `$${minPrice}–$${maxPrice}`,
            typicalPrice: avgPrice, // average across all variants = best AOV estimate
            compareAtPrice: compareAtPrice,
            variantCount: p.variants?.length || 1,
          };
        });
        console.log(`[shopify] found ${products.length} products on ${domain}`);
        return { domain, products };
      }
    } catch (e) { /* try next */ }
  }
  return null;
}

// ─── AI Proposal generator ────────────────────────────────────────────────────
// ── Step 1: Extract metrics from transcript + Shopify ─────────────────────────
app.post('/api/ai/extract-metrics', async (req, res) => {
  try {
    const { context } = req.body;
    if (!context) return res.status(400).json({ error: 'context required' });
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const shopifyData = await scrapeShopifyProducts(context);
    const shopifyBlock = shopifyData
      ? `\nSHOPIFY PRODUCT DATA (from ${shopifyData.domain}):\n` +
        shopifyData.products.map(p =>
          `- ${p.title}: typicalPrice=$${p.typicalPrice}${p.compareAtPrice ? `, compareAtPrice=$${p.compareAtPrice}` : ''}${p.variantCount > 1 ? ` (${p.variantCount} variants)` : ''}`
        ).join('\n')
      : '\nNo Shopify data found.';

    const SYSTEM = `You are a data extraction assistant for a TikTok Shop agency. Extract structured metrics from a sales call transcript and Shopify product data. Return ONLY valid JSON — no markdown, no explanation.

Schema:
{
  "brandName": "string",
  "heroProduct": "string — most relevant product for TikTok Shop (specific name)",
  "metrics": {
    "listPrice": number or null,
    "promoPct": number or null,
    "shippingPerUnit": number or null,
    "cogsPerUnit": number or null,
    "affiliateCommPct": number or null,
    "avgViews": number or null,
    "monthlySamples": number or null,
    "affiliateRetainers": number or null
  },
  "sources": {
    "listPrice": "shopify"|"transcript"|"ai"|"missing",
    "promoPct": "shopify"|"transcript"|"ai"|"missing",
    "shippingPerUnit": "shopify"|"transcript"|"ai"|"missing",
    "cogsPerUnit": "shopify"|"transcript"|"ai"|"missing",
    "affiliateCommPct": "shopify"|"transcript"|"ai"|"missing",
    "avgViews": "shopify"|"transcript"|"ai"|"missing",
    "monthlySamples": "shopify"|"transcript"|"ai"|"missing",
    "affiliateRetainers": "shopify"|"transcript"|"ai"|"missing"
  }
}

Source meanings: "shopify"=from product data, "transcript"=explicitly stated, "ai"=reasonable estimate you filled in, "missing"=cannot determine.

RULES — follow exactly:
listPrice: Shopify typicalPrice of most relevant product → source "shopify". If no Shopify, only use price explicitly stated in transcript → "transcript". Otherwise null/"missing". NEVER infer or guess.
promoPct (whole number): If Shopify compareAtPrice > typicalPrice → promoPct = round((1 - typicalPrice/compareAtPrice)*100), source "shopify". If discount mentioned in transcript → "transcript". If no info → 0, source "ai".
cogsPerUnit: null/"missing" UNLESS explicitly stated. Almost never mentioned.
shippingPerUnit: null/"missing" UNLESS explicitly stated.
affiliateCommPct: If mentioned → "transcript". Else 25, source "ai".
avgViews: 2000, source "ai" — this represents estimated monthly views per creator. Do NOT pull from brand's own TikTok stats; it's an industry benchmark for new-to-TikTok-Shop creators.
monthlySamples: If mentioned → "transcript". Else estimate conservatively by brand size: very small/new brand=25-40, small=50, mid=75, large=100. Source "ai". Err on the low side — better to under-promise.
affiliateRetainers: If mentioned → "transcript". Else 1000, source "ai".`;

    const msg = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 700,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Extract metrics.${shopifyBlock}\n\nTRANSCRIPT:\n${context}\n\nReturn ONLY valid JSON.` }],
    });

    const raw = msg.content[0].text.trim();
    const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    const extracted = JSON.parse(jsonStr);
    res.json({ ...extracted, shopifyData: shopifyData || null });
  } catch (err) {
    console.error('extract-metrics:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Step 2: Generate proposal narrative (metrics already confirmed) ─────────────
app.post('/api/ai/propose', async (req, res) => {
  try {
    const { context, retainer, gmv, confirmedMetrics } = req.body;
    if (!context) return res.status(400).json({ error: 'context required' });
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const retainerNum = parseInt(String(retainer || '2500').replace(/[^0-9]/g, '')) || 2500;
    const gmvNum = parseFloat(String(gmv || '5').replace(/[^0-9.]/g, '')) || 5;
    const breakEvenGMV = Math.round(retainerNum / (gmvNum / 100));

    // If confirmed metrics provided (two-step flow), skip Shopify scrape — already done in Step 1
    const shopifyData = confirmedMetrics ? null : await scrapeShopifyProducts(context);

    // Build economics summary from confirmed metrics so AI writes accurate narrative
    let economicsSummary = '';
    if (confirmedMetrics) {
      const { listPrice, promoPct = 0, shippingPerUnit = 6, cogsPerUnit = 0, affiliateCommPct = 25, monthlySamples = 75 } = confirmedMetrics;
      const sellingPrice = listPrice * (1 - promoPct / 100);
      const affComm = sellingPrice * affiliateCommPct / 100;
      const tikTokFee = sellingPrice * 0.06;
      const grossProfit = sellingPrice - (shippingPerUnit || 0) - (cogsPerUnit || 0) - affComm - tikTokFee;
      const grossMarginPct = sellingPrice > 0 ? grossProfit / sellingPrice : 0;
      const isViable = grossMarginPct >= 0.05;
      economicsSummary = `\nCONFIRMED UNIT ECONOMICS (use these exact figures, do not invent different numbers):
List price: $${listPrice} | Promo: ${promoPct}% | Selling price: $${sellingPrice.toFixed(2)}
COGS: $${cogsPerUnit || '?'} | Shipping: $${shippingPerUnit || '?'} | Aff commission: ${affiliateCommPct}%
Gross margin: ${(grossMarginPct * 100).toFixed(1)}% ${isViable ? '(VIABLE — write growth narrative)' : '(NEGATIVE — write diagnostic/fix narrative, no GMV growth claims)'}
Monthly samples at velocity: ${monthlySamples}`;
    }

    const SYSTEM = `You are Tommy Lynch, founder of Cult Content (cultcontent.cc), a TikTok Shop social commerce agency. You write proposals for potential brand clients.

Output ONLY a valid JSON object — no markdown, no code blocks, no explanation. Return raw JSON only.

Schema (follow exactly):
{
  "brandName": "string — extract carefully from notes. Use exact brand name.",
  "tagline": "string — one sharp sentence: the core business opportunity or question. Frame as a business decision.",
  "strategicQuestion": "string — 2-3 punchy sentences. What decision does this brand face re: TikTok Shop? What does success/failure mean for them? Reference their specific situation.",
  "currentStateMetrics": [
    {"label": "string", "value": "string"}
  ],
  "financialBreakdown": {
    "sellingPrice": number or null,
    "tikTokFeePercent": 6,
    "affiliateCommissionPercent": 12,
    "cogsPercent": number or null,
    "contributionMarginPercent": number or null,
    "narrativeLine": "string — 1-2 sentences on what the math means for this brand"
  },
  "roadmap": {
    "month1Bullets": ["string"],
    "months12Bullets": ["string"],
    "month3plusBullets": ["string"]
  },
  "nextSteps": ["string", "string", "string"],
  "profitabilityFix": {
    "isUnprofitable": boolean,
    "primaryIssue": "string — one sharp sentence on the core unit economics problem",
    "targetAOV": number or null,
    "targetProduct": "string — specific product or SKU to push as hero",
    "bundleIdea": "string — concrete bundle recommendation with products and price point",
    "strategySteps": ["string", "string", "string"]
  },
  "projections": {
    "aov": number,
    "cogsPercent": number,
    "creatorCommissionPct": number,
    "monthlyGMVGoals": [number, number, number, number, number, number, number, number, number, number, number, number]
  },
}

STYLE RULES:
- Short, punchy sentences. Zero filler words.
- Confident assertions: "This will" not "this should"
- Reference specific details from the notes — product, price point, pain points
- Never be generic. Every sentence should only make sense for THIS brand.
- For currentStateMetrics: ONLY include values explicitly stated in the meeting notes. Do NOT infer, estimate, or fabricate values. Omit any metric not mentioned. Examples: {"label":"Active SKUs","value":"2"}, {"label":"AOV","value":"$74"}.
- For monthlyGMVGoals: realistic 12-month ramp based on CONFIRMED UNIT ECONOMICS above. If economics are viable, ramp aggressively. If negative/diagnostic, show conservative ramp based on fixing pricing first.
- For profitabilityFix: use the CONFIRMED UNIT ECONOMICS above to determine viability. If grossMarginPct >= 5%, set isUnprofitable=false. If negative, set isUnprofitable=true with concrete AOV fix strategy — specific bundle name, specific price point that achieves 35% GM, 3 actionable steps. Do not invent a different price than what was confirmed.`;

    const msg = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2500,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Generate a proposal for this brand.

Meeting notes / context:
${context}
${economicsSummary}
${shopifyData ? `\nSHOPIFY DATA (${shopifyData.domain}):\n${shopifyData.products.map(p => `- ${p.title}: typicalPrice=$${p.typicalPrice}${p.compareAtPrice ? `, compareAt=$${p.compareAtPrice}` : ''}`).join('\n')}` : ''}

Agency pricing:
Retainer: $${retainerNum.toLocaleString()}/mo
GMV share: ${gmvNum}%
Break-even GMV: $${breakEvenGMV.toLocaleString()}

Return ONLY valid JSON. No other text.` }],
    });

    const raw = msg.content[0].text.trim();
    // Strip any accidental markdown code fences
    const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    const proposal = JSON.parse(jsonStr);
    proposal.pricing = { retainer: retainerNum, gmvPct: gmvNum, breakEvenGMV };
    res.json({ proposal, shopifyData: shopifyData || null });
  } catch (err) {
    console.error('propose:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'dashboard' }));

app.listen(CFG.port, () => {
  console.log(`\n⚡ Cult Content Command Center`);
  console.log(`   http://localhost:${CFG.port}\n`);
});
