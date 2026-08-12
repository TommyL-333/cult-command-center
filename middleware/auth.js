/**
 * middleware/auth.js — unified auth guards for the three staff/brand/creator
 * audiences that already exist in this app, moved verbatim out of
 * dashboard-server.js (Phase 3 of the platform rebuild: auth unification).
 *
 * This is a pure relocation, not a rewrite — same cookie/header/session
 * checks as before, same behavior. dashboard-server.js now does
 * `const { requireAuth, requireClientSession, requirePortalAdmin } =
 * require('./middleware/auth')` instead of defining these locally; every
 * existing call site (140+ in dashboard-server.js, plus every routes/*.js
 * file that receives these as injected deps) keeps working unchanged since
 * they all reference the same identifiers, just sourced from here now.
 *
 * NOT YET moved here (deliberate scoping, not an oversight — see the Phase 3
 * commit message for why): requireSqliteSession, the creator-portal guard
 * defined inside routes/inner-circle-sqlite.js. It's tightly coupled to that
 * file's session-token lookup and password-hashing logic; pulling it out
 * cleanly is a bigger, more security-sensitive change that deserves its own
 * focused pass rather than being folded into this mechanical extraction.
 *
 * ── requireAuth — staff, via Cloudflare Access ──────────────────────────────
 * Cloudflare Access injects CF-Access-Authenticated-User-Email on every
 * request. If CF_ACCESS_AUD is set, this is enforced — unauthenticated
 * requests get 401. No-ops in local dev (CF_ACCESS_AUD unset).
 *
 * ── requireClientSession — brand/client portal ──────────────────────────────
 * Checks req.session.clientBrandId (set on successful /client/login).
 *
 * ── requirePortalAdmin — staff portal-admin ─────────────────────────────────
 * Checks req.session.isPortalAdmin (set on successful /portal-admin login,
 * either the shared-password path or routes/portal-team-auth.js's per-user
 * login — both set the same session flag).
 */

const path = require('path');

const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || 'cultcontent.cc')
  .split(',').map(d => d.trim().toLowerCase());

function requireAuth(req, res, next) {
  // Skip auth in local dev (no CF_ACCESS_AUD configured)
  if (!process.env.CF_ACCESS_AUD) return next();
  if (req.path.startsWith('/api/')) console.log(`[auth] ${req.method} ${req.path} email=${req.headers['cf-access-authenticated-user-email']||'(none)'}`);

  const email = req.headers['cf-access-authenticated-user-email'];
  if (!email) {
    console.log(`[auth] BLOCKED ${req.method} ${req.path} — no CF Access header`);
    if (req.path.startsWith('/api/')) {
      // Plain text so both old and new JS parse attempts fail and surface the error
      return res.status(401).type('text').send('Session expired — please refresh the page');
    }
    return res.status(401).sendFile(path.join(__dirname, '..', 'dashboard', '401.html'));
  }

  const domain = email.split('@')[1]?.toLowerCase();
  if (!ALLOWED_DOMAINS.includes(domain)) {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ ok: false, error: `Access denied for ${email}` });
    }
    return res.status(403).send(`Access denied. ${email} is not authorized.`);
  }

  // Attach user email to request for downstream use
  req.userEmail = email;
  next();
}

function requireClientSession(req, res, next) {
  if (!req.session?.clientBrandId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    // Portal admin trying to reach /client pages without impersonating
    if (req.session?.isPortalAdmin) return res.redirect('/portal-admin/clients');
    return res.redirect('/client');
  }
  next();
}

function requirePortalAdmin(req, res, next) {
  if (!req.session?.isPortalAdmin) {
    if (req.path.startsWith('/api/') || req.path.startsWith('/portal-admin/clients') || req.path.startsWith('/portal-admin/impersonate') || req.path.startsWith('/portal-admin/open-collab')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.redirect('/portal-admin');
  }
  next();
}

// ── requireCreatorSession — creator portal (factory, not a ready-made guard) ─
// The real session lookup lives inside routes/inner-circle-sqlite.js's own
// closure (its prepared statements, its DB-availability flag) — that data-
// layer state stays where it already lives rather than being dragged in here.
// This factory centralizes the guard's actual request/response behavior (same
// shape as the three guards above) in one place; inner-circle-sqlite.js calls
// it once with its own session lookup and gets back the same
// `requireSqliteSession` it used to define inline, verbatim behavior.
function getCreatorSessionToken(req) {
  // Manual cookie parse — this server has no cookie-parser middleware.
  const cookieHeader = req.headers.cookie || '';
  const m = cookieHeader.match(/(?:^|;\s*)ic_session=([^;]+)/);
  if (m) return decodeURIComponent(m[1]);
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

function createRequireCreatorSession({ getSessionByToken, isUnavailable }) {
  return function requireCreatorSession(req, res, next) {
    if (isUnavailable && isUnavailable()) return res.status(503).json({ error: 'Inner Circle data layer unavailable' });
    const token = getCreatorSessionToken(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const row = getSessionByToken(token);
      if (!row) return res.status(401).json({ error: 'Session expired' });
      req.icCreator = row;
      next();
    } catch (e) {
      console.error('[auth] creator session check failed:', e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  };
}

// ── resolveIdentity / requireAnyIdentity — messaging/proposals (Phase 5) ────
// Messaging and the proposal/contract system span all three audiences (a
// creator and a brand negotiate in the same thread; staff can be participants
// too) — none of the four audience-specific guards above fit alone.
// resolveIdentity() is the one place this "who is this request" logic lives
// (creator session -> brand session -> staff portal-admin session -> bare
// CF-Access header); it backs both GET /api/me (soft — returns { type: null }
// rather than failing) and createRequireAnyIdentity (hard — 401s and attaches
// req.identity on success). Factory for the same reason
// createRequireCreatorSession is: the creator lookup lives in
// routes/inner-circle-sqlite.js's closure, not here.
function resolveIdentity(req, { getCreatorFromRequest, loadBrands }) {
  const creator = getCreatorFromRequest && getCreatorFromRequest(req);
  if (creator) {
    return { type: 'creator', id: creator.id, email: creator.email || null, name: creator.creator_name || null };
  }

  if (req.session?.clientBrandId) {
    const brand = (loadBrands().clients || []).find((b) => b.id === req.session.clientBrandId);
    return {
      type: 'brand',
      id: req.session.clientBrandId,
      email: brand ? (brand.loginEmail || brand.email || null) : null,
      name: brand ? brand.name || null : null,
    };
  }

  if (req.session?.isPortalAdmin) {
    // portalUserId is the strongest id (per-user team-login), but the
    // legacy shared-password /portal-admin/login path never sets it — for
    // that path, fall back to the CF-Access email as the id rather than
    // null. Two different staff members must never resolve to the same
    // `id` here: createRequireAnyIdentity below (used by messaging/
    // proposals) keys participants by String(id), and String(null) is the
    // same literal "null" for everyone, which would let unrelated staff
    // read/post in each other's threads. See routes/staff-portal.js's
    // currentStaffUser for the same portalUserId-then-email precedence.
    const cfEmail = req.headers['cf-access-authenticated-user-email'] || null;
    return {
      type: 'staff',
      id: req.session.portalUserId || cfEmail || null,
      email: cfEmail,
      name: req.session.portalUserName || null,
    };
  }

  const cfEmail = req.headers['cf-access-authenticated-user-email'];
  if (cfEmail) {
    return { type: 'staff', id: cfEmail, email: cfEmail, name: null };
  }

  return { type: null };
}

function createRequireAnyIdentity(deps) {
  return function requireAnyIdentity(req, res, next) {
    const identity = resolveIdentity(req, deps);
    if (!identity.type) return res.status(401).json({ error: 'Not authenticated' });
    // Belt-and-suspenders: routes gated by this (messaging/proposals) key
    // participants by identity.id, so a resolved-but-anonymous identity
    // (type set, id still null — only possible today for a shared-password
    // portal-admin session with no CF-Access header at all, e.g. local dev
    // without Cloudflare Access in front) must not be let through to share
    // a "null" identity with every other such session.
    if (identity.id == null) return res.status(401).json({ error: 'Not authenticated — identity could not be resolved to a specific person' });
    req.identity = identity;
    next();
  };
}

module.exports = {
  requireAuth,
  requireClientSession,
  requirePortalAdmin,
  createRequireCreatorSession,
  getCreatorSessionToken,
  resolveIdentity,
  createRequireAnyIdentity,
  ALLOWED_DOMAINS,
};
