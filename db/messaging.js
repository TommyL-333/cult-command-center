/**
 * db/messaging.js — universal messaging system (Phase 5 of the platform
 * rebuild). One thread/message model shared by creators, brands, and staff —
 * this is where contract proposals land (see db/proposals.js, which links a
 * proposal to a thread via context_type/context_id) and, longer-term, any
 * other direct-message use case between the three audiences.
 *
 * Deliberately kept separate from support_tickets (db/support-tickets.js) —
 * that system is already multi-audience-aware and working; merging it into
 * this one would risk regressing it for no benefit. A ticket can link to a
 * thread later via an optional thread_id column if that's ever needed.
 */

const { db } = require('./connection');

db.exec(`
  CREATE TABLE IF NOT EXISTS message_threads (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    subject      TEXT,
    context_type TEXT,              -- 'proposal' | NULL (generic thread)
    context_id   INTEGER,           -- proposals.id when context_type='proposal'
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS thread_participants (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id         INTEGER NOT NULL REFERENCES message_threads(id),
    participant_type  TEXT NOT NULL,   -- 'creator' | 'brand' | 'staff'
    participant_id    TEXT NOT NULL,
    last_read_at      DATETIME,
    UNIQUE(thread_id, participant_type, participant_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id     INTEGER NOT NULL REFERENCES message_threads(id),
    sender_type   TEXT NOT NULL,    -- 'creator' | 'brand' | 'staff' | 'system'
    sender_id     TEXT,             -- NULL for system messages
    body          TEXT NOT NULL,
    message_type  TEXT NOT NULL DEFAULT 'text',  -- 'text' | 'system'
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_thread_participants_thread ON thread_participants(thread_id);
  CREATE INDEX IF NOT EXISTS idx_thread_participants_person  ON thread_participants(participant_type, participant_id);
  CREATE INDEX IF NOT EXISTS idx_messages_thread             ON messages(thread_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_threads_context             ON message_threads(context_type, context_id);
`);

const insertThreadStmt = db.prepare(`INSERT INTO message_threads (subject, context_type, context_id) VALUES (?, ?, ?)`);
const insertParticipantStmt = db.prepare(`
  INSERT INTO thread_participants (thread_id, participant_type, participant_id) VALUES (?, ?, ?)
  ON CONFLICT(thread_id, participant_type, participant_id) DO NOTHING
`);
const insertMessageStmt = db.prepare(`
  INSERT INTO messages (thread_id, sender_type, sender_id, body, message_type) VALUES (?, ?, ?, ?, ?)
`);
const isParticipantStmt = db.prepare(`
  SELECT 1 FROM thread_participants WHERE thread_id = ? AND participant_type = ? AND participant_id = ?
`);
const markReadStmt = db.prepare(`
  UPDATE thread_participants SET last_read_at = CURRENT_TIMESTAMP
  WHERE thread_id = ? AND participant_type = ? AND participant_id = ?
`);
const getThreadStmt = db.prepare(`SELECT * FROM message_threads WHERE id = ?`);
const getParticipantsStmt = db.prepare(`SELECT participant_type, participant_id, last_read_at FROM thread_participants WHERE thread_id = ?`);
const getMessagesStmt = db.prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC`);
const threadsForParticipantStmt = db.prepare(`
  SELECT t.* FROM message_threads t
  JOIN thread_participants p ON p.thread_id = t.id
  WHERE p.participant_type = ? AND p.participant_id = ?
  ORDER BY t.id DESC
`);
const lastMessageStmt = db.prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`);
const unreadCountStmt = db.prepare(`
  SELECT COUNT(*) AS n FROM messages m
  WHERE m.thread_id = ? AND m.created_at > COALESCE(
    (SELECT last_read_at FROM thread_participants WHERE thread_id = ? AND participant_type = ? AND participant_id = ?),
    '1970-01-01'
  )
`);

/**
 * createThread({ subject, contextType, contextId, participants })
 * participants: [{ type, id }, ...] — every participant is added in one
 * transaction so a thread never exists with zero/partial participants.
 */
function createThread({ subject = null, contextType = null, contextId = null, participants = [] }) {
  const tx = db.transaction(() => {
    const info = insertThreadStmt.run(subject, contextType, contextId);
    const threadId = info.lastInsertRowid;
    for (const p of participants) {
      insertParticipantStmt.run(threadId, p.type, String(p.id));
    }
    return threadId;
  });
  return tx();
}

function addMessage(threadId, { senderType, senderId = null, body, messageType = 'text' }) {
  if (!body || !body.trim()) throw new Error('message body is required');
  const info = insertMessageStmt.run(threadId, senderType, senderId != null ? String(senderId) : null, body, messageType);
  return info.lastInsertRowid;
}

/** System messages (e.g. "Brand countered with new terms") — same shape, no human sender. */
function addSystemMessage(threadId, body) {
  return addMessage(threadId, { senderType: 'system', senderId: null, body, messageType: 'system' });
}

function isParticipant(threadId, type, id) {
  return !!isParticipantStmt.get(threadId, type, String(id));
}

function markThreadRead(threadId, type, id) {
  markReadStmt.run(threadId, type, String(id));
}

function getThread(threadId) {
  const thread = getThreadStmt.get(threadId);
  if (!thread) return null;
  thread.participants = getParticipantsStmt.all(threadId);
  return thread;
}

function getMessages(threadId) {
  return getMessagesStmt.all(threadId);
}

/** Threads a participant is in, with a last-message preview + unread count — the inbox list view. */
function getThreadsForParticipant(type, id) {
  const threads = threadsForParticipantStmt.all(type, String(id));
  return threads.map((t) => ({
    ...t,
    participants: getParticipantsStmt.all(t.id),
    lastMessage: lastMessageStmt.get(t.id) || null,
    unreadCount: unreadCountStmt.get(t.id, t.id, type, String(id)).n,
  }));
}

module.exports = {
  db,
  createThread,
  addMessage,
  addSystemMessage,
  isParticipant,
  markThreadRead,
  getThread,
  getMessages,
  getThreadsForParticipant,
};
