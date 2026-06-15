/**
 * Content Studio SQLite schema + query helpers
 * Reuses the existing cult-command-center Railway volume DB at /data/inner_circle.db
 * (same handle pattern as db/inner-circle.js — no separate service / volume needed).
 *
 * Tables:
 *   content_credits      — per-client prepaid balance (cents)
 *   content_references   — product reference images/files uploaded by a client
 *   content_generations  — Seedance generation jobs + status + cost/charge accounting
 *   client_integrations  — per-client 3rd-party tokens (e.g. Buffer), encrypted at rest
 *
 * All creates are idempotent (CREATE TABLE IF NOT EXISTS) so this module is safe to
 * require on every boot — matching dashboard-server.js's existing migration style.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || '/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'inner_circle.db');
const db = new Database(DB_PATH);

// WAL + FK enforcement (mirrors db/inner-circle.js; pragmas are connection-scoped,
// so we set them here too in case this module opens its own handle first).
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS content_credits (
    client_id     TEXT PRIMARY KEY,
    balance_cents INTEGER NOT NULL DEFAULT 0,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS content_references (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   TEXT NOT NULL,
    product_id  TEXT,
    file_url    TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS content_generations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id       TEXT NOT NULL,
    product_id      TEXT,
    seedance_job_id TEXT,
    status          TEXT NOT NULL DEFAULT 'pending', -- pending | processing | succeeded | failed
    video_url       TEXT,
    cost_cents      INTEGER DEFAULT 0,   -- what Seedance cost us
    charge_cents    INTEGER DEFAULT 0,   -- what we debit the client's credit balance
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS client_integrations (
    client_id              TEXT PRIMARY KEY,
    buffer_token_encrypted TEXT,
    updated_at             DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_content_refs_client      ON content_references(client_id);
  CREATE INDEX IF NOT EXISTS idx_content_gens_client      ON content_generations(client_id);
  CREATE INDEX IF NOT EXISTS idx_content_gens_status      ON content_generations(status);
  CREATE INDEX IF NOT EXISTS idx_content_gens_seedance    ON content_generations(seedance_job_id);
`);

// ── Query helpers ─────────────────────────────────────────────────────────────
const queries = {
  // Credits
  getCredit: db.prepare(`SELECT * FROM content_credits WHERE client_id = ?`),
  upsertCredit: db.prepare(`
    INSERT INTO content_credits (client_id, balance_cents, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(client_id) DO UPDATE SET
      balance_cents = excluded.balance_cents,
      updated_at = CURRENT_TIMESTAMP`),
  addCredit: db.prepare(`
    INSERT INTO content_credits (client_id, balance_cents, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(client_id) DO UPDATE SET
      balance_cents = balance_cents + excluded.balance_cents,
      updated_at = CURRENT_TIMESTAMP`),
  debitCredit: db.prepare(`
    UPDATE content_credits
    SET balance_cents = balance_cents - ?, updated_at = CURRENT_TIMESTAMP
    WHERE client_id = ? AND balance_cents >= ?`),

  // References
  insertReference: db.prepare(`
    INSERT INTO content_references (client_id, product_id, file_url)
    VALUES (?, ?, ?)`),
  getReferencesForClient: db.prepare(`
    SELECT * FROM content_references WHERE client_id = ? ORDER BY created_at DESC`),
  getReferencesForProduct: db.prepare(`
    SELECT * FROM content_references WHERE client_id = ? AND product_id = ? ORDER BY created_at DESC`),

  // Generations
  insertGeneration: db.prepare(`
    INSERT INTO content_generations (client_id, product_id, seedance_job_id, status, cost_cents, charge_cents)
    VALUES (?, ?, ?, ?, ?, ?)`),
  getGeneration: db.prepare(`SELECT * FROM content_generations WHERE id = ?`),
  getGenerationByJob: db.prepare(`SELECT * FROM content_generations WHERE seedance_job_id = ?`),
  getGenerationsForClient: db.prepare(`
    SELECT * FROM content_generations WHERE client_id = ? ORDER BY created_at DESC`),
  updateGenerationStatus: db.prepare(`
    UPDATE content_generations SET status = ?, video_url = ? WHERE id = ?`),
  updateGenerationByJob: db.prepare(`
    UPDATE content_generations SET status = ?, video_url = ? WHERE seedance_job_id = ?`),

  // Integrations
  getIntegration: db.prepare(`SELECT * FROM client_integrations WHERE client_id = ?`),
  upsertBufferToken: db.prepare(`
    INSERT INTO client_integrations (client_id, buffer_token_encrypted, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(client_id) DO UPDATE SET
      buffer_token_encrypted = excluded.buffer_token_encrypted,
      updated_at = CURRENT_TIMESTAMP`),
};

module.exports = { db, queries };
