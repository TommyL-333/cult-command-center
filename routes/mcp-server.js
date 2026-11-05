/**
 * routes/mcp-server.js — Cult Content Command Center MCP Server ("the door")
 *
 * Implements the MCP Streamable HTTP transport (JSON-RPC 2.0 over POST /mcp).
 * Each team member authenticates with a per-user bearer token issued from
 * /api/mcp/token (routes/mcp-admin.js). The token is hashed, looked up in
 * DATA_DIR/mcp-tokens.json, and the matching portal user is attached as
 * req.mcpUser.
 *
 * Tools are declared in TOOLS[] and filtered per-caller based on the
 * permission field. tools/list only shows tools the caller has access to.
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
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));

const TOKENS_FILE = path.join(DATA_DIR, 'mcp-tokens.json');
const USERS_FILE  = path.join(DATA_DIR, 'portal-users.json');
const AUDIT_FILE  = path.join(DATA_DIR, 'mcp-audit.jsonl');
const AUDIT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

const { scryptVerify } = require('../middleware/password');

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
    // Rotate if over 50 MB
    try {
      const stat = fs.statSync(AUDIT_FILE);
      if (stat.size >= AUDIT_MAX_BYTES) {
        fs.renameSync(AUDIT_FILE, AUDIT_FILE + '.1');
      }
    } catch (_) { /* file doesn't exist yet */ }
    fs.appendFileSync(AUDIT_FILE, line);
  } catch (e) {
    console.error('[mcp-audit] write failed:', e.message);
  }
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
    // matched — find the user
    const user = users.find(u => u.id === tok.userId);
    if (!user || !user.active) continue;
    if (!Array.isArray(user.permissions) || !user.permissions.includes('mcp_access')) continue;
    // update lastUsedAt
    tok.lastUsedAt = Date.now();
    try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2)); } catch (_) {}
    return { user, tokenRecord: tok };
  }
  return null;
}

// ── Tool registry ─────────────────────────────────────────────────────────────
const REACHER_BASE = 'https://api.reacherapp.com/public/v1';
const GHL_BASE = 'https://services.leadconnectorhq.com';

function reacherHeaders() {
  return {
    'x-api-key': process.env.REACHER_API_KEY || '',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}
function ghlHeaders() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY || ''}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function httpFetch(url, opts = {}) {
  // Use native fetch (Node 18+) or fall back to https module
  if (typeof fetch !== 'undefined') {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; }
    catch { return { status: r.status, body: text }; }
  }
  // https fallback
  return new Promise((resolve, reject) => {
    const { https } = require('https');
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

const TOOLS = [
  // ── Creator data ─────────────────────────────────────────────────────────────
  {
    name: 'reacher_list_creators',
    description: 'List creators on a Reacher shop roster. Pass shopId to scope to one shop. Read-only.',
    permission: 'tools_creator_data',
    inputSchema: {
      type: 'object',
      properties: {
        shopId: { type: 'string', description: 'Reacher shop ID to list creators for' },
        limit:  { type: 'number', description: 'Max results to return (default 50)', default: 50 },
        page:   { type: 'number', description: 'Page number (default 1)', default: 1 },
      },
      required: [],
    },
    handler: async (args, ctx) => {
      const { shopId, limit = 50, page = 1 } = args;
      const path = shopId
        ? `/shops/${shopId}/creators?limit=${limit}&page=${page}`
        : `/creators?limit=${limit}&page=${page}`;
      const { status, body } = await httpFetch(`${REACHER_BASE}${path}`, {
        method: 'GET',
        headers: reacherHeaders(),
      });
      if (status >= 400) throw new Error(`Reacher API error ${status}: ${JSON.stringify(body)}`);
      return body;
    },
  },

  {
    name: 'reacher_creator_detail',
    description: 'Get full detail for a single Reacher creator by ID.',
    permission: 'tools_creator_data',
    inputSchema: {
      type: 'object',
      properties: {
        shopId:    { type: 'string', description: 'Reacher shop ID' },
        creatorId: { type: 'string', description: 'Creator ID' },
      },
      required: ['creatorId'],
    },
    handler: async (args, ctx) => {
      const { shopId, creatorId } = args;
      const urlPath = shopId
        ? `/shops/${shopId}/creators/${creatorId}`
        : `/creators/${creatorId}`;
      const { status, body } = await httpFetch(`${REACHER_BASE}${urlPath}`, {
        method: 'GET',
        headers: reacherHeaders(),
      });
      if (status >= 400) throw new Error(`Reacher API error ${status}: ${JSON.stringify(body)}`);
      return body;
    },
  },

  // ── CRM ───────────────────────────────────────────────────────────────────────
  {
    name: 'ghl_search_contacts',
    description: 'Search GoHighLevel contacts by name, email, or phone. Returns matching contacts.',
    permission: 'tools_crm',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term (name, email, or phone)' },
        limit: { type: 'number', description: 'Max results (default 20)', default: 20 },
      },
      required: ['query'],
    },
    handler: async (args, ctx) => {
      const { query, limit = 20 } = args;
      const locationId = process.env.GHL_LOCATION_ID || process.env.GHL_LOC_ID || '';
      const url = `${GHL_BASE}/contacts/?locationId=${encodeURIComponent(locationId)}&query=${encodeURIComponent(query)}&limit=${limit}`;
      const { status, body } = await httpFetch(url, {
        method: 'GET',
        headers: ghlHeaders(),
      });
      if (status >= 400) throw new Error(`GHL API error ${status}: ${JSON.stringify(body)}`);
      return body;
    },
  },

  {
    name: 'ghl_contact_detail',
    description: 'Get full detail for a single GoHighLevel contact by ID.',
    permission: 'tools_crm',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'GHL contact ID' },
      },
      required: ['contactId'],
    },
    handler: async (args, ctx) => {
      const { contactId } = args;
      const { status, body } = await httpFetch(`${GHL_BASE}/contacts/${contactId}`, {
        method: 'GET',
        headers: ghlHeaders(),
      });
      if (status >= 400) throw new Error(`GHL API error ${status}: ${JSON.stringify(body)}`);
      return body;
    },
  },

  // ── Content ───────────────────────────────────────────────────────────────────
  {
    name: 'storista_schedule_post',
    description: 'Schedule a social post via Storista. First call returns a summary for confirmation. Pass confirmed: true to actually post.',
    permission: 'tools_content',
    confirm: true,
    inputSchema: {
      type: 'object',
      properties: {
        caption:   { type: 'string', description: 'Post caption text' },
        mediaUrl:  { type: 'string', description: 'URL of media to post' },
        platforms: {
          type: 'array',
          items: { type: 'string' },
          description: 'Platforms to post to (e.g. ["instagram", "tiktok"])',
        },
        scheduleAt: { type: 'string', description: 'ISO 8601 datetime to schedule (omit for immediate)' },
        confirmed:  { type: 'boolean', description: 'Set to true to confirm and actually post', default: false },
      },
      required: ['caption', 'platforms'],
    },
    handler: async (args, ctx) => {
      const { caption, mediaUrl, platforms, scheduleAt, confirmed } = args;
      if (!confirmed) {
        const when = scheduleAt ? `at ${scheduleAt}` : 'immediately';
        const summary = `Will post to ${(platforms || []).join(', ')} ${when}.\nCaption: "${(caption || '').slice(0, 120)}${caption && caption.length > 120 ? '…' : ''}"`;
        return { _requiresConfirmation: true, summary };
      }
      // Actual post
      const STORISTA_KEY = process.env.STORISTA_API_KEY;
      if (!STORISTA_KEY) throw new Error('STORISTA_API_KEY not configured');
      const { status, body } = await httpFetch('https://app.storista.io/api/v1/posts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STORISTA_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ caption, mediaUrl, platforms, scheduleAt }),
      });
      if (status >= 400) throw new Error(`Storista API error ${status}: ${JSON.stringify(body)}`);
      return body;
    },
  },

  {
    name: 'omni_agent_generate',
    description: 'Generate content using the Omni Agent (stub — API shape not yet defined).',
    permission: 'tools_content',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Content generation prompt' },
      },
      required: ['prompt'],
    },
    handler: async (args, ctx) => {
      return { ok: false, error: 'Omni Agent API shape not yet defined — check back soon.' };
    },
  },
];

// ── MCP JSON-RPC handler ──────────────────────────────────────────────────────
function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function toolsForUser(user) {
  const perms = user.permissions || [];
  return TOOLS.filter(t => perms.includes(t.permission));
}

function toolPublicShape(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

async function handleRequest(rpcReq, user) {
  const { method, id, params } = rpcReq;

  // Notifications (no id) — just acknowledge
  if (id === undefined || id === null) {
    return null; // no response for notifications
  }

  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cultcontent', version: '1.0.0' },
    });
  }

  if (method === 'ping') {
    return jsonRpcResult(id, {});
  }

  if (method === 'tools/list') {
    const tools = toolsForUser(user).map(toolPublicShape);
    return jsonRpcResult(id, { tools });
  }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) return jsonRpcError(id, -32601, `Unknown tool: ${name}`);

    const perms = user.permissions || [];
    if (!perms.includes(tool.permission)) {
      return jsonRpcError(id, -32603, `Permission denied: ${tool.permission} required`);
    }

    const start = Date.now();
    let ok = false;
    try {
      const ctx = {
        user,
        log: (msg) => console.log(`[mcp] ${user.email || user.username} / ${name}: ${msg}`),
      };
      const result = await tool.handler(args, ctx);
      ok = true;
      const ms = Date.now() - start;
      auditLog(user.email || user.username, name, true, ms);

      // Handle confirm: true pattern
      if (result && result._requiresConfirmation) {
        const text = `⚠️ Confirmation required\n\n${result.summary}\n\nTo proceed, call ${name} again with confirmed: true.`;
        return jsonRpcResult(id, { content: [{ type: 'text', text }] });
      }

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

  // Auth middleware for /mcp
  function mcpAuth(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    const resolved = resolveToken(authHeader);
    if (!resolved) {
      return res.status(401).json({ error: 'Invalid or missing MCP bearer token. Issue one at /api/mcp/token.' });
    }
    req.mcpUser = resolved.user;
    req.mcpToken = resolved.tokenRecord;
    next();
  }

  // POST /mcp — main JSON-RPC endpoint
  app.post('/mcp', jsonBody, mcpAuth, async (req, res) => {
    const body = req.body;
    if (!body) return res.status(400).json(jsonRpcError(null, -32700, 'Parse error'));

    // Batch or single
    if (Array.isArray(body)) {
      const responses = [];
      for (const rpc of body) {
        const r = await handleRequest(rpc, req.mcpUser);
        if (r !== null) responses.push(r);
      }
      return res.json(responses.length === 1 ? responses[0] : responses);
    }

    const response = await handleRequest(body, req.mcpUser);
    if (response === null) return res.status(202).end(); // notification ACK
    return res.json(response);
  });

  // GET /mcp — required for Streamable HTTP (SSE capabilities probe)
  app.get('/mcp', (req, res) => {
    // Respond with 405 — we support POST only (no SSE push needed for this use case)
    res.set('Allow', 'POST').status(405).json({ error: 'Use POST for MCP requests' });
  });

  // DELETE /mcp — session cleanup (no-op for stateless implementation)
  app.delete('/mcp', mcpAuth, (req, res) => {
    res.json({ ok: true });
  });

  console.log('[mcp-server] registered — POST /mcp');
};
