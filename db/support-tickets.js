/**
 * Support Tickets SQLite schema + query helpers.
 * Reuses the existing cult-command-center Railway volume DB at /data/inner_circle.db
 * (same handle pattern as db/inner-circle.js and db/content-studio.js — no
 * separate service / volume needed).
 *
 * One ticket = one question/concern/suggestion, submitted either by a client
 * (brand_id/brand_name set, submitter_type='client'), a creator
 * (creator_id/creator_name/creator_handle set, submitter_type='creator'), or
 * a Discord @Support mention (discord_* columns set, submitter_type='discord'
 * — see lib/discord-bot.js, which is where these rows actually get created).
 * A creator/Discord ticket isn't tied to one brand, so brand_id/brand_name are
 * left as empty string on those rather than relaxing the NOT NULL constraint
 * on an already-deployed column.
 *
 * Status is exactly one of: unopened | opened | flagged. Moving a ticket to
 * "opened" records which teammate opened it.
 *
 * ticket_replies holds staff replies typed in the webapp. For discord
 * tickets, lib/discord-bot.js also posts the reply back into the originating
 * thread — this table is just the durable record of what was said.
 */

// Connection (WAL mode, foreign keys, busy_timeout, boot-time checkpoint) is
// owned by db/connection.js and shared across every db/*.js schema file. The
// WAL-checkpoint-on-boot defensive compaction that used to live here (this was
// the last of the three modules to load, so it did the checkpoint) now lives
// in db/connection.js instead, since that's the single connection owner.
const { db } = require('./connection');

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

// Idempotent column additions for creator support — safe to run on every
// boot against a table that may already exist (and may already have rows)
// from before creators were added. SQLite has no "ADD COLUMN IF NOT EXISTS",
// so each is wrapped and the "duplicate column name" error is swallowed.
function addColumnIfMissing(def) {
  try { db.exec(`ALTER TABLE support_tickets ADD COLUMN ${def}`); }
  catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
}
addColumnIfMissing(`submitter_type TEXT NOT NULL DEFAULT 'client'`); // client | creator | discord
addColumnIfMissing(`creator_id INTEGER`);
addColumnIfMissing(`creator_name TEXT`);
addColumnIfMissing(`creator_handle TEXT`);
addColumnIfMissing(`submitter_email TEXT`); // snapshot at submission time, not looked up live

// Discord-sourced tickets (lib/discord-bot.js). discord_channel_name is the
// whole point of the per-channel-topic ask: staff see it as the ticket
// "topic" instead of having to dig through which of many channels a mention
// came from. discord_thread_id is the reply target — the bot opens a thread
// on the triggering message, and staff replies get posted into that thread.
addColumnIfMissing(`discord_guild_id TEXT`);
addColumnIfMissing(`discord_channel_id TEXT`);
addColumnIfMissing(`discord_channel_name TEXT`);
addColumnIfMissing(`discord_thread_id TEXT`);
addColumnIfMissing(`discord_message_url TEXT`);
addColumnIfMissing(`discord_author_id TEXT`);
addColumnIfMissing(`discord_author_tag TEXT`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_support_tickets_creator ON support_tickets(creator_id)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS ticket_replies (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id    INTEGER NOT NULL REFERENCES support_tickets(id),
    author_email TEXT NOT NULL,
    author_name  TEXT NOT NULL,
    body         TEXT NOT NULL,
    delivered    INTEGER NOT NULL DEFAULT 0,  -- 1 once the Discord bot has posted it back
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_ticket_replies_ticket ON ticket_replies(ticket_id);
`);

const queries = {
  insertClientTicket: db.prepare(`
    INSERT INTO support_tickets (brand_id, brand_name, type, message, submitter_type, submitter_email)
    VALUES (?, ?, ?, ?, 'client', ?)`),

  insertCreatorTicket: db.prepare(`
    INSERT INTO support_tickets (brand_id, brand_name, type, message, submitter_type, creator_id, creator_name, creator_handle, submitter_email)
    VALUES ('', NULL, ?, ?, 'creator', ?, ?, ?, ?)`),

  getTicketsForBrand: db.prepare(`
    SELECT * FROM support_tickets WHERE brand_id = ? AND submitter_type = 'client' ORDER BY created_at DESC`),

  getTicketsForCreator: db.prepare(`
    SELECT * FROM support_tickets WHERE creator_id = ? AND submitter_type = 'creator' ORDER BY created_at DESC`),

  insertDiscordTicket: db.prepare(`
    INSERT INTO support_tickets (
      brand_id, brand_name, type, message, submitter_type,
      discord_guild_id, discord_channel_id, discord_channel_name,
      discord_thread_id, discord_message_url, discord_author_id, discord_author_tag
    ) VALUES ('', NULL, 'question', ?, 'discord', ?, ?, ?, ?, ?, ?, ?)`),

  getTicketById: db.prepare(`SELECT * FROM support_tickets WHERE id = ?`),

  getTicketByThreadId: db.prepare(`SELECT * FROM support_tickets WHERE discord_thread_id = ?`),

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

  insertReply: db.prepare(`
    INSERT INTO ticket_replies (ticket_id, author_email, author_name, body, delivered)
    VALUES (?, ?, ?, ?, ?)`),

  markReplyDelivered: db.prepare(`UPDATE ticket_replies SET delivered = 1 WHERE id = ?`),

  getRepliesForTicket: db.prepare(`SELECT * FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at ASC`),
};

module.exports = { db, queries };
