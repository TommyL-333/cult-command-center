// portal-team-auth.js — per-user team login for the Cult Content admin portal.
//
// Mounts a PARALLEL login path alongside the existing shared-password
// POST /portal-admin/login. The legacy shared-password login is left UNTOUCHED
// and keeps working. This route lets named team members (Danny, Hasan, etc.)
// log in with their OWN credentials and sets the SAME req.session.isPortalAdmin
// flag the rest of the portal already gates on — so no other route changes.
//
// Mount (one line, before app.use(requireAuth), near the other route mounts
// ~line 1207-1221 in dashboard-server.js):
//   try { require('./routes/portal-team-auth')(app, { express }); }
//   catch (e) { console.error('[portal-team-auth] registration failed:', e.message); }
//
// Storage (persistent volume, survives redeploy):
//   DATA_DIR/portal-users.json        — team accounts (scrypt-hashed)
//   DATA_DIR/portal-user-sessions.json — token -> { userId, createdAt } (unused
//                                        for portal since express-session carries
//                                        auth, kept for parity/audit)
//
// This is INTENTIONALLY self-contained (no cross-dir require) so it drops into
// the cult-command-center repo cleanly.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const USERS_FILE = path.join(DATA_DIR, 'portal-users.json');

const ALL_PERMISSIONS = [
  'admin_portal',    // /portal-admin/*
  'client_portal',   // impersonate / view client portal
  'inner_circle',    // inner circle admin
  'billing',         // financials / invoicing
  'user_admin',      // manage other portal users
];

// ── low-level json io ────────────────────────────────────────────────────────
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
  } catch (e) { console.error('[portal-team-auth] write failed:', e.message); }
}

// ── password hashing (scrypt, no deps) ───────────────────────────────────────
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(candidate, hash, salt) {
  try {
    const c = crypto.scryptSync(String(candidate), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(c, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}

// ── users ────────────────────────────────────────────────────────────────────
function loadUsers() { return readJson(USERS_FILE, []); }
function saveUsers(u) { writeJson(USERS_FILE, u); }
function publicUser(u) { if (!u) return null; const { passwordHash, salt, ...rest } = u; return rest; }

function findByUsername(username) {
  if (!username) return null;
  const uname = String(username).trim().toLowerCase();
  return loadUsers().find(u => u.username?.toLowerCase() === uname || u.email?.toLowerCase() === uname) || null;
}
function findById(id) { return loadUsers().find(u => u.id === id) || null; }

function createUser({ username, email, name, password, role = 'member', permissions, createdBy }) {
  const users = loadUsers();
  const uname = String(username || email || '').trim().toLowerCase();
  if (!uname) throw new Error('username or email required');
  if (!password || password.length < 6) throw new Error('password must be at least 6 characters');
  if (users.some(u => u.username?.toLowerCase() === uname || u.email?.toLowerCase() === uname)) {
    throw new Error('a user with that username/email already exists');
  }
  const { hash, salt } = hashPassword(password);
  const perms = (permissions === 'full' || !permissions) ? ALL_PERMISSIONS.slice() : permissions;
  const user = {
    id: crypto.randomBytes(8).toString('hex'),
    username: uname,
    email: email || null,
    name: name || username,
    passwordHash: hash,
    salt,
    role,
    permissions: perms,
    active: true,
    createdAt: Date.now(),
    createdBy: createdBy || 'system',
  };
  users.push(user);
  saveUsers(users);
  return publicUser(user);
}

function updateUser(id, patch) {
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error('user not found');
  const u = users[idx];
  if (patch.name !== undefined) u.name = patch.name;
  if (patch.email !== undefined) u.email = patch.email;
  if (patch.role !== undefined) u.role = patch.role;
  if (patch.permissions !== undefined) u.permissions = patch.permissions === 'full' ? ALL_PERMISSIONS.slice() : patch.permissions;
  if (patch.active !== undefined) u.active = !!patch.active;
  if (patch.password) { const { hash, salt } = hashPassword(patch.password); u.passwordHash = hash; u.salt = salt; }
  users[idx] = u;
  saveUsers(users);
  return publicUser(u);
}

function authenticate(username, password) {
  const u = findByUsername(username);
  if (!u || !u.active) return null;
  if (!verifyPassword(password, u.passwordHash, u.salt)) return null;
  return u;
}

// ── mount ─────────────────────────────────────────────────────────────────────
module.exports = function mountPortalTeamAuth(app, deps = {}) {
  const express = deps.express || require('express');
  const jsonMw = express.json();

  // Bootstrap: seed an owner account from PORTAL_ADMIN_PASSWORD on first load,
  // so there's always at least one named account that mirrors the legacy gate.
  try {
    if (loadUsers().length === 0 && process.env.PORTAL_ADMIN_PASSWORD) {
      createUser({
        username: 'tommy',
        email: 'tommy@cultcontent.cc',
        name: 'Tommy Lynch',
        password: process.env.PORTAL_ADMIN_PASSWORD,
        role: 'owner',
        permissions: 'full',
        createdBy: 'bootstrap',
      });
      console.log('[portal-team-auth] seeded owner account "tommy" from PORTAL_ADMIN_PASSWORD');
    }
  } catch (e) { console.error('[portal-team-auth] bootstrap:', e.message); }

  // admin gate helper — accepts an already-authenticated portal-admin session
  function requireUserAdmin(req, res, next) {
    if (!req.session?.isPortalAdmin) return res.status(401).json({ error: 'Not authenticated' });
    const u = req.session.portalUserId ? findById(req.session.portalUserId) : null;
    // legacy shared-password admins (no portalUserId) are treated as full owners
    if (u && !(Array.isArray(u.permissions) && u.permissions.includes('user_admin'))) {
      return res.status(403).json({ error: 'user_admin permission required' });
    }
    next();
  }

  // POST /portal-admin/team-login — per-user login (parallel to shared-password login)
  app.post('/portal-admin/team-login', jsonMw, (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const u = authenticate(username, password);
    if (!u) return res.status(401).json({ error: 'Invalid credentials.' });
    if (!(Array.isArray(u.permissions) && u.permissions.includes('admin_portal'))) {
      return res.status(403).json({ error: 'This account does not have admin portal access.' });
    }
    req.session.isPortalAdmin = true;
    req.session.portalUserId = u.id;
    req.session.portalUserName = u.name;
    res.json({ ok: true, user: publicUser(u) });
  });

  // GET /portal-admin/me — who am I
  app.get('/portal-admin/me', (req, res) => {
    if (!req.session?.isPortalAdmin) return res.status(401).json({ error: 'Not authenticated' });
    const u = req.session.portalUserId ? findById(req.session.portalUserId) : null;
    res.json({ ok: true, isPortalAdmin: true, user: publicUser(u), legacy: !u });
  });

  // ── user management (owner/user_admin only) ────────────────────────────────
  // GET /portal-admin/users — list
  app.get('/portal-admin/users', requireUserAdmin, (req, res) => {
    res.json({ ok: true, users: loadUsers().map(publicUser) });
  });

  // POST /portal-admin/users — create
  app.post('/portal-admin/users', requireUserAdmin, jsonMw, (req, res) => {
    try {
      const { username, email, name, password, role, permissions } = req.body || {};
      const createdBy = req.session.portalUserName || 'portal-admin';
      const u = createUser({ username, email, name, password, role, permissions, createdBy });
      res.json({ ok: true, user: u });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // PATCH /portal-admin/users/:id — update (role, permissions, active, password, name, email)
  app.patch('/portal-admin/users/:id', requireUserAdmin, jsonMw, (req, res) => {
    try { res.json({ ok: true, user: updateUser(req.params.id, req.body || {}) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  console.log('[portal-team-auth] mounted: /portal-admin/team-login, /me, /users');
  return { findByUsername, findById, createUser, updateUser, authenticate };
};
