/**
 * db/connection.js — single shared better-sqlite3 connection to inner_circle.db.
 *
 * Previously db/inner-circle.js, db/content-studio.js, and db/support-tickets.js
 * each opened their OWN `new Database(...)` handle to the same underlying file.
 * WAL mode tolerates multiple connections to one file, so this wasn't corrupting
 * anything, but it meant pragma/cache setup ran 3x and there was no single place
 * to reason about the connection or add new schema (e.g. brands, messaging).
 *
 * This module is now the one place that opens the handle. Every db/*.js schema
 * file should `const { db } = require('./connection');` instead of opening its
 * own — schema files stay responsible for their own `CREATE TABLE IF NOT EXISTS`
 * + prepared statements, just against this shared handle.
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
db.pragma('busy_timeout = 5000'); // fail fast on real lock contention rather than an implicit default

// Defensive WAL compaction on boot (moved here from db/support-tickets.js, which
// used to be the last of the three connections to load — now this module owns it
// since it's the single connection for the whole file). If something prevents
// SQLite's automatic WAL checkpoint from ever running, the write-ahead log can
// grow very large and reads become genuinely, unboundedly slow — not "locked",
// just real I/O work, which looks like a silent hang. TRUNCATE on every boot is
// defensive compaction; a large `log` count here is direct evidence of that.
try {
  const [{ busy, log, checkpointed }] = db.pragma('wal_checkpoint(TRUNCATE)');
  console.log(`[db/connection] WAL checkpoint — busy=${busy} log=${log} checkpointed=${checkpointed}`);
} catch (e) {
  console.error('[db/connection] WAL checkpoint failed:', e.message);
}

module.exports = { db, DB_PATH, DATA_DIR };
