/**
 * routes/creator-payouts.js — Stripe Connect creator payouts, Phase 9 of
 * the platform rebuild. Genuinely new infrastructure — brand billing
 * already has a full Stripe integration (dashboard-server.js's
 * /api/client/billing*), nothing existed for paying creators out before
 * this. Data layer: db/stripe-connect.js.
 *
 * Creator-facing (requireSqliteSession):
 *   GET  /api/creator/payouts/status   -> this creator's Connect account state
 *   POST /api/creator/payouts/onboard  -> create (if needed) + return a
 *                                          hosted Stripe onboarding link
 *   GET  /api/creator/payouts/history  -> this creator's own payout ledger
 *
 * Public (Stripe-signature-verified, no session):
 *   POST /api/webhooks/stripe-connect  -> account.updated (syncs onboarding
 *                                          status) + transfer.reversed
 *
 * Staff-facing payout INITIATION (creating a Transfer) lives in
 * routes/staff-portal.js instead of here — it already has the staff
 * identity + permission-check infrastructure this would otherwise
 * duplicate. This file is creator-facing + the webhook only.
 */

const express = require('express');
const stripeConnect = require('../db/stripe-connect');

module.exports = function mountCreatorPayouts(app, deps = {}) {
  const { requireSqliteSession, stripe, getCreatorById, publicBaseUrl } = deps;
  if (!requireSqliteSession) throw new Error('[creator-payouts] requireSqliteSession dep is required');
  if (!getCreatorById) throw new Error('[creator-payouts] getCreatorById dep is required');
  const baseUrl = (publicBaseUrl || 'https://portal.cultcontent.cc').replace(/\/$/, '');

  function stripeUnavailable(res) {
    return res.status(503).json({ error: 'Stripe not configured — set STRIPE_SECRET_KEY' });
  }

  function accountView(account) {
    if (!account) return null;
    return {
      onboardingStatus: account.onboarding_status,
      payoutsEnabled: !!account.payouts_enabled,
      detailsSubmitted: !!account.details_submitted,
    };
  }

  // ── GET /api/creator/payouts/status ──────────────────────────────────────
  app.get('/api/creator/payouts/status', requireSqliteSession, (req, res) => {
    try {
      res.json({ ok: true, account: accountView(stripeConnect.getAccount(req.icCreator.id)) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/creator/payouts/onboard ────────────────────────────────────
  // Creates the Stripe Express account on first call, reuses it on every
  // later call (Account Links are single-use/short-lived, so this always
  // mints a fresh one -- calling it again to "resume" onboarding is normal).
  app.post('/api/creator/payouts/onboard', requireSqliteSession, express.json(), async (req, res) => {
    if (!stripe) return stripeUnavailable(res);
    try {
      const creator = getCreatorById(req.icCreator.id);
      if (!creator) return res.status(404).json({ error: 'Creator not found' });

      let account = stripeConnect.getAccount(creator.id);
      let stripeAccountId = account?.stripe_account_id;

      if (!stripeAccountId) {
        const acct = await stripe.accounts.create({
          type: 'express',
          email: creator.email || undefined,
          metadata: { creatorId: String(creator.id), source: 'cult-content-creator-payouts' },
          capabilities: { transfers: { requested: true } },
        });
        stripeAccountId = acct.id;
        stripeConnect.upsertAccount({ creatorId: creator.id, stripeAccountId, onboardingStatus: 'pending', payoutsEnabled: false, detailsSubmitted: false });
      }

      const link = await stripe.accountLinks.create({
        account: stripeAccountId,
        refresh_url: `${baseUrl}/app/creator?payouts=refresh`,
        return_url: `${baseUrl}/app/creator?payouts=complete`,
        type: 'account_onboarding',
      });

      res.json({ ok: true, url: link.url });
    } catch (e) {
      console.error('[creator-payouts] onboard failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/creator/payouts/history ─────────────────────────────────────
  app.get('/api/creator/payouts/history', requireSqliteSession, (req, res) => {
    try {
      res.json({ ok: true, payouts: stripeConnect.getPayoutsForCreator(req.icCreator.id) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/webhooks/stripe-connect ────────────────────────────────────
  // Registered pre-auth (public) -- verified via Stripe's signature, not a
  // session. Requires req.rawBody (see dashboard-server.js's raw-body
  // capture middleware, extended to include this path).
  app.post('/api/webhooks/stripe-connect', (req, res) => {
    if (!stripe) return stripeUnavailable(res);
    const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    if (!secret) {
      console.error('[creator-payouts] webhook received but STRIPE_CONNECT_WEBHOOK_SECRET is not set — rejecting');
      return res.status(503).json({ error: 'Webhook not configured' });
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], secret);
    } catch (e) {
      console.error('[creator-payouts] webhook signature verification failed:', e.message);
      return res.status(400).json({ error: 'Invalid signature' });
    }

    try {
      if (event.type === 'account.updated') {
        const acct = event.data.object;
        const updated = stripeConnect.updateAccountStatusByStripeId(acct.id, {
          onboardingStatus: acct.charges_enabled && acct.payouts_enabled ? 'complete' : (acct.requirements?.disabled_reason ? 'restricted' : 'pending'),
          payoutsEnabled: !!acct.payouts_enabled,
          detailsSubmitted: !!acct.details_submitted,
        });
        if (!updated) console.log(`[creator-payouts] account.updated for unknown account ${acct.id} — ignored`);
      } else if (event.type === 'transfer.reversed') {
        const transfer = event.data.object;
        stripeConnect.updatePayoutStatusByTransferId(transfer.id, 'reversed');
      }
      res.json({ received: true });
    } catch (e) {
      console.error('[creator-payouts] webhook handling failed:', e.message);
      res.status(500).json({ error: 'Webhook handling failed' });
    }
  });

  console.log('[creator-payouts] mounted: /api/creator/payouts/status|onboard|history, /api/webhooks/stripe-connect');
};
