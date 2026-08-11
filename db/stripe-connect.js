/**
 * db/stripe-connect.js — creator payouts data layer, Phase 9 of the
 * platform rebuild. Genuinely new infrastructure (per the plan) — brand
 * billing already has a full Stripe integration (Customer + Billing
 * Portal, see dashboard-server.js's /api/client/billing*), but nothing
 * existed for paying creators out before this.
 *
 * Two tables:
 *   stripe_connect_accounts — one row per creator who has started Connect
 *     onboarding. Keyed by our creator_id (PK) AND indexed by
 *     stripe_account_id, since webhook events arrive keyed by the Stripe
 *     account id, not ours.
 *   payouts — an audit ledger of Transfers made to a creator's connected
 *     account. NOTE (honesty, matching this codebase's existing pattern in
 *     routes/content-studio-gen.js): a Stripe Transfer moves funds into the
 *     creator's CONNECTED ACCOUNT BALANCE immediately — it does not by
 *     itself confirm money has landed in their bank account. Actually
 *     reaching their bank is a separate Payout object on the connected
 *     account's own timeline (their payout schedule), which this platform
 *     account can't directly observe without either Connect webhook
 *     subscriptions scoped to that account or the `payout.paid` event
 *     forwarded via Connect webhooks. Status here reflects OUR side of the
 *     transaction (transfer initiated/succeeded/failed), not a guarantee of
 *     bank arrival — the UI must not claim otherwise.
 */

const { db } = require('./connection');

db.exec(`
  CREATE TABLE IF NOT EXISTS stripe_connect_accounts (
    creator_id          INTEGER PRIMARY KEY,
    stripe_account_id   TEXT NOT NULL UNIQUE,
    onboarding_status   TEXT NOT NULL DEFAULT 'pending', -- pending | complete | restricted
    payouts_enabled     INTEGER NOT NULL DEFAULT 0,
    details_submitted   INTEGER NOT NULL DEFAULT 0,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payouts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id          INTEGER NOT NULL,
    stripe_transfer_id  TEXT UNIQUE,
    amount_cents        INTEGER NOT NULL,
    currency            TEXT NOT NULL DEFAULT 'usd',
    status              TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed | reversed
    description         TEXT,
    created_by_email    TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_payouts_creator ON payouts(creator_id);
`);

const getAccountStmt = db.prepare(`SELECT * FROM stripe_connect_accounts WHERE creator_id = ?`);
const getAccountByStripeIdStmt = db.prepare(`SELECT * FROM stripe_connect_accounts WHERE stripe_account_id = ?`);
const upsertAccountStmt = db.prepare(`
  INSERT INTO stripe_connect_accounts (creator_id, stripe_account_id, onboarding_status, payouts_enabled, details_submitted)
  VALUES (@creatorId, @stripeAccountId, @onboardingStatus, @payoutsEnabled, @detailsSubmitted)
  ON CONFLICT(creator_id) DO UPDATE SET
    stripe_account_id = excluded.stripe_account_id,
    onboarding_status = excluded.onboarding_status,
    payouts_enabled = excluded.payouts_enabled,
    details_submitted = excluded.details_submitted,
    updated_at = CURRENT_TIMESTAMP
`);
const updateAccountStatusByStripeIdStmt = db.prepare(`
  UPDATE stripe_connect_accounts
  SET onboarding_status = ?, payouts_enabled = ?, details_submitted = ?, updated_at = CURRENT_TIMESTAMP
  WHERE stripe_account_id = ?
`);

const insertPayoutStmt = db.prepare(`
  INSERT INTO payouts (creator_id, stripe_transfer_id, amount_cents, currency, status, description, created_by_email)
  VALUES (@creatorId, @stripeTransferId, @amountCents, @currency, @status, @description, @createdByEmail)
`);
const getPayoutsForCreatorStmt = db.prepare(`SELECT * FROM payouts WHERE creator_id = ? ORDER BY created_at DESC`);
const getAllPayoutsStmt = db.prepare(`SELECT * FROM payouts ORDER BY created_at DESC LIMIT 200`);
const updatePayoutStatusByTransferIdStmt = db.prepare(`
  UPDATE payouts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE stripe_transfer_id = ?
`);

function getAccount(creatorId) {
  return getAccountStmt.get(Number(creatorId)) || null;
}

function getAccountByStripeId(stripeAccountId) {
  return getAccountByStripeIdStmt.get(stripeAccountId) || null;
}

function upsertAccount({ creatorId, stripeAccountId, onboardingStatus = 'pending', payoutsEnabled = false, detailsSubmitted = false }) {
  if (!creatorId || !stripeAccountId) throw new Error('upsertAccount: creatorId and stripeAccountId are required');
  upsertAccountStmt.run({
    creatorId: Number(creatorId),
    stripeAccountId,
    onboardingStatus,
    payoutsEnabled: payoutsEnabled ? 1 : 0,
    detailsSubmitted: detailsSubmitted ? 1 : 0,
  });
  return getAccount(creatorId);
}

/** Applied from a Stripe `account.updated` webhook event — keyed by Stripe's account id, not ours. */
function updateAccountStatusByStripeId(stripeAccountId, { onboardingStatus, payoutsEnabled, detailsSubmitted }) {
  const existing = getAccountByStripeId(stripeAccountId);
  if (!existing) return null;
  updateAccountStatusByStripeIdStmt.run(
    onboardingStatus ?? existing.onboarding_status,
    (payoutsEnabled ?? !!existing.payouts_enabled) ? 1 : 0,
    (detailsSubmitted ?? !!existing.details_submitted) ? 1 : 0,
    stripeAccountId,
  );
  return getAccountByStripeId(stripeAccountId);
}

function createPayout({ creatorId, stripeTransferId = null, amountCents, currency = 'usd', status = 'pending', description = null, createdByEmail = null }) {
  if (!creatorId) throw new Error('createPayout: creatorId is required');
  const n = Number(amountCents);
  if (!Number.isFinite(n) || n <= 0) throw new Error('createPayout: amountCents must be a positive number');
  insertPayoutStmt.run({
    creatorId: Number(creatorId), stripeTransferId, amountCents: Math.round(n), currency, status, description, createdByEmail,
  });
}

function updatePayoutStatusByTransferId(stripeTransferId, status) {
  updatePayoutStatusByTransferIdStmt.run(status, stripeTransferId);
}

function getPayoutsForCreator(creatorId) {
  return getPayoutsForCreatorStmt.all(Number(creatorId));
}

function getAllPayouts() {
  return getAllPayoutsStmt.all();
}

module.exports = {
  db,
  getAccount,
  getAccountByStripeId,
  upsertAccount,
  updateAccountStatusByStripeId,
  createPayout,
  updatePayoutStatusByTransferId,
  getPayoutsForCreator,
  getAllPayouts,
};
