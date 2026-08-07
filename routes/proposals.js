/**
 * routes/proposals.js — contract-proposal API (Phase 5 of the platform
 * rebuild). Backed by db/proposals.js (state machine + contracts) and
 * db/messaging.js (every proposal owns a thread; every transition posts a
 * system message there — this file is the one place both modules get wired
 * together, per db/proposals.js's header comment).
 *
 * Creator- and brand-only for now (staff has no role in this flow per the
 * confirmed spec — "My Clients" is about brand *assignment*, not proposal
 * oversight; revisit if a later phase needs staff visibility here).
 *
 * "Ball in your court" rule, enforced on every action route: you cannot
 * counter/accept/reject a proposal whose latest version YOU proposed — that
 * would mean responding to your own offer. Withdraw is the one exception:
 * only the ORIGINAL initiator may withdraw, at any non-terminal point.
 *
 * Mount (before app.use(requireAuth) — creators/brands have no CF Access
 * session):
 *   require('./routes/proposals')(app, { requireAnyIdentity, loadBrands });
 */

const express = require('express');
const prop = require('../db/proposals');
const msg = require('../db/messaging');

const OTHER_PARTY = { creator: 'brand', brand: 'creator' };

module.exports = function mountProposals(app, deps = {}) {
  const requireAnyIdentity = deps.requireAnyIdentity;
  if (!requireAnyIdentity) throw new Error('[proposals] requireAnyIdentity dep is required');

  function requireCreatorOrBrand(req, res, next) {
    if (req.identity.type !== 'creator' && req.identity.type !== 'brand') {
      return res.status(403).json({ ok: false, error: 'Proposals are creator/brand only' });
    }
    next();
  }

  // Confirms req.identity is actually the creator_id/brand_id on this proposal.
  function loadOwnedProposal(req, res) {
    const id = Number(req.params.id);
    const proposal = prop.getProposal(id);
    if (!proposal) {
      res.status(404).json({ ok: false, error: 'Proposal not found' });
      return null;
    }
    const ownField = req.identity.type === 'creator' ? proposal.creator_id : proposal.brand_id;
    if (String(ownField) !== String(req.identity.id)) {
      res.status(403).json({ ok: false, error: 'Not a party to this proposal' });
      return null;
    }
    return proposal;
  }

  // POST /api/proposals — send a new proposal to the other party.
  // Body: { counterpartyId, terms, message }
  app.post('/api/proposals', requireAnyIdentity, requireCreatorOrBrand, express.json(), (req, res) => {
    try {
      const { counterpartyId, terms, message } = req.body || {};
      if (!counterpartyId) return res.status(400).json({ ok: false, error: 'counterpartyId is required' });

      const creatorId = req.identity.type === 'creator' ? req.identity.id : counterpartyId;
      const brandId = req.identity.type === 'brand' ? req.identity.id : counterpartyId;

      const threadId = msg.createThread({
        contextType: 'proposal',
        participants: [{ type: 'creator', id: creatorId }, { type: 'brand', id: brandId }],
      });
      const proposal = prop.createProposal({
        creatorId, brandId, initiatedBy: req.identity.type, threadId, terms, message,
      });
      if (message) msg.addMessage(threadId, { senderType: req.identity.type, senderId: req.identity.id, body: message });
      msg.addSystemMessage(threadId, `Proposal sent by ${req.identity.type} #${req.identity.id}.`);

      res.json({ ok: true, proposal });
    } catch (e) {
      console.error('[proposals] create failed:', e.message);
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // GET /api/proposals — list proposals involving the current identity
  app.get('/api/proposals', requireAnyIdentity, requireCreatorOrBrand, (req, res) => {
    try {
      const proposals = prop.getProposalsForParty(req.identity.type, req.identity.id);
      res.json({ ok: true, proposals });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/proposals/:id — detail, including every version (the negotiation history)
  app.get('/api/proposals/:id', requireAnyIdentity, requireCreatorOrBrand, (req, res) => {
    const proposal = loadOwnedProposal(req, res);
    if (!proposal) return; // response already sent
    res.json({ ok: true, proposal });
  });

  // POST /api/proposals/:id/counter — Body: { terms, message }
  app.post('/api/proposals/:id/counter', requireAnyIdentity, requireCreatorOrBrand, express.json(), (req, res) => {
    const proposal = loadOwnedProposal(req, res);
    if (!proposal) return;
    try {
      const latest = prop.getLatestVersion(proposal.id);
      if (latest && latest.proposed_by === req.identity.type) {
        return res.status(409).json({ ok: false, error: 'Waiting on the other party to respond to your last offer' });
      }
      const { terms, message } = req.body || {};
      const updated = prop.counterProposal(proposal.id, { proposedBy: req.identity.type, terms, message });
      if (message) msg.addMessage(proposal.thread_id, { senderType: req.identity.type, senderId: req.identity.id, body: message });
      msg.addSystemMessage(proposal.thread_id, `${req.identity.type} #${req.identity.id} countered — status: pending.`);
      res.json({ ok: true, proposal: updated });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // POST /api/proposals/:id/accept
  app.post('/api/proposals/:id/accept', requireAnyIdentity, requireCreatorOrBrand, (req, res) => {
    const proposal = loadOwnedProposal(req, res);
    if (!proposal) return;
    try {
      const latest = prop.getLatestVersion(proposal.id);
      if (latest && latest.proposed_by === req.identity.type) {
        return res.status(409).json({ ok: false, error: 'Cannot accept your own offer' });
      }
      const updated = prop.acceptProposal(proposal.id);
      msg.addSystemMessage(proposal.thread_id, `${req.identity.type} #${req.identity.id} accepted — contract created.`);
      res.json({ ok: true, proposal: updated });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // POST /api/proposals/:id/reject
  app.post('/api/proposals/:id/reject', requireAnyIdentity, requireCreatorOrBrand, (req, res) => {
    const proposal = loadOwnedProposal(req, res);
    if (!proposal) return;
    try {
      const latest = prop.getLatestVersion(proposal.id);
      if (latest && latest.proposed_by === req.identity.type) {
        return res.status(409).json({ ok: false, error: 'Cannot reject your own offer' });
      }
      const updated = prop.rejectProposal(proposal.id);
      msg.addSystemMessage(proposal.thread_id, `${req.identity.type} #${req.identity.id} rejected the proposal.`);
      res.json({ ok: true, proposal: updated });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // POST /api/proposals/:id/withdraw — original initiator only
  app.post('/api/proposals/:id/withdraw', requireAnyIdentity, requireCreatorOrBrand, (req, res) => {
    const proposal = loadOwnedProposal(req, res);
    if (!proposal) return;
    try {
      if (proposal.initiated_by !== req.identity.type) {
        return res.status(403).json({ ok: false, error: 'Only the original sender can withdraw a proposal' });
      }
      const updated = prop.withdrawProposal(proposal.id);
      msg.addSystemMessage(proposal.thread_id, `${req.identity.type} #${req.identity.id} withdrew the proposal.`);
      res.json({ ok: true, proposal: updated });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // GET /api/contracts — this identity's contracts (active + past — "My Brands"/
  // "Current Affiliates" vs "Previous Contracts"/"Previous Affiliates" data source)
  app.get('/api/contracts', requireAnyIdentity, requireCreatorOrBrand, (req, res) => {
    try {
      const contracts = prop.getContractsForParty(req.identity.type, req.identity.id);
      res.json({ ok: true, contracts });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/contracts/pair?creatorId=X&brandId=Y — one pair's full history
  // (the "Previous Contracts"/"Previous Affiliates" drill-down). Caller must
  // be one of the two parties in the pair.
  app.get('/api/contracts/pair', requireAnyIdentity, requireCreatorOrBrand, (req, res) => {
    try {
      const { creatorId, brandId } = req.query;
      if (!creatorId || !brandId) return res.status(400).json({ ok: false, error: 'creatorId and brandId are required' });
      const isParty = (req.identity.type === 'creator' && String(req.identity.id) === String(creatorId))
        || (req.identity.type === 'brand' && String(req.identity.id) === String(brandId));
      if (!isParty) return res.status(403).json({ ok: false, error: 'Not a party to this pair' });
      const contracts = prop.getContractsForPair(creatorId, brandId);
      res.json({ ok: true, contracts });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
};
