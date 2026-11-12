/**
 * routes/mcp-server.js — Cult Content Command Center MCP Server ("the door")
 *
 * Platform-based proxy architecture: tools are DATA (not functions). Each tool
 * entry describes an upstream REST API call. The single callTool() function
 * handles all proxy logic — path param substitution, query string / body
 * building, auth headers. Buffer is a special case that forwards JSON-RPC
 * directly to Buffer's MCP endpoint.
 *
 * Implements MCP Streamable HTTP transport (JSON-RPC 2.0 over POST /mcp).
 * Bearer tokens issued from /api/mcp/token (routes/mcp-admin.js).
 *
 * Audit log: DATA_DIR/mcp-audit.jsonl — one line per tool call.
 * Args are NEVER logged (they may contain PII/credentials).
 *
 * Mount:
 *   try { require('./routes/mcp-server')(app, { express }); }
 *   catch (e) { console.error('[mcp-server] registration failed:', e.message); }
 */

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));

const TOKENS_FILE    = path.join(DATA_DIR, 'mcp-tokens.json');
const USERS_FILE     = path.join(DATA_DIR, 'portal-users.json');
const AUDIT_FILE     = path.join(DATA_DIR, 'mcp-audit.jsonl');
const AUDIT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

const { scryptVerify } = require('../middleware/password');

// ── Platform base URLs / auth builders ───────────────────────────────────────
const REACHER_BASE  = 'https://api.reacherapp.com/public/v1';
const GHL_BASE      = 'https://services.leadconnectorhq.com';
const STORISTA_BASE = 'https://api-v2.storista.io/v1';
const BUFFER_MCP    = 'https://mcp.buffer.com/mcp';
const OMNI_MCP      = 'https://omniagent.cc/api/mcp';

function reacherAuth(env) {
  return { 'x-api-key': env.REACHER_API_KEY || '', 'Content-Type': 'application/json' };
}
function storistaAuth(env) {
  return { Authorization: `Bearer ${env.STORISTA_API_KEY || ''}`, 'Content-Type': 'application/json' };
}
function ghlAuth(env) {
  return {
    Authorization: `Bearer ${env.GHL_API_KEY || ''}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
  };
}

// ── JSON file helpers ─────────────────────────────────────────────────────────
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}

// ── Audit log ─────────────────────────────────────────────────────────────────
function auditLog(user, tool, ok, ms) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), user, tool, ok, ms }) + '\n';
    try {
      const stat = fs.statSync(AUDIT_FILE);
      if (stat.size >= AUDIT_MAX_BYTES) fs.renameSync(AUDIT_FILE, AUDIT_FILE + '.1');
    } catch (_) {}
    fs.appendFileSync(AUDIT_FILE, line);
  } catch (e) { console.error('[mcp-audit] write failed:', e.message); }
}

// ── Token auth ────────────────────────────────────────────────────────────────
function resolveToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const plaintext = authHeader.slice(7).trim();
  if (!plaintext.startsWith('ccmcp_')) return null;

  const tokens = readJson(TOKENS_FILE, []);
  const users  = readJson(USERS_FILE, []);

  for (const tok of tokens) {
    if (tok.revokedAt) continue;
    if (!tok.tokenHash || !tok.salt) continue;
    if (!scryptVerify(plaintext, tok.tokenHash, tok.salt)) continue;
    const user = users.find(u => u.id === tok.userId);
    if (!user || !user.active) continue;
    if (!Array.isArray(user.permissions) || !user.permissions.includes('mcp_access')) continue;
    tok.lastUsedAt = Date.now();
    try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2)); } catch (_) {}
    console.log(`[mcp-server] token resolved: user=${user.email||user.username} perms=${JSON.stringify(user.permissions||[])}`);
    return { user, tokenRecord: tok };
  }
  return null;
}

// ── HTTP fetch helper ─────────────────────────────────────────────────────────
async function httpFetch(url, opts = {}) {
  if (typeof fetch !== 'undefined') {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; }
    catch { return { status: r.status, body: text }; }
  }
  return new Promise((resolve, reject) => {
    const https = require('https');
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── Tool registry ─────────────────────────────────────────────────────────────
//
// Each entry:
//   name         — tool name in MCP namespace
//   platform     — permission name that gates access ('reacher', 'ghl', etc.)
//   description  — shown to Claude
//   method       — HTTP method
//   path         — URL path; :param tokens are replaced from args
//   baseUrl      — upstream base URL
//   authHeader   — fn(env) → headers object
//   inputSchema  — JSON Schema for args
//   queryParams  — array of arg names → query string (GET); undefined = all remaining
//   bodyParams   — array of arg names → request body (POST/PUT); undefined = all remaining
//   envQuery     — fn(env) → extra query params from env (not from user args)
//   envBody      — fn(env) → extra body params from env (not from user args)
//   confirm      — bool: first call returns summary, second call with confirmed:true executes
//
const TOOLS = [

  // ── Reacher ──────────────────────────────────────────────────────────────────
  {
    name: 'reacher_shops_list',
    platform: 'reacher',
    description: 'List all Reacher shops connected to this account.',
    method: 'GET',
    path: '/shops',
    baseUrl: REACHER_BASE,
    authHeader: reacherAuth,
    inputSchema: { type: 'object', properties: {} },
    queryParams: [],
    confirm: false,
  },

  {
    name: 'reacher_creators_list',
    platform: 'reacher',
    description: 'List creators on a Reacher shop roster. Filter by status, page, or search term.',
    method: 'GET',
    path: '/shops/:shopId/creators',
    baseUrl: REACHER_BASE,
    authHeader: reacherAuth,
    inputSchema: {
      type: 'object',
      properties: {
        shopId: { type: 'string', description: 'Reacher shop ID' },
        limit:  { type: 'number', description: 'Max results (default 50)', default: 50 },
        page:   { type: 'number', description: 'Page number (default 1)', default: 1 },
        search: { type: 'string', description: 'Search by name or handle' },
        status: { type: 'string', description: 'Filter by status' },
      },
      required: ['shopId'],
    },
    queryParams: ['limit', 'page', 'search', 'status'],
    confirm: false,
  },

  {
    name: 'reacher_creator_detail',
    platform: 'reacher',
    description: 'Get full detail for a single Reacher creator.',
    method: 'GET',
    path: '/shops/:shopId/creators/:creatorId',
    baseUrl: REACHER_BASE,
    authHeader: reacherAuth,
    inputSchema: {
      type: 'object',
      properties: {
        shopId:    { type: 'string' },
        creatorId: { type: 'string' },
      },
      required: ['shopId', 'creatorId'],
    },
    queryParams: [],
    confirm: false,
  },

  {
    name: 'reacher_creator_videos',
    platform: 'reacher',
    description: 'Get videos posted by a Reacher creator.',
    method: 'GET',
    path: '/shops/:shopId/creators/:creatorId/videos',
    baseUrl: REACHER_BASE,
    authHeader: reacherAuth,
    inputSchema: {
      type: 'object',
      properties: {
        shopId:    { type: 'string' },
        creatorId: { type: 'string' },
        limit:     { type: 'number' },
        page:      { type: 'number' },
      },
      required: ['shopId', 'creatorId'],
    },
    queryParams: ['limit', 'page'],
    confirm: false,
  },

  {
    name: 'reacher_campaigns_list',
    platform: 'reacher',
    description: 'List campaigns for a Reacher shop.',
    method: 'GET',
    path: '/shops/:shopId/campaigns',
    baseUrl: REACHER_BASE,
    authHeader: reacherAuth,
    inputSchema: {
      type: 'object',
      properties: {
        shopId: { type: 'string' },
        limit:  { type: 'number' },
        page:   { type: 'number' },
      },
      required: ['shopId'],
    },
    queryParams: ['limit', 'page'],
    confirm: false,
  },

  {
    name: 'reacher_campaign_detail',
    platform: 'reacher',
    description: 'Get full detail for a Reacher campaign.',
    method: 'GET',
    path: '/shops/:shopId/campaigns/:campaignId',
    baseUrl: REACHER_BASE,
    authHeader: reacherAuth,
    inputSchema: {
      type: 'object',
      properties: {
        shopId:     { type: 'string' },
        campaignId: { type: 'string' },
      },
      required: ['shopId', 'campaignId'],
    },
    queryParams: [],
    confirm: false,
  },

  {
    name: 'reacher_campaign_creators_list',
    platform: 'reacher',
    description: 'List creators enrolled in a Reacher campaign.',
    method: 'GET',
    path: '/shops/:shopId/campaigns/:campaignId/creators',
    baseUrl: REACHER_BASE,
    authHeader: reacherAuth,
    inputSchema: {
      type: 'object',
      properties: {
        shopId:     { type: 'string' },
        campaignId: { type: 'string' },
        limit:      { type: 'number' },
        page:       { type: 'number' },
      },
      required: ['shopId', 'campaignId'],
    },
    queryParams: ['limit', 'page'],
    confirm: false,
  },

  {
    name: 'reacher_automations_list',
    platform: 'reacher',
    description: 'List automations for a Reacher shop.',
    method: 'GET',
    path: '/shops/:shopId/automations',
    baseUrl: REACHER_BASE,
    authHeader: reacherAuth,
    inputSchema: {
      type: 'object',
      properties: {
        shopId: { type: 'string' },
      },
      required: ['shopId'],
    },
    queryParams: [],
    confirm: false,
  },

  {
    name: 'reacher_send_creator_message',
    platform: 'reacher',
    description: 'Send a message to a creator via Reacher. Requires confirmation before sending.',
    method: 'POST',
    path: '/shops/:shopId/creators/:creatorId/messages',
    baseUrl: REACHER_BASE,
    authHeader: reacherAuth,
    inputSchema: {
      type: 'object',
      properties: {
        shopId:    { type: 'string' },
        creatorId: { type: 'string' },
        message:   { type: 'string', description: 'Message text to send' },
        confirmed: { type: 'boolean', description: 'Set true to confirm and send', default: false },
      },
      required: ['shopId', 'creatorId', 'message'],
    },
    bodyParams: ['message'],
    confirm: true,
  },

  {
    name: 'reacher_samples_list',
    platform: 'reacher',
    description: 'List product sample requests for a Reacher shop.',
    method: 'GET',
    path: '/shops/:shopId/samples',
    baseUrl: REACHER_BASE,
    authHeader: reacherAuth,
    inputSchema: {
      type: 'object',
      properties: {
        shopId: { type: 'string' },
        limit:  { type: 'number' },
        page:   { type: 'number' },
        status: { type: 'string' },
      },
      required: ['shopId'],
    },
    queryParams: ['limit', 'page', 'status'],
    confirm: false,
  },

  // ── GoHighLevel ───────────────────────────────────────────────────────────────
  {
    name: 'ghl_contacts_search',
    platform: 'ghl',
    description: 'Search GoHighLevel contacts by name, email, or phone.',
    method: 'POST',
    path: '/contacts/search',
    baseUrl: GHL_BASE,
    authHeader: ghlAuth,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term (name, email, or phone)' },
        limit: { type: 'number', description: 'Max results (default 20)', default: 20 },
      },
      required: ['query'],
    },
    bodyParams: ['query', 'limit'],
    envBody: (env) => ({ locationId: env.GHL_LOCATION_ID || env.GHL_LOC_ID || '' }),
    confirm: false,
  },

  {
    name: 'ghl_contact_get',
    platform: 'ghl',
    description: 'Get full detail for a single GoHighLevel contact by ID.',
    method: 'GET',
    path: '/contacts/:contactId',
    baseUrl: GHL_BASE,
    authHeader: ghlAuth,
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
      },
      required: ['contactId'],
    },
    queryParams: [],
    confirm: false,
  },

  {
    name: 'ghl_contact_create',
    platform: 'ghl',
    description: 'Create a new GoHighLevel contact. Requires confirmation.',
    method: 'POST',
    path: '/contacts/',
    baseUrl: GHL_BASE,
    authHeader: ghlAuth,
    inputSchema: {
      type: 'object',
      properties: {
        firstName: { type: 'string' },
        lastName:  { type: 'string' },
        email:     { type: 'string' },
        phone:     { type: 'string' },
        name:      { type: 'string' },
        confirmed: { type: 'boolean', default: false },
      },
    },
    // bodyParams undefined → all remaining args go to body (plus envBody locationId)
    envBody: (env) => ({ locationId: env.GHL_LOCATION_ID || env.GHL_LOC_ID || '' }),
    confirm: true,
  },

  {
    name: 'ghl_contact_update',
    platform: 'ghl',
    description: 'Update a GoHighLevel contact by ID. Requires confirmation.',
    method: 'PUT',
    path: '/contacts/:contactId',
    baseUrl: GHL_BASE,
    authHeader: ghlAuth,
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        firstName: { type: 'string' },
        lastName:  { type: 'string' },
        email:     { type: 'string' },
        phone:     { type: 'string' },
        confirmed: { type: 'boolean', default: false },
      },
      required: ['contactId'],
    },
    // bodyParams undefined → all remaining args go to body
    confirm: true,
  },

  {
    name: 'ghl_conversations_list',
    platform: 'ghl',
    description: 'List GoHighLevel conversations, optionally filtered by contact.',
    method: 'GET',
    path: '/conversations/search',
    baseUrl: GHL_BASE,
    authHeader: ghlAuth,
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        limit:     { type: 'number', default: 20 },
      },
    },
    queryParams: ['contactId', 'limit'],
    envQuery: (env) => ({ locationId: env.GHL_LOCATION_ID || env.GHL_LOC_ID || '' }),
    confirm: false,
  },

  {
    name: 'ghl_conversation_messages',
    platform: 'ghl',
    description: 'Get all messages in a GoHighLevel conversation.',
    method: 'GET',
    path: '/conversations/:conversationId/messages',
    baseUrl: GHL_BASE,
    authHeader: ghlAuth,
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string' },
      },
      required: ['conversationId'],
    },
    queryParams: [],
    confirm: false,
  },

  {
    name: 'ghl_send_message',
    platform: 'ghl',
    description: 'Send a message via GoHighLevel (Email, SMS, etc.). Requires confirmation.',
    method: 'POST',
    path: '/conversations/messages',
    baseUrl: GHL_BASE,
    authHeader: ghlAuth,
    inputSchema: {
      type: 'object',
      properties: {
        type:           { type: 'string', enum: ['Email', 'SMS', 'IG', 'FB', 'Custom', 'WhatsApp'] },
        conversationId: { type: 'string' },
        contactId:      { type: 'string' },
        subject:        { type: 'string', description: 'Email subject' },
        html:           { type: 'string', description: 'Email body HTML' },
        confirmed:      { type: 'boolean', default: false },
      },
      required: ['type', 'conversationId', 'contactId'],
    },
    bodyParams: ['type', 'conversationId', 'contactId', 'subject', 'html'],
    confirm: true,
  },

  {
    name: 'ghl_opportunities_search',
    platform: 'ghl',
    description: 'Search GoHighLevel opportunities by keyword.',
    method: 'GET',
    path: '/opportunities/search',
    baseUrl: GHL_BASE,
    authHeader: ghlAuth,
    inputSchema: {
      type: 'object',
      properties: {
        q:     { type: 'string', description: 'Search query' },
        limit: { type: 'number', default: 20 },
      },
    },
    queryParams: ['q', 'limit'],
    // GHL uses location_id (underscore) for the opportunities endpoint
    envQuery: (env) => ({ location_id: env.GHL_LOCATION_ID || env.GHL_LOC_ID || '' }),
    confirm: false,
  },

  {
    name: 'ghl_pipelines_list',
    platform: 'ghl',
    description: 'List all GoHighLevel pipelines.',
    method: 'GET',
    path: '/opportunities/pipelines',
    baseUrl: GHL_BASE,
    authHeader: ghlAuth,
    inputSchema: { type: 'object', properties: {} },
    queryParams: [],
    envQuery: (env) => ({ locationId: env.GHL_LOCATION_ID || env.GHL_LOC_ID || '' }),
    confirm: false,
  },

  // ── Storista ────────────────────────────────────────────────────────────────
  {
    name: 'storista_accounts_list',
    platform: 'storista',
    description: 'List TikTok accounts connected to this Storista workspace.',
    method: 'GET',
    path: '/tiktok/accounts',
    baseUrl: STORISTA_BASE,
    authHeader: storistaAuth,
    inputSchema: { type: 'object', properties: {} },
    confirm: false,
  },
  {
    name: 'storista_products_list',
    platform: 'storista',
    description: 'List products available on a TikTok account in Storista.',
    method: 'GET',
    path: '/tiktok/accounts/:account/products',
    baseUrl: STORISTA_BASE,
    authHeader: storistaAuth,
    inputSchema: {
      type: 'object',
      properties: { account: { type: 'string', description: 'TikTok account ID from storista_accounts_list' } },
      required: ['account'],
    },
    confirm: false,
  },
  {
    name: 'storista_schedule_post',
    platform: 'storista',
    description: 'Schedule a TikTok post via Storista. Requires confirmation before sending.',
    method: 'POST',
    path: '/tiktok/accounts/:account/posts',
    baseUrl: STORISTA_BASE,
    authHeader: storistaAuth,
    inputSchema: {
      type: 'object',
      properties: {
        account:     { type: 'string', description: 'TikTok account ID' },
        video_url:   { type: 'string', description: 'URL of the video to post' },
        caption:     { type: 'string', description: 'Caption / description for the post' },
        schedule_at: { type: 'string', description: 'ISO 8601 datetime to publish (omit for immediate)' },
      },
      required: ['account', 'video_url', 'caption'],
    },
    confirm: true,
  },
];

// ── Buffer dynamic tools ───────────────────────────────────────────────────────
// Fetched from Buffer's HTTP MCP endpoint, cached 5 min.
let _bufferToolsCache = null;
let _bufferToolsCacheTs = 0;

async function getBufferTools() {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) return [];
  if (_bufferToolsCache && Date.now() - _bufferToolsCacheTs < 300_000) return _bufferToolsCache;
  try {
    const { status, body } = await httpFetch(BUFFER_MCP, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'list-1', method: 'tools/list', params: {} }),
    });
    if (status >= 400) return [];
    const tools = (body?.result?.tools || []).map(t => ({
      ...t,
      name: 'buffer_' + t.name,
      _isBuffer: true,
      _bufferOriginalName: t.name,
    }));
    _bufferToolsCache = tools;
    _bufferToolsCacheTs = Date.now();
    return tools;
  } catch (e) {
    console.error('[mcp-server] Buffer tools/list failed:', e.message);
    return [];
  }
}

async function callBufferTool(originalName, args) {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) throw new Error('BUFFER_ACCESS_TOKEN not configured');
  const { status, body } = await httpFetch(BUFFER_MCP, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `call-${Date.now()}`,
      method: 'tools/call',
      params: { name: originalName, arguments: args },
    }),
  });
  if (status >= 400) {
    return { ok: false, error: `Buffer MCP error ${status}`, status };
  }
  if (body && body.error) {
    return { ok: false, error: body.error.message || JSON.stringify(body.error), code: body.error.code };
  }
  return body?.result ?? body;
}

// ── Omni Agent dynamic tools ───────────────────────────────────────────────────
// Fetched from Omni Agent's HTTP MCP endpoint, cached 5 min.
let _omniToolsCache = null;
let _omniToolsCacheTs = 0;

async function getOmniTools() {
  const token = process.env.OMNI_AGENT_API_KEY;
  if (!token) return [];
  if (_omniToolsCache && Date.now() - _omniToolsCacheTs < 300_000) return _omniToolsCache;
  try {
    const { status, body } = await httpFetch(OMNI_MCP, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'list-1', method: 'tools/list', params: {} }),
    });
    if (status >= 400) return [];
    const tools = (body?.result?.tools || []).map(t => ({
      ...t,
      name: 'omni_' + t.name,
      _isOmni: true,
      _omniOriginalName: t.name,
    }));
    _omniToolsCache = tools;
    _omniToolsCacheTs = Date.now();
    return tools;
  } catch (e) {
    console.error('[mcp-server] Omni tools/list failed:', e.message);
    return [];
  }
}

async function callOmniTool(originalName, args) {
  const token = process.env.OMNI_AGENT_API_KEY;
  if (!token) throw new Error('OMNI_AGENT_API_KEY not configured');
  const { status, body } = await httpFetch(OMNI_MCP, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `call-${Date.now()}`,
      method: 'tools/call',
      params: { name: originalName, arguments: args },
    }),
  });
  if (status >= 400) {
    return { ok: false, error: `Omni Agent MCP error ${status}`, status };
  }
  if (body && body.error) {
    return { ok: false, error: body.error.message || JSON.stringify(body.error), code: body.error.code };
  }
  return body?.result ?? body;
}

// ── Proxy callTool ─────────────────────────────────────────────────────────────
//
// Rules:
//   - :param tokens in path → replaced from args; those arg keys are "used in path"
//   - GET: remaining args → query string; filtered by queryParams if defined
//   - POST/PUT/PATCH: remaining args → body; filtered by bodyParams if defined
//   - envQuery(env) → extra query params injected from environment
//   - envBody(env)  → extra body params injected from environment
//   - 'confirmed' arg is always stripped (never forwarded)
//   - Non-2xx upstream → { ok: false, error, status } instead of throwing
//
async function callTool(toolDef, args) {
  const env = process.env;

  // 1. Substitute :param tokens from args into path
  let urlPath = toolDef.path;
  const usedInPath = new Set();
  urlPath = urlPath.replace(/:([a-zA-Z_]+)/g, (_, key) => {
    usedInPath.add(key);
    const val = args[key];
    if (val === undefined || val === null) {
      throw new Error(`Missing required path parameter: ${key}`);
    }
    return encodeURIComponent(String(val));
  });

  const fullUrl = new URL(toolDef.baseUrl + urlPath);

  // Collect remaining args (not used in path, not 'confirmed')
  const remaining = {};
  for (const [k, v] of Object.entries(args)) {
    if (!usedInPath.has(k) && k !== 'confirmed' && v !== undefined && v !== null) {
      remaining[k] = v;
    }
  }

  const headers = { ...toolDef.authHeader(env) };
  let fetchBody = undefined;

  // GET requests have no body — Content-Type confuses some APIs (e.g. Storista returns JSON Decode Error)
  if (toolDef.method === 'GET') delete headers['Content-Type'];

  if (toolDef.method === 'GET') {
    // Env-sourced query params
    const envQ = toolDef.envQuery ? toolDef.envQuery(env) : {};
    for (const [k, v] of Object.entries(envQ)) {
      if (v !== undefined && v !== null && v !== '') {
        fullUrl.searchParams.set(k, String(v));
      }
    }
    // Remaining args → query string (filtered by queryParams if defined)
    const qp = toolDef.queryParams; // undefined = all, [] = none, ['a'] = specific
    for (const [k, v] of Object.entries(remaining)) {
      if (qp === undefined || qp.includes(k)) {
        fullUrl.searchParams.set(k, String(v));
      }
    }
  } else {
    // POST / PUT / PATCH / DELETE — build body
    const body = {};
    // Env-sourced body params
    const envB = toolDef.envBody ? toolDef.envBody(env) : {};
    Object.assign(body, envB);
    // Remaining args → body (filtered by bodyParams if defined)
    const bp = toolDef.bodyParams; // undefined = all, [] = none, ['a'] = specific
    for (const [k, v] of Object.entries(remaining)) {
      if (bp === undefined || bp.includes(k)) {
        body[k] = v;
      }
    }
    fetchBody = JSON.stringify(body);
  }

  const { status, body: respBody } = await httpFetch(fullUrl.toString(), {
    method: toolDef.method,
    headers,
    body: fetchBody,
  });

  if (status >= 400) {
    const errText = typeof respBody === 'string'
      ? respBody.slice(0, 300)
      : JSON.stringify(respBody).slice(0, 300);
    return { ok: false, error: `Upstream error ${status}: ${errText}`, status };
  }
  return respBody;
}

// ── Pending confirmations ─────────────────────────────────────────────────────
// Key: `${userId}:${toolName}`, value: { args, expiresAt }
const PENDING_CONFIRMS = new Map();

function buildConfirmSummary(toolDef, args) {
  const argStr = Object.entries(args)
    .filter(([k]) => k !== 'confirmed')
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ');
  return `Will call ${toolDef.name}(${argStr})`;
}

// ── MCP JSON-RPC handler ──────────────────────────────────────────────────────
function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function toolPublicShape(tool) {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

async function handleRequest(rpcReq, user) {
  const { method, id, params } = rpcReq;

  if (id === undefined || id === null) return null; // notification — no response

  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cultcontent', version: '2.0.0' },
    });
  }

  if (method === 'ping') return jsonRpcResult(id, {});

  if (method === 'tools/list') {
    const perms = user.permissions || [];
    const staticTools = TOOLS.filter(t => perms.includes(t.platform)).map(toolPublicShape);

    let bufferTools = [];
    if (perms.includes('buffer') && process.env.BUFFER_ACCESS_TOKEN) {
      try { bufferTools = (await getBufferTools()).map(toolPublicShape); }
      catch (e) { console.error('[mcp-server] Buffer tools fetch error:', e.message); }
    }

    let omniTools = [];
    if (perms.includes('omni') && process.env.OMNI_AGENT_API_KEY) {
      try { omniTools = (await getOmniTools()).map(toolPublicShape); }
      catch (e) { console.error('[mcp-server] Omni tools fetch error:', e.message); }
    }

    return jsonRpcResult(id, { tools: [...staticTools, ...bufferTools, ...omniTools] });
  }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};

    // ── Omni Agent tool ──────────────────────────────────────────────────────
    if (typeof name === 'string' && name.startsWith('omni_')) {
      const perms = user.permissions || [];
      if (!perms.includes('omni')) {
        return jsonRpcError(id, -32603, 'Permission denied: omni platform access required');
      }
      const start = Date.now();
      try {
        const cached = _omniToolsCache && _omniToolsCache.find(t => t.name === name);
        const originalName = cached ? cached._omniOriginalName : name.slice('omni_'.length);
        const result = await callOmniTool(originalName, args);
        auditLog(user.email || user.username, name, true, Date.now() - start);
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return jsonRpcResult(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        auditLog(user.email || user.username, name, false, Date.now() - start);
        return jsonRpcError(id, -32603, err.message || 'Omni Agent tool call failed');
      }
    }

    // ── Buffer tool ──────────────────────────────────────────────────────────
    if (typeof name === 'string' && name.startsWith('buffer_')) {
      const perms = user.permissions || [];
      if (!perms.includes('buffer')) {
        return jsonRpcError(id, -32603, 'Permission denied: buffer platform access required');
      }
      const start = Date.now();
      try {
        // Find original name from cache (if loaded) or strip prefix
        const cached = _bufferToolsCache && _bufferToolsCache.find(t => t.name === name);
        const originalName = cached ? cached._bufferOriginalName : name.slice('buffer_'.length);
        const result = await callBufferTool(originalName, args);
        auditLog(user.email || user.username, name, true, Date.now() - start);
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return jsonRpcResult(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        auditLog(user.email || user.username, name, false, Date.now() - start);
        return jsonRpcError(id, -32603, err.message || 'Buffer tool call failed');
      }
    }

    // ── Static tool ──────────────────────────────────────────────────────────
    const toolDef = TOOLS.find(t => t.name === name);
    if (!toolDef) return jsonRpcError(id, -32601, `Unknown tool: ${name}`);

    const perms = user.permissions || [];
    if (!perms.includes(toolDef.platform)) {
      return jsonRpcError(id, -32603, `Permission denied: ${toolDef.platform} platform access required`);
    }

    // Confirmation gate
    const confirmKey = `${user.id}:${name}`;
    if (toolDef.confirm) {
      if (!args.confirmed) {
        // First call: generate summary and store pending confirmation
        const summary = buildConfirmSummary(toolDef, args);
        PENDING_CONFIRMS.set(confirmKey, { args, expiresAt: Date.now() + 60_000 });
        // Auto-cleanup after 70s
        setTimeout(() => {
          const p = PENDING_CONFIRMS.get(confirmKey);
          if (p) PENDING_CONFIRMS.delete(confirmKey);
        }, 70_000);
        const text = `⚠️ Confirmation required\n\n${summary}\n\nTo proceed, call ${name} again with confirmed: true (within 60 seconds).`;
        return jsonRpcResult(id, { content: [{ type: 'text', text }] });
      } else {
        // Second call: verify pending confirmation exists and hasn't expired
        const pending = PENDING_CONFIRMS.get(confirmKey);
        if (!pending || Date.now() > pending.expiresAt) {
          PENDING_CONFIRMS.delete(confirmKey);
          return jsonRpcError(id, -32603, 'Confirmation expired or not found. Call without confirmed: true first.');
        }
        PENDING_CONFIRMS.delete(confirmKey);
        // Fall through to execute
      }
    }

    const start = Date.now();
    try {
      const result = await callTool(toolDef, args);
      const ms = Date.now() - start;
      auditLog(user.email || user.username, name, true, ms);
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return jsonRpcResult(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      const ms = Date.now() - start;
      auditLog(user.email || user.username, name, false, ms);
      return jsonRpcError(id, -32603, err.message || 'Tool execution failed');
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

// ── Mount ─────────────────────────────────────────────────────────────────────
module.exports = function registerMcpServer(app, deps = {}) {
  const express = deps.express || require('express');
  const jsonBody = express.json({ limit: '1mb' });

  function mcpAuth(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    const resolved = resolveToken(authHeader);
    if (!resolved) {
      return res.status(401).json({
        error: 'Invalid or missing MCP bearer token. Issue one at /api/mcp/token.',
      });
    }
    req.mcpUser = resolved.user;
    req.mcpToken = resolved.tokenRecord;
    next();
  }

  // POST /mcp — main JSON-RPC endpoint
  app.post('/mcp', jsonBody, mcpAuth, async (req, res) => {
    const body = req.body;
    if (!body) return res.status(400).json(jsonRpcError(null, -32700, 'Parse error'));

    if (Array.isArray(body)) {
      const responses = [];
      for (const rpc of body) {
        const r = await handleRequest(rpc, req.mcpUser);
        if (r !== null) responses.push(r);
      }
      return res.json(responses.length === 1 ? responses[0] : responses);
    }

    const response = await handleRequest(body, req.mcpUser);
    if (response === null) return res.status(202).end();
    return res.json(response);
  });

  // GET /mcp — Streamable HTTP probe
  app.get('/mcp', (req, res) => {
    res.set('Allow', 'POST').status(405).json({ error: 'Use POST for MCP requests' });
  });

  // DELETE /mcp — session cleanup (stateless — no-op)
  app.delete('/mcp', mcpAuth, (req, res) => { res.json({ ok: true }); });

  console.log('[mcp-server] registered — POST /mcp (platform-proxy architecture)');
};
