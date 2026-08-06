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

module.exports = { requireAuth, requireClientSession, requirePortalAdmin, ALLOWED_DOMAINS };
