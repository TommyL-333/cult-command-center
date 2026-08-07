/**
 * db/proposals.js — contract-proposal lifecycle + resulting contracts
 * (Phase 5 of the platform rebuild). Every creator<->brand button in the
 * confirmed spec (Make a Proposal, Send a Proposal, View Contract, the
 * counteroffer flow) is backed by this.
 *
 * Lifecycle: sent -> [accept -> contract created] | [counter -> pending ->
 * (accept/counter/reject, loop)] | reject | withdrawn | expired (not
 * auto-expired yet — no scheduler exists for that in this phase, status
 * value reserved for when one does).
 *
 * Every proposal owns exactly one db/messaging.js thread (context_type=
 * 'proposal', context_id=proposals.id) — the message history in that thread
 * IS the negotiation record, no separate proposal-timeline UI needed. Every
 * transition below also posts a system message into that thread; callers
 * (routes/proposals.js) pass in the messaging module's addMessage/
 * addSystemMessage rather than this file requiring db/messaging.js directly,
 * so the two data modules don't need to know about each other's schemas —
 * routes/proposals.js is the one place that wires them together.
 *
 * Accepting a proposal closes out any prior ACTIVE contract for that same
 * creator<->brand pair (sets ended_at) before inserting the new one — this
 * is what makes "My Brands" (active) vs "Previous Contracts" (ended_at set)
 * correct, and why a pair can have more than one contracts row over time
 * (the drill-down history).
 */

const { db } = require('./connection');

db.exec(`
  CREATE TABLE IF NOT EXISTS proposals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id    TEXT NOT NULL,
    brand_id      TEXT NOT NULL,
    initiated_by  TEXT NOT NULL,     -- 'creator' | 'brand'
    status        TEXT NOT NULL DEFAULT 'sent',  -- sent|pending|accepted|rejected|withdrawn|expired
    thread_id     INTEGER NOT NULL REFERENCES message_threads(id),
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS proposal_versions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id   INTEGER NOT NULL REFERENCES proposals(id),
    version_no    INTEGER NOT NULL,
    proposed_by   TEXT NOT NULL,     -- 'creator' | 'brand'
    terms_json    TEXT NOT NULL,     -- free-form: commission rate, deliverables, etc.
    message       TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contracts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id    TEXT NOT NULL,
    brand_id      TEXT NOT NULL,
    proposal_id   INTEGER REFERENCES proposals(id),
    terms_json    TEXT,
    started_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at      DATETIME,          -- NULL = active
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_proposals_creator ON proposals(creator_id, status);
  CREATE INDEX IF NOT EXISTS idx_proposals_brand    ON proposals(brand_id, status);
  CREATE INDEX IF NOT EXISTS idx_proposal_versions  ON proposal_versions(proposal_id, version_no);
  CREATE INDEX IF NOT EXISTS idx_contracts_creator   ON contracts(creator_id, ended_at);
  CREATE INDEX IF NOT EXISTS idx_contracts_brand      ON contracts(brand_id, ended_at);
  CREATE INDEX IF NOT EXISTS idx_contracts_pair        ON contracts(creator_id, brand_id);
`);

const TERMINAL_STATUSES = new Set(['accepted', 'rejected', 'withdrawn', 'expired']);

const insertProposalStmt = db.prepare(`
  INSERT INTO proposals (creator_id, brand_id, initiated_by, status, thread_id) VALUES (?, ?, ?, 'sent', ?)
`);
const insertVersionStmt = db.prepare(`
  INSERT INTO proposal_versions (proposal_id, version_no, proposed_by, terms_json, message) VALUES (?, ?, ?, ?, ?)
`);
const setStatusStmt = db.prepare(`UPDATE proposals SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
const getProposalStmt = db.prepare(`SELECT * FROM proposals WHERE id = ?`);
const getVersionsStmt = db.prepare(`SELECT * FROM proposal_versions WHERE proposal_id = ? ORDER BY version_no ASC`);
const latestVersionStmt = db.prepare(`SELECT * FROM proposal_versions WHERE proposal_id = ? ORDER BY version_no DESC LIMIT 1`);
const proposalsForCreatorStmt = db.prepare(`SELECT * FROM proposals WHERE creator_id = ? ORDER BY updated_at DESC`);
const proposalsForBrandStmt = db.prepare(`SELECT * FROM proposals WHERE brand_id = ? ORDER BY updated_at DESC`);

const insertContractStmt = db.prepare(`
  INSERT INTO contracts (creator_id, brand_id, proposal_id, terms_json, started_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
`);
const closeActiveContractsStmt = db.prepare(`
  UPDATE contracts SET ended_at = CURRENT_TIMESTAMP WHERE creator_id = ? AND brand_id = ? AND ended_at IS NULL
`);
const activeContractStmt = db.prepare(`
  SELECT * FROM contracts WHERE creator_id = ? AND brand_id = ? AND ended_at IS NULL LIMIT 1
`);
const contractsForPairStmt = db.prepare(`
  SELECT * FROM contracts WHERE creator_id = ? AND brand_id = ? ORDER BY started_at DESC
`);
const contractsForCreatorStmt = db.prepare(`SELECT * FROM contracts WHERE creator_id = ? ORDER BY started_at DESC`);
const contractsForBrandStmt = db.prepare(`SELECT * FROM contracts WHERE brand_id = ? ORDER BY started_at DESC`);

function assertNotTerminal(proposal) {
  if (!proposal) throw new Error('proposal not found');
  if (TERMINAL_STATUSES.has(proposal.status)) {
    throw new Error(`proposal is already ${proposal.status}`);
  }
}

/**
 * createProposal({ creatorId, brandId, initiatedBy, threadId, terms, message })
 * threadId: caller creates the db/messaging.js thread first (needs both
 * modules wired together, which only routes/proposals.js does) and passes
 * the id in here. Returns the new proposal row (with versions attached).
 */
function createProposal({ creatorId, brandId, initiatedBy, threadId, terms, message = null }) {
  if (!['creator', 'brand'].includes(initiatedBy)) throw new Error("initiatedBy must be 'creator' or 'brand'");
  const tx = db.transaction(() => {
    const info = insertProposalStmt.run(String(creatorId), String(brandId), initiatedBy, threadId);
    const proposalId = info.lastInsertRowid;
    insertVersionStmt.run(proposalId, 1, initiatedBy, JSON.stringify(terms || {}), message);
    return proposalId;
  });
  return getProposal(tx());
}

/** Counter — the OTHER party proposes new terms. Route layer enforces who's allowed to act next. */
function counterProposal(proposalId, { proposedBy, terms, message = null }) {
  const proposal = getProposalStmt.get(proposalId);
  assertNotTerminal(proposal);
  const tx = db.transaction(() => {
    const latest = latestVersionStmt.get(proposalId);
    const nextVersion = (latest ? latest.version_no : 0) + 1;
    insertVersionStmt.run(proposalId, nextVersion, proposedBy, JSON.stringify(terms || {}), message);
    setStatusStmt.run('pending', proposalId);
  });
  tx();
  return getProposal(proposalId);
}

/** Accept — creates the contract, closes any prior active contract for the pair. */
function acceptProposal(proposalId) {
  const proposal = getProposalStmt.get(proposalId);
  assertNotTerminal(proposal);
  const latest = latestVersionStmt.get(proposalId);
  const tx = db.transaction(() => {
    closeActiveContractsStmt.run(proposal.creator_id, proposal.brand_id);
    insertContractStmt.run(proposal.creator_id, proposal.brand_id, proposalId, latest ? latest.terms_json : null);
    setStatusStmt.run('accepted', proposalId);
  });
  tx();
  return getProposal(proposalId);
}

function rejectProposal(proposalId) {
  const proposal = getProposalStmt.get(proposalId);
  assertNotTerminal(proposal);
  setStatusStmt.run('rejected', proposalId);
  return getProposal(proposalId);
}

/** Withdraw — route layer enforces only the original initiator may do this. */
function withdrawProposal(proposalId) {
  const proposal = getProposalStmt.get(proposalId);
  assertNotTerminal(proposal);
  setStatusStmt.run('withdrawn', proposalId);
  return getProposal(proposalId);
}

function getProposal(proposalId) {
  const proposal = getProposalStmt.get(proposalId);
  if (!proposal) return null;
  proposal.versions = getVersionsStmt.all(proposalId);
  return proposal;
}

function getLatestVersion(proposalId) {
  return latestVersionStmt.get(proposalId);
}

function getProposalsForParty(type, id) {
  const rows = type === 'creator' ? proposalsForCreatorStmt.all(String(id)) : proposalsForBrandStmt.all(String(id));
  return rows.map((p) => ({ ...p, latestVersion: latestVersionStmt.get(p.id) }));
}

function getActiveContract(creatorId, brandId) {
  return activeContractStmt.get(String(creatorId), String(brandId)) || null;
}

/** Full history for a pair — the "Previous Contracts" drill-down data source. */
function getContractsForPair(creatorId, brandId) {
  return contractsForPairStmt.all(String(creatorId), String(brandId));
}

function getContractsForParty(type, id) {
  return type === 'creator' ? contractsForCreatorStmt.all(String(id)) : contractsForBrandStmt.all(String(id));
}

module.exports = {
  db,
  createProposal,
  counterProposal,
  acceptProposal,
  rejectProposal,
  withdrawProposal,
  getProposal,
  getLatestVersion,
  getProposalsForParty,
  getActiveContract,
  getContractsForPair,
  getContractsForParty,
  TERMINAL_STATUSES,
};
