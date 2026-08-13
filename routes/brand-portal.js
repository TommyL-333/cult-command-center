/**
 * routes/brand-portal.js — brand-facing API surface (Phase 7 of the
 * platform rebuild). Mirrors routes/creator-portal.js (Phase 6) from the
 * other side: profile + the three creator-marketplace tabs (Current
 * Affiliates / Explore Creators / Previous Creators), built on the same
 * Phase 5 contracts data.
 *
 * Content Generation (Seedance), Buffer posting, and Billing do NOT get new
 * backend routes here — routes/content-studio-gen.js and dashboard-server.js's
 * existing /api/client/billing* + /api/client/buffer/* + /api/client/products
 * already fully implement all of that (confirmed by reading them before
 * writing this file, not assumed) — the frontend consumes those directly.
 * This file is only the genuinely new piece: the creator marketplace.
 *
 * Auth: requireClientSession (brand-only — same reasoning as
 * creator-portal.js using requireSqliteSession over requireAnyIdentity).
 *
 * Mount (before app.use(requireAuth) — brands have no CF Access session):
 *   require('./routes/brand-portal')(app, {
 *     requireClientSession, loadBrands, getActiveDiscordServers, recordDiscordInvite,
 *   });
 */

const express = require('express');
const { db } = require('../db/inner-circle');
const prop = require('../db/proposals');

const getAllActiveCreatorsStmt = db.prepare(`
  SELECT id, creator_handle, creator_name, email FROM inner_circle_creators WHERE status = 'active'
`);

function creatorSummary(row) {
  if (!row) return null;
  return { id: row.id, handle: row.creator_handle, name: row.creator_name || null };
}

module.exports = function mountBrandPortal(app, deps = {}) {
  const requireClientSession = deps.requireClientSession;
  const loadBrands = deps.loadBrands;
  const saveBrands = deps.saveBrands;
  const getActiveDiscordServers = deps.getActiveDiscordServers || (() => []);
  const recordDiscordInvite = deps.recordDiscordInvite || (() => {});
  if (!requireClientSession) throw new Error('[brand-portal] requireClientSession dep is required');
  if (!loadBrands) throw new Error('[brand-portal] loadBrands dep is required');
  if (!saveBrands) throw new Error('[brand-portal] saveBrands dep is required');

  function findBrand(req) {
    const data = loadBrands();
    const idx = (data.clients || []).findIndex((b) => b.id === req.session.clientBrandId);
    return { data, idx, brand: idx === -1 ? null : data.clients[idx] };
  }

  // GET /api/brand/profile
  app.get('/api/brand/profile', requireClientSession, (req, res) => {
    const { brand } = findBrand(req);
    if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });
    res.json({
      ok: true,
      profile: {
        id: brand.id,
        email: brand.loginEmail || brand.email || null,
        handle: brand.tiktokHandle || null,
        name: brand.name || null,
        discordUsername: brand.discordUsername || null,
        smsOptIn: !!brand.smsOptIn,
      },
    });
  });

  // PATCH /api/brand/profile — Body: { discordUsername?, smsOptIn? }
  app.patch('/api/brand/profile', requireClientSession, express.json(), (req, res) => {
    try {
      const { data, idx, brand } = findBrand(req);
      if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });

      const { discordUsername, smsOptIn } = req.body || {};
      const nextDiscord = discordUsername !== undefined ? (String(discordUsername).trim() || null) : (brand.discordUsername || null);
      const nextSmsOptIn = smsOptIn !== undefined ? !!smsOptIn : !!brand.smsOptIn;

      const changed = nextDiscord !== (brand.discordUsername || null);
      data.clients[idx].discordUsername = nextDiscord;
      data.clients[idx].smsOptIn = nextSmsOptIn;
      saveBrands(data);

      if (nextDiscord && changed) {
        try {
          for (const server of getActiveDiscordServers()) {
            recordDiscordInvite(brand.id, 'brand', server.guild_id, nextDiscord);
          }
        } catch (e) {
          console.error('[brand-portal] discord invite recording failed:', e.message);
        }
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // GET /api/brand/creators — the three-tab marketplace data source.
  app.get('/api/brand/creators', requireClientSession, (req, res) => {
    try {
      const { brand } = findBrand(req);
      if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });
      const brandId = String(brand.id);

      const allCreators = getAllActiveCreatorsStmt.all();
      const creatorById = new Map(allCreators.map((c) => [String(c.id), c]));

      const contracts = prop.getContractsForParty('brand', brandId);
      const activeByCreator = new Map();
      const everCreatorIds = new Set();
      for (const c of contracts) {
        everCreatorIds.add(c.creator_id);
        if (!c.ended_at) activeByCreator.set(c.creator_id, c);
      }
      const previousCreatorIds = [...everCreatorIds].filter((id) => !activeByCreator.has(id));

      const currentAffiliates = [...activeByCreator.entries()].map(([creatorId, contract]) => ({
        creator: creatorSummary(creatorById.get(creatorId)) || { id: creatorId, handle: null, name: null },
        contract,
      }));
      const previousCreators = previousCreatorIds.map((creatorId) => ({
        creator: creatorSummary(creatorById.get(creatorId)) || { id: creatorId, handle: null, name: null },
        contractCount: contracts.filter((c) => c.creator_id === creatorId).length,
      }));
      const exploreCreators = allCreators
        .filter((c) => !everCreatorIds.has(String(c.id)))
        .map((c) => ({ creator: creatorSummary(c) }));

      res.json({ ok: true, currentAffiliates, exploreCreators, previousCreators });
    } catch (e) {
      console.error('[brand-portal] get creators failed:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });
};
