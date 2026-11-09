/**
 * routes/mcp-admin.js — MCP token + permission management API
 *
 * Routes:
 *   GET  /api/mcp/me            — requireAuth — current user's MCP status
 *   POST /api/mcp/token         — requireAuth — issue (or reissue) a bearer token
 *   DELETE /api/mcp/token       — requireAuth — revoke token
 *   GET  /api/mcp/users         — admin only  — all portal users + MCP status
 *   PATCH /api/mcp/users/:id/permissions — admin only — toggle one permission
 *   GET  /api/mcp/audit         — admin only  — tail audit log
 *
 * Mount (after requireAuth is established, alongside portal-team-auth):
 *   try { require('./routes/mcp-admin')(app, { express, requireAuth }); }
 *   catch (e) { console.error('[mcp-admin] registration failed:', e.message); }
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

const { scryptHash } = require('../middleware/password');

// Admins who can manage MCP permissions for others.
// Same pattern as ADMIN_EMAILS in ops-my-tasks.js.
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || 'tommy@cultcontent.cc')
    .split(',')
    .map(s => s.trim().toLowerCase())
);

// Hard-coded extra admins matching ops-my-tasks.js
['tommy@cultcontent.cc', 'tommy@organicsocialmarketing.com', 'daniel@cultcontent.cc'].forEach(e => ADMIN_EMAILS.add(e));

// ── JSON file helpers ─────────────────────────────────────────────────────────
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}
function writeJson(file, data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) { console.error('[mcp-admin] write failed:', e.message); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function callerEmail(req) {
  return (req.userEmail || (req.session && req.session.portalUserEmail) || '').toLowerCase();
}
function isAdmin(req) {
  const email = callerEmail(req);
  return !!(req.session && req.session.isPortalAdmin) || ADMIN_EMAILS.has(email);
}
function findCaller(req) {
  // Try email first, fall back to portalUserId for users without an email field
  const email = callerEmail(req);
  const users = readJson(USERS_FILE, []);
  if (email) {
    const byEmail = users.find(u => (u.email || '').toLowerCase() === email || (u.username || '').toLowerCase() === email);
    if (byEmail) return byEmail;
  }
  const uid = req.session && req.session.portalUserId;
  if (uid) return users.find(u => u.id === uid) || null;
  return null;
}
function getOrCreateCaller(req) {
  // For CF Access / Google SSO users who are authenticated but have no portal account yet,
  // auto-create a minimal portal record so they can connect to the MCP server.
  const existing = findCaller(req);
  if (existing) return existing;
  const email = callerEmail(req);
  if (!email) return null;
  const users = readJson(USERS_FILE, []);
  const newUser = {
    id: crypto.randomBytes(8).toString('hex'),
    email,
    username: email,
    name: email.split('@')[0],
    permissions: ['mcp_access'],
    active: true,
    createdAt: Date.now(),
    createdBy: 'mcp-auto',
  };
  users.push(newUser);
  writeJson(USERS_FILE, users);
  console.log('[mcp-admin] auto-created portal record for', email);
  return newUser;
}
function findUserByEmail(email) {
  const users = readJson(USERS_FILE, []);
  const e = (email || '').toLowerCase();
  return users.find(u => (u.email || '').toLowerCase() === e || (u.username || '').toLowerCase() === e) || null;
}
function findUserById(id) {
  const users = readJson(USERS_FILE, []);
  return users.find(u => u.id === id) || null;
}
function getTokenForUser(userId) {
  const tokens = readJson(TOKENS_FILE, []);
  return tokens.find(t => t.userId === userId && !t.revokedAt) || null;
}
function publicUser(u) {
  if (!u) return null;
  const { passwordHash, salt, ...rest } = u;
  return rest;
}

// ── Mount ─────────────────────────────────────────────────────────────────────
module.exports = function registerMcpAdmin(app, deps = {}) {
  const express = deps.express || require('express');
  const requireAuth = deps.requireAuth || ((req, res, next) => {
    const email = req.userEmail || (req.session && req.session.portalUserEmail);
    if (email || (req.session && req.session.isPortalAdmin)) return next();
    return res.status(401).json({ error: 'Authentication required' });
  });
  const jsonBody = express.json();

  // ── GET /api/mcp/me ──────────────────────────────────────────────────────────
  app.get('/api/mcp/me', requireAuth, (req, res) => {
    try {
      const email = callerEmail(req);
      const isAdmin = ADMIN_EMAILS.has(email);
      const user = getOrCreateCaller(req);
      if (!user) return res.json({ connected: false, permissions: [], setupCommand: null, hasMcpAccess: false });

      // All portal users get mcp_access — grant it persistently if missing
      if (!(user.permissions || []).includes('mcp_access')) {
        const users = readJson(USERS_FILE, []);
        const idx = users.findIndex(u => u.id === user.id);
        if (idx >= 0) {
          if (!users[idx].permissions) users[idx].permissions = [];
          users[idx].permissions.push('mcp_access');
          writeJson(USERS_FILE, users);
          user.permissions = users[idx].permissions;
        }
      }

      const tok = getTokenForUser(user.id);
      const connected = !!(tok);
      const PLATFORM_PERMS = ['mcp_access', 'reacher', 'ghl', 'buffer', 'storista', 'discord'];
      const perms = (user.permissions || []).filter(p => PLATFORM_PERMS.includes(p));
      const setupCommand = connected
        ? `claude mcp add --transport http cultcontent https://manifest.cultcontent.cc/mcp --header "Authorization: Bearer <your-token>"`
        : null;

      res.json({
        connected,
        lastUsedAt: tok ? tok.lastUsedAt : null,
        permissions: perms,
        setupCommand,
        hasMcpAccess: (user.permissions || []).includes('mcp_access'),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/mcp/token ───────────────────────────────────────────────────────
  app.post('/api/mcp/token', requireAuth, (req, res) => {
    try {
      const email = callerEmail(req);
      const admin = ADMIN_EMAILS.has(email);
      const user = getOrCreateCaller(req);
      if (!user) return res.status(404).json({ error: 'Portal user not found — no authenticated email in session' });
      // mcp_access is granted to all portal users — no gate needed

      // Generate token
      const rawToken = 'ccmcp_' + crypto.randomBytes(32).toString('base64url');
      const { hash: tokenHash, salt } = scryptHash(rawToken);

      // Load tokens, revoke any existing active token for this user
      const tokens = readJson(TOKENS_FILE, []);
      tokens.forEach(t => {
        if (t.userId === user.id && !t.revokedAt) t.revokedAt = Date.now();
      });

      const record = {
        id: crypto.randomBytes(8).toString('hex'),
        userId: user.id,
        tokenHash,
        salt,
        createdAt: Date.now(),
        lastUsedAt: null,
        revokedAt: null,
      };
      tokens.push(record);
      writeJson(TOKENS_FILE, tokens);

      const setupCommand = `claude mcp add --transport http cultcontent https://manifest.cultcontent.cc/mcp --header "Authorization: Bearer ${rawToken}"`;
      res.json({ token: rawToken, setupCommand });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── DELETE /api/mcp/token ────────────────────────────────────────────────────
  app.delete('/api/mcp/token', requireAuth, (req, res) => {
    try {
      const email = callerEmail(req);
      const user = findUserByEmail(email);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const tokens = readJson(TOKENS_FILE, []);
      let revoked = 0;
      tokens.forEach(t => {
        if (t.userId === user.id && !t.revokedAt) { t.revokedAt = Date.now(); revoked++; }
      });
      writeJson(TOKENS_FILE, tokens);
      res.json({ ok: true, revoked });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/mcp/users — admin only ──────────────────────────────────────────
  app.get('/api/mcp/users', requireAuth, (req, res) => {
    try {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
      const users = readJson(USERS_FILE, []);
      const tokens = readJson(TOKENS_FILE, []);

      const result = users.map(u => {
        const tok = tokens.find(t => t.userId === u.id && !t.revokedAt);
        return {
          ...publicUser(u),
          mcp: {
            connected: !!(tok),
            lastUsedAt: tok ? tok.lastUsedAt : null,
            tokenId: tok ? tok.id : null,
          },
        };
      });
      res.json({ users: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── PATCH /api/mcp/users/:id/permissions — admin only ────────────────────────
  app.patch('/api/mcp/users/:id/permissions', requireAuth, jsonBody, (req, res) => {
    try {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
      const { permission, enabled } = req.body || {};
      if (!permission) return res.status(400).json({ error: 'permission required' });
      if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) required' });

      const users = readJson(USERS_FILE, []);
      const idx = users.findIndex(u => u.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'User not found' });

      const u = users[idx];
      const perms = Array.isArray(u.permissions) ? [...u.permissions] : [];
      if (enabled && !perms.includes(permission)) {
        perms.push(permission);
      } else if (!enabled) {
        const pi = perms.indexOf(permission);
        if (pi !== -1) perms.splice(pi, 1);
      }
      u.permissions = perms;
      users[idx] = u;
      writeJson(USERS_FILE, users);
      res.json({ ok: true, user: publicUser(u) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/mcp/audit — admin only ──────────────────────────────────────────
  app.get('/api/mcp/audit', requireAuth, (req, res) => {
    try {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
      const { user: filterUser, limit: rawLimit } = req.query;
      const limit = Math.min(parseInt(rawLimit, 10) || 50, 500);

      let lines = [];
      try {
        if (fs.existsSync(AUDIT_FILE)) {
          const content = fs.readFileSync(AUDIT_FILE, 'utf8');
          lines = content.split('\n').filter(Boolean).map(l => {
            try { return JSON.parse(l); } catch { return null; }
          }).filter(Boolean);
        }
      } catch (_) {}

      if (filterUser) {
        lines = lines.filter(l => l.user === filterUser);
      }

      // Return most recent first
      lines = lines.slice(-limit).reverse();
      res.json({ entries: lines, total: lines.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/mcp/admin/revoke/:userId — admin revokes another user's token ──
  app.post('/api/mcp/admin/revoke/:userId', requireAuth, (req, res) => {
    try {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
      const tokens = readJson(TOKENS_FILE, []);
      let revoked = 0;
      tokens.forEach(t => {
        if (t.userId === req.params.userId && !t.revokedAt) { t.revokedAt = Date.now(); revoked++; }
      });
      writeJson(TOKENS_FILE, tokens);
      res.json({ ok: true, revoked });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log('[mcp-admin] registered');
};
