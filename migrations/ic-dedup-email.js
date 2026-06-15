#!/usr/bin/env node
/**
 * migrations/ic-dedup-email.js
 *
 * De-duplicate Inner Circle creator accounts that share the same email
 * (case-insensitive, trimmed). Keep the OLDEST row (MIN(id)) per email group,
 * merge any non-null fields the keeper is missing from its duplicates, reassign
 * child rows (videos + brand assignments) from the dup id -> keeper id, then
 * delete the orphan duplicate rows. Everything runs in a single transaction.
 *
 * Usage:
 *   node migrations/ic-dedup-email.js --dry-run   # plan only, no writes
 *   node migrations/ic-dedup-email.js             # apply
 *
 * Output: a JSON report { dryRun, groups, merged, deleted, keptIds, plan }
 *
 * NOTE: The Inner Circle DB is driven by better-sqlite3 throughout this repo
 * (db/inner-circle.js, routes/inner-circle-sqlite.js). We use the same driver
 * here rather than node:sqlite so the script behaves identically to the live
 * app and avoids a second, divergent SQLite binding. The DB path matches
 * db/inner-circle.js exactly: $DATA_DIR/inner_circle.db (default /data).
 *
 * Real schema (verified against migrations + the runtime ALTERs in
 * routes/inner-circle-sqlite.js):
 *   inner_circle_creators(
 *     id, creator_handle, creator_name, email, tiktok_user_id, status,
 *     cohort_start, cohort_end, videos_goal, commission_rate,
 *     ads_commission_rate, created_at, updated_at, phone, password_hash )
 *   inner_circle_videos(creator_id ...)
 *   inner_circle_brand_assignments(creator_id ...)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DRY_RUN = process.argv.includes('--dry-run');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_PATH = process.env.IC_DB_PATH || path.join(DATA_DIR, 'inner_circle.db');

// Fields that may be back-filled onto the keeper from a duplicate when the
// keeper's value is NULL/empty. Order does not matter; first non-empty wins.
const MERGE_FIELDS = [
  'password_hash',
  'phone',
  'tiktok_user_id',
  'creator_name',
  'cohort_start',
  'cohort_end',
];

// Child tables whose creator_id must be re-pointed from dup -> keeper.
const CHILD_TABLES = [
  'inner_circle_videos',
  'inner_circle_brand_assignments',
];

function isEmpty(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function tableExists(db, name) {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name);
  return !!row;
}

function columnExists(db, table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === col);
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.log(
      JSON.stringify(
        { error: `DB not found at ${DB_PATH}`, dryRun: DRY_RUN, merged: 0, deleted: 0, keptIds: [] },
        null,
        2
      )
    );
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = OFF'); // we re-point children manually; keep refs intact during moves

  if (!tableExists(db, 'inner_circle_creators')) {
    console.log(
      JSON.stringify(
        { error: 'inner_circle_creators table missing', dryRun: DRY_RUN, merged: 0, deleted: 0, keptIds: [] },
        null,
        2
      )
    );
    db.close();
    process.exit(1);
  }

  // Only operate on merge fields / child tables that actually exist (defensive).
  const mergeFields = MERGE_FIELDS.filter((f) => columnExists(db, 'inner_circle_creators', f));
  const childTables = CHILD_TABLES.filter(
    (t) => tableExists(db, t) && columnExists(db, t, 'creator_id')
  );

  // 1) Find duplicate email groups (case-insensitive, trimmed). Ignore NULL/blank emails.
  const dupGroups = db
    .prepare(
      `SELECT lower(trim(email)) AS norm_email, COUNT(*) AS cnt
         FROM inner_circle_creators
        WHERE email IS NOT NULL AND trim(email) <> ''
        GROUP BY lower(trim(email))
       HAVING COUNT(*) > 1
        ORDER BY norm_email`
    )
    .all();

  const getGroupRows = db.prepare(
    `SELECT * FROM inner_circle_creators
      WHERE lower(trim(email)) = ?
      ORDER BY id ASC`
  );

  // Build the plan.
  const plan = [];
  const keptIds = [];
  let mergedCount = 0;
  let deletedCount = 0;

  for (const g of dupGroups) {
    const rows = getGroupRows.all(g.norm_email);
    if (rows.length < 2) continue;

    const keeper = rows[0]; // MIN(id) — oldest
    const dups = rows.slice(1);
    keptIds.push(keeper.id);

    // Determine field back-fills the keeper is missing.
    const fieldUpdates = {}; // col -> value
    for (const f of mergeFields) {
      if (!isEmpty(keeper[f])) continue;
      for (const d of dups) {
        if (!isEmpty(d[f])) {
          fieldUpdates[f] = d[f];
          break;
        }
      }
    }

    // status: prefer 'active' if keeper isn't active but a dup is.
    if (columnExists(db, 'inner_circle_creators', 'status')) {
      if (keeper.status !== 'active' && dups.some((d) => d.status === 'active')) {
        fieldUpdates.status = 'active';
      }
    }

    // Child reassignment counts (for the report) — computed live.
    const childMoves = {};
    for (const t of childTables) {
      const dupIds = dups.map((d) => d.id);
      const placeholders = dupIds.map(() => '?').join(',');
      const cnt = db
        .prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE creator_id IN (${placeholders})`)
        .get(...dupIds).c;
      childMoves[t] = cnt;
    }

    plan.push({
      email: g.norm_email,
      keeperId: keeper.id,
      keeperHandle: keeper.creator_handle,
      dupIds: dups.map((d) => d.id),
      dupHandles: dups.map((d) => d.creator_handle),
      fieldUpdates,
      childMoves,
    });

    mergedCount += dups.length;
    deletedCount += dups.length;
  }

  if (DRY_RUN) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          dbPath: DB_PATH,
          groups: plan.length,
          merged: mergedCount,
          deleted: deletedCount,
          keptIds,
          plan,
        },
        null,
        2
      )
    );
    db.close();
    return;
  }

  // 2) Apply in a single transaction.
  const applied = { merged: 0, deleted: 0, keptIds: [] };

  const runAll = db.transaction(() => {
    for (const p of plan) {
      // Back-fill keeper fields.
      const cols = Object.keys(p.fieldUpdates);
      if (cols.length) {
        const setSql = cols.map((c) => `${c} = ?`).join(', ');
        const vals = cols.map((c) => p.fieldUpdates[c]);
        db.prepare(`UPDATE inner_circle_creators SET ${setSql} WHERE id = ?`).run(
          ...vals,
          p.keeperId
        );
      }
      // Bump updated_at if present.
      if (columnExists(db, 'inner_circle_creators', 'updated_at')) {
        db.prepare(
          `UPDATE inner_circle_creators SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(p.keeperId);
      }

      // Reassign child rows dup -> keeper.
      for (const t of childTables) {
        for (const dupId of p.dupIds) {
          db.prepare(`UPDATE ${t} SET creator_id = ? WHERE creator_id = ?`).run(
            p.keeperId,
            dupId
          );
        }
      }

      // Delete orphan dup rows.
      for (const dupId of p.dupIds) {
        db.prepare(`DELETE FROM inner_circle_creators WHERE id = ?`).run(dupId);
        applied.deleted += 1;
        applied.merged += 1;
      }

      applied.keptIds.push(p.keeperId);
    }
  });

  runAll();

  console.log(
    JSON.stringify(
      {
        dryRun: false,
        dbPath: DB_PATH,
        groups: plan.length,
        merged: applied.merged,
        deleted: applied.deleted,
        keptIds: applied.keptIds,
        plan,
      },
      null,
      2
    )
  );

  db.close();
}

try {
  main();
} catch (err) {
  console.error(
    JSON.stringify({ error: err.message, stack: err.stack, dryRun: DRY_RUN }, null, 2)
  );
  process.exit(1);
}
