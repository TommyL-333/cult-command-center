/**
 * routes/staff-portal.js — Employee/Ops portal backend, Phase 8 of the
 * platform rebuild. This pass covers the three sub-systems scoped for this
 * increment: My Clients (brand_assignments, previously unused by any
 * route), a teammate roster + profile identity endpoint, and the points
 * leaderboard (db/staff-points.js, fed by the real completion flow in
 * routes/ops-my-tasks.js). Support Inbox and CRM/sales tooling are NOT
 * duplicated here — Support Inbox reuses routes/support-tickets.js's
 * existing GET /api/support-tickets/list + POST /api/support-tickets/:id/status
 * as-is (already staff-scoped, already correct); the full CRM/segments.html
 * React port is a separate, larger pass.
 *
 * Auth: requireAuth (CF Access — "any @cultcontent.cc teammate", matching
 * the existing /my-tasks and /api/support-tickets/* pattern, since My
 * Clients/points/roster genuinely are for all staff, not just portal
 * admins). Within that, WRITE operations (assigning a brand to a staff
 * member) additionally require the caller to be a portal-users.json record
 * with the 'user_admin' permission — same check routes/portal-team-auth.js's
 * requireUserAdmin already uses for team management, reused here rather
 * than inventing a parallel "lead-admin" concept.
 *
 * Staff identity resolution: requireAuth only guarantees req.userEmail (a
 * CF-Access header) — it does NOT populate req.session.portalUserId unless
 * the caller also happened to log in via /portal-admin/team-login. So the
 * staff record here is resolved from whichever identity we actually have:
 * portalUserId if a portal-admin session exists, otherwise a
 * findByUsername(email) lookup. This matches how GET /api/me's staff
 * variant already has to handle the same two paths (middleware/auth.js's
 * resolveIdentity).
 */

const express = require('express');

module.exports = function mountStaffPortal(app, deps = {}) {
  const { requireAuth, loadBrands, findById, findByUsername, loadUsers, stripe, getCreatorById, ALL_PERMISSIONS } = deps;
  if (!requireAuth) throw new Error('[staff-portal] requireAuth dep is required');
  if (!loadBrands) throw new Error('[staff-portal] loadBrands dep is required');
  if (!findById || !findByUsername || !loadUsers) {
    throw new Error('[staff-portal] findById/findByUsername/loadUsers deps are required (from routes/portal-team-auth.js)');
  }

  let brandAssignments;
  try {
    brandAssignments = require('../db/brand-assignments');
  } catch (e) {
    console.error('[staff-portal] failed to load db/brand-assignments:', e.message);
    app.all('/api/staff/*', (req, res) => res.status(503).json({ error: 'Staff portal storage unavailable', detail: e.message }));
    return;
  }
  let staffPoints;
  try {
    staffPoints = require('../db/staff-points');
  } catch (e) {
    console.error('[staff-portal] failed to load db/staff-points:', e.message);
  }
  let stripeConnect;
  try {
    stripeConnect = require('../db/stripe-connect');
  } catch (e) {
    console.error('[staff-portal] failed to load db/stripe-connect:', e.message);
  }

  // The one real, synthetic exception: a session with isPortalAdmin=true but
  // no portalUserId (the legacy shared-password /portal-admin/login) has no
  // portal-users.json record to return -- but requireStaffPermission below
  // already treats that exact session as a full owner for WRITE actions.
  // Without this, GET /api/staff/profile disagreed with that: it reported
  // empty permissions, so the Team Assignments tab never rendered for a
  // shared-password admin even though they could already perform the write
  // via a direct API call. id stays null (there's no real per-person
  // identity behind the shared password -- see the messaging-identity fix
  // elsewhere in this app for why that distinction matters); callers that
  // need a real staff_id (e.g. my-clients) must check for that explicitly.
  const LEGACY_ADMIN = { id: null, username: null, email: null, name: 'Admin (shared login)', role: 'owner', permissions: ALL_PERMISSIONS || [] };

  function currentStaffUser(req) {
    if (req.session?.portalUserId) {
      const u = findById(req.session.portalUserId);
      if (u) return u;
    }
    if (req.userEmail) {
      const u = findByUsername(req.userEmail);
      if (u) return u;
    }
    if (req.session?.isPortalAdmin) return LEGACY_ADMIN;
    return null;
  }

  // Generic permission gate. Mirrors routes/portal-team-auth.js's
  // requireUserAdmin EXACTLY (same isPortalAdmin/portalUserId branching,
  // same "legacy shared-password admin = full owner" fallback for a
  // session with isPortalAdmin=true but no portalUserId) rather than
  // reimplementing a lookalike that drops that fallback — a prior version
  // of this function did exactly that and wrongly 403'd legacy admins on
  // every write below, contradicting its own header comment's claim of
  // parity. req.staffUser is set to the resolved record, or null for that
  // legacy-admin case; every handler using it below treats null there as
  // "the legacy admin" (no distinguishable identity to record), not
  // "nobody" — see assign/unassign and the payout handlers.
  //
  // A bare CF-Access session (no portal-admin login at all) is NOT given
  // the same blanket fallback: requireUserAdmin's original design never
  // covered that case, so an unprovisioned teammate must have a real
  // portal-users.json record with the permission, same as any other path.
  function requireStaffPermission(permission) {
    return function (req, res, next) {
      if (req.session?.isPortalAdmin) {
        const u = req.session.portalUserId ? findById(req.session.portalUserId) : null;
        if (u && !(Array.isArray(u.permissions) && u.permissions.includes(permission))) {
          return res.status(403).json({ error: `${permission} permission required` });
        }
        req.staffUser = u;
        return next();
      }
      const u = req.userEmail ? findByUsername(req.userEmail) : null;
      if (!(u && Array.isArray(u.permissions) && u.permissions.includes(permission))) {
        return res.status(403).json({ error: `${permission} permission required` });
      }
      req.staffUser = u;
      next();
    };
  }

  const requireStaffUserAdmin = requireStaffPermission('user_admin');
  // 'billing' is an existing permission (routes/portal-team-auth.js's
  // ALL_PERMISSIONS, described there as "financials / invoicing") — reused
  // here for creator-payout initiation rather than inventing a new one.
  const requireStaffBilling = requireStaffPermission('billing');

  function brandSummary(brand) {
    if (!brand) return null;
    return { id: brand.id, name: brand.name || null, website: brand.website || null, onboardingStatus: brand.onboardingStatus || null };
  }

  // ── GET /api/staff/profile — who am I, for the new portal shell ─────────
  app.get('/api/staff/profile', requireAuth, (req, res) => {
    const u = currentStaffUser(req);
    if (!u) {
      // A real CF-Access-authenticated teammate with no portal-users.json
      // record yet (never provisioned via /portal-admin/team-login) — still
      // a valid staff identity (see middleware/auth.js resolveIdentity),
      // just without a name/roster entry. Honest, not fabricated.
      return res.json({ ok: true, profile: { id: null, email: req.userEmail || null, name: null, role: null, permissions: [] } });
    }
    res.json({ ok: true, profile: { id: u.id, email: u.email || null, name: u.name || u.username, role: u.role || null, permissions: u.permissions || [] } });
  });

  // ── GET /api/staff/roster — teammate names for the assign-brand picker ──
  app.get('/api/staff/roster', requireAuth, (req, res) => {
    const roster = loadUsers()
      .filter((u) => u.active !== false)
      .map((u) => ({ id: u.id, name: u.name || u.username, email: u.email || null }));
    res.json({ ok: true, roster });
  });

  // ── GET /api/staff/my-clients — brands assigned to the logged-in staff ──
  app.get('/api/staff/my-clients', requireAuth, (req, res) => {
    try {
      const u = currentStaffUser(req);
      // No real per-person identity (unprovisioned CF-Access teammate, or
      // the shared-password login) -- no real staff_id to look assignments
      // up by, so there's genuinely nothing to return, not an error.
      if (!u || u.id == null) return res.json({ ok: true, clients: [] });
      const brands = loadBrands();
      const byId = new Map((brands.clients || []).map((b) => [b.id, b]));
      const assignments = brandAssignments.getBrandsForStaff(u.id);
      const clients = assignments
        .map((a) => ({ brand: brandSummary(byId.get(a.brand_id)) || { id: a.brand_id, name: null, website: null, onboardingStatus: null }, role: a.role, assignedAt: a.assigned_at }))
        .filter((c) => c.brand);
      res.json({ ok: true, clients });
    } catch (e) {
      console.error('[staff-portal] my-clients failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/staff/assignments — full assignment board (admin) ──────────
  // All brands + all assignments, for the assign/unassign UI. Frontend joins
  // against /api/staff/roster for names.
  app.get('/api/staff/assignments', requireAuth, requireStaffUserAdmin, (req, res) => {
    try {
      const brands = loadBrands();
      const list = (brands.clients || []).map((b) => ({
        brand: brandSummary(b),
        staff: brandAssignments.getStaffForBrand(b.id),
      }));
      res.json({ ok: true, brands: list });
    } catch (e) {
      console.error('[staff-portal] assignments failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/staff/clients/assign — body { brandId, staffId, role } ────
  app.post('/api/staff/clients/assign', requireAuth, requireStaffUserAdmin, express.json(), (req, res) => {
    try {
      const { brandId, staffId, role = 'primary' } = req.body || {};
      if (!brandId || !staffId) return res.status(400).json({ error: 'brandId and staffId are required' });
      const brands = loadBrands();
      if (!(brands.clients || []).some((b) => b.id === brandId)) return res.status(404).json({ error: 'Brand not found' });
      if (!findById(staffId)) return res.status(404).json({ error: 'Staff member not found' });
      // req.staffUser is null for the legacy shared-password admin (no
      // distinguishable per-person identity to record — see
      // requireStaffPermission above); assignBrand accepts a null assignedBy.
      brandAssignments.assignBrand(brandId, staffId, role, req.staffUser?.id ?? null);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── POST /api/staff/clients/unassign — body { brandId, staffId } ────────
  app.post('/api/staff/clients/unassign', requireAuth, requireStaffUserAdmin, express.json(), (req, res) => {
    try {
      const { brandId, staffId } = req.body || {};
      if (!brandId || !staffId) return res.status(400).json({ error: 'brandId and staffId are required' });
      brandAssignments.unassignBrand(brandId, staffId);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── Points leaderboard (Phase 8: point-based task management) ───────────
  app.get('/api/staff/points/leaderboard', requireAuth, (req, res) => {
    if (!staffPoints) return res.status(503).json({ error: 'Points ledger unavailable' });
    try {
      res.json({ ok: true, leaderboard: staffPoints.getLeaderboard() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/staff/points/mine', requireAuth, (req, res) => {
    if (!staffPoints) return res.status(503).json({ error: 'Points ledger unavailable' });
    if (!req.userEmail) return res.status(401).json({ error: 'Not authenticated' });
    try {
      res.json({ ok: true, ...staffPoints.getForStaff(req.userEmail) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Creator payouts (Phase 9) — staff-side INITIATION only. The creator-
  // facing status/onboard/history endpoints live in routes/creator-payouts.js
  // (this file already has the staff identity + permission-check
  // infrastructure that would otherwise be duplicated there). Gated on the
  // 'billing' permission, same as brand billing conceptually belongs to
  // whoever holds that permission today.
  app.get('/api/staff/payouts', requireAuth, requireStaffBilling, (req, res) => {
    if (!stripeConnect) return res.status(503).json({ error: 'Payouts storage unavailable' });
    try {
      const { creatorId } = req.query;
      const payouts = creatorId ? stripeConnect.getPayoutsForCreator(creatorId) : stripeConnect.getAllPayouts();
      res.json({ ok: true, payouts });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/staff/payouts/create — body { creatorId, amountCents, description? }
  // Creates a real Stripe Transfer to the creator's connected account. See
  // db/stripe-connect.js's header comment: this confirms the transfer moved
  // funds into their CONNECTED ACCOUNT BALANCE, not that it has reached
  // their bank yet — the response and stored status reflect that honestly.
  app.post('/api/staff/payouts/create', requireAuth, requireStaffBilling, express.json(), async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured — set STRIPE_SECRET_KEY' });
    if (!stripeConnect) return res.status(503).json({ error: 'Payouts storage unavailable' });
    if (!getCreatorById) return res.status(503).json({ error: 'Creator lookup unavailable' });
    try {
      const { creatorId, amountCents, description = null } = req.body || {};
      if (!creatorId || !Number.isFinite(Number(amountCents)) || Number(amountCents) <= 0) {
        return res.status(400).json({ error: 'creatorId and a positive amountCents are required' });
      }
      const creator = getCreatorById(creatorId);
      if (!creator) return res.status(404).json({ error: 'Creator not found' });
      const account = stripeConnect.getAccount(creatorId);
      if (!account || !account.stripe_account_id) {
        return res.status(409).json({ error: 'This creator has not started Stripe Connect onboarding yet.' });
      }
      if (!account.payouts_enabled) {
        return res.status(409).json({ error: 'This creator\'s Connect account is not yet enabled for payouts (onboarding incomplete).' });
      }

      const transfer = await stripe.transfers.create({
        amount: Math.round(Number(amountCents)),
        currency: 'usd',
        destination: account.stripe_account_id,
        description: description || undefined,
        metadata: { creatorId: String(creatorId), initiatedBy: req.staffUser?.email || 'legacy-shared-password-admin' },
      });

      stripeConnect.createPayout({
        creatorId, stripeTransferId: transfer.id, amountCents, description,
        status: 'paid', createdByEmail: req.staffUser?.email || null,
      });

      res.json({ ok: true, transferId: transfer.id });
    } catch (e) {
      console.error('[staff-portal] payout create failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  console.log('[staff-portal] mounted: /api/staff/profile, /roster, /my-clients, /assignments, /clients/assign|unassign, /points/leaderboard|mine, /payouts');
};
