/**
 * Support Tickets SQLite schema + query helpers.
 * Reuses the existing cult-command-center Railway volume DB at /data/inner_circle.db
 * (same handle pattern as db/inner-circle.js and db/content-studio.js — no
 * separate service / volume needed).
 *
 * One ticket = one question/concern/suggestion a client submitted from the
 * client portal. Status is exactly one of: unopened | opened | flagged.
 * Moving a ticket to "opened" records which teammate opened it.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || '/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'inner_circle.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS support_tickets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id        TEXT NOT NULL,
    brand_name      TEXT,
    type            TEXT NOT NULL DEFAULT 'question',   -- question | concern | suggestion
    message         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'unopened',   -- unopened | opened | flagged
    opened_by_email TEXT,
    opened_by_name  TEXT,
    opened_at       DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_support_tickets_brand  ON support_tickets(brand_id);
  CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
`);

const queries = {
  insertTicket: db.prepare(`
    INSERT INTO support_tickets (brand_id, brand_name, type, message)
    VALUES (?, ?, ?, ?)`),

  getTicketsForBrand: db.prepare(`
    SELECT * FROM support_tickets WHERE brand_id = ? ORDER BY created_at DESC`),

  getTicketById: db.prepare(`SELECT * FROM support_tickets WHERE id = ?`),

  // Flagged and unopened surface first — that's the "needs attention" order,
  // not just newest-first.
  getAllTickets: db.prepare(`
    SELECT * FROM support_tickets
    ORDER BY (CASE status WHEN 'flagged' THEN 0 WHEN 'unopened' THEN 1 ELSE 2 END),
             created_at DESC`),

  setStatusOpened: db.prepare(`
    UPDATE support_tickets
       SET status = 'opened', opened_by_email = ?, opened_by_name = ?,
           opened_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`),

  setStatusFlagged: db.prepare(`
    UPDATE support_tickets
       SET status = 'flagged', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`),

  setStatusUnopened: db.prepare(`
    UPDATE support_tickets
       SET status = 'unopened', opened_by_email = NULL, opened_by_name = NULL,
           opened_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`),
};

module.exports = { db, queries };
