/**
 * db/staff-points.js — point-based task scoring, Phase 8 of the platform
 * rebuild (Employee/Ops portal).
 *
 * The existing task system (routes/ops-my-tasks.js) is entirely Lark
 * Bitable-backed — tasks live in an external base, not in this app's own
 * storage, and there's no numeric "points" field on the live Bitable schema
 * to read from (only a free-text Priority SingleSelect whose actual option
 * values aren't something this module can safely assume). Changing that
 * external schema is out of scope and out of reach here.
 *
 * So this is a NEW, purely local ledger layered on top of the existing
 * (unmodified) Lark completion flow: routes/ops-my-tasks.js's real
 * POST /api/my-tasks/complete — after it verifies the Lark write succeeded —
 * optionally records an award here if the caller supplied a point value.
 * Nothing about the Lark integration itself changes; this only adds a local
 * audit trail + leaderboard on top of real, already-verified completions.
 */

const { db } = require('./connection');

db.exec(`
  CREATE TABLE IF NOT EXISTS staff_points (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_email     TEXT NOT NULL,
    task_record_id  TEXT,
    task_title      TEXT,
    points          INTEGER NOT NULL,
    awarded_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_staff_points_email ON staff_points(staff_email);
`);

const insertStmt = db.prepare(`
  INSERT INTO staff_points (staff_email, task_record_id, task_title, points)
  VALUES (@staffEmail, @taskRecordId, @taskTitle, @points)
`);
const leaderboardStmt = db.prepare(`
  SELECT staff_email AS email, SUM(points) AS total, COUNT(*) AS task_count, MAX(awarded_at) AS last_award_at
  FROM staff_points
  GROUP BY staff_email
  ORDER BY total DESC
`);
const forStaffStmt = db.prepare(`
  SELECT id, task_record_id, task_title, points, awarded_at
  FROM staff_points
  WHERE staff_email = ?
  ORDER BY awarded_at DESC
  LIMIT 50
`);
const totalForStaffStmt = db.prepare(`
  SELECT COALESCE(SUM(points), 0) AS total, COUNT(*) AS task_count
  FROM staff_points
  WHERE staff_email = ?
`);

// "daniel.jimenez@cultcontent.cc" -> "Daniel Jimenez" — same mechanical
// transform routes/support-tickets.js already uses for the same reason
// (never invent/guess a name, derive it from the real, verified email).
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0];
  if (!local) return email || 'Unknown';
  return local
    .replace(/[._]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function awardPoints({ staffEmail, taskRecordId = null, taskTitle = null, points }) {
  if (!staffEmail) throw new Error('awardPoints: staffEmail is required');
  const n = Number(points);
  if (!Number.isFinite(n) || n <= 0) throw new Error('awardPoints: points must be a positive number');
  insertStmt.run({ staffEmail: String(staffEmail).toLowerCase(), taskRecordId, taskTitle, points: Math.round(n) });
}

function getLeaderboard() {
  return leaderboardStmt.all().map((row) => ({ ...row, name: nameFromEmail(row.email) }));
}

function getForStaff(email) {
  const normalized = String(email || '').toLowerCase();
  const totals = totalForStaffStmt.get(normalized);
  return {
    email: normalized,
    name: nameFromEmail(normalized),
    total: totals.total,
    taskCount: totals.task_count,
    recent: forStaffStmt.all(normalized),
  };
}

module.exports = { db, awardPoints, getLeaderboard, getForStaff, nameFromEmail };
