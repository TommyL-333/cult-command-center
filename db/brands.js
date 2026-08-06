/**
 * db/brands.js — SQLite mirror of brands.json (dual-write phase).
 *
 * brands.json is the core clients/brands table for this app — read/written via
 * full-file rewrite with no locking, currently the biggest data-layer risk once
 * brand/creator self-serve write traffic exists alongside staff writes. This
 * module does NOT replace brands.json yet. It's step one of a
 * shim -> dual-write -> backfill -> verify -> cutover migration:
 *
 *   1. (this file)          Add a `brands` table + a sync function.
 *   2. (dashboard-server.js) Wrap saveBrands() so every write also syncs here.
 *   3. (one-off script)      Backfill: sync every existing brand once on boot.
 *   4. (future phase)        Verify SQLite reads match JSON reads (diff tooling),
 *                            only then flip the READ path over behind a flag.
 *
 * Brand objects have a loosely-defined, evolving shape (confirmed by inspecting
 * real data — fields like `contacts`, `products`, `pipelineStage` vary brand to
 * brand and new fields get added ad hoc). Rather than a lossy up-front schema,
 * this table pulls out a handful of columns worth indexing/querying directly and
 * keeps the full object in `raw_json` as the row's source of truth. `raw_json`
 * is what JSON.parse(brands.json).clients is reconstructed from once SQLite
 * becomes authoritative in a later phase.
 */

const { db } = require('./connection');

db.exec(`
  CREATE TABLE IF NOT EXISTS brands (
    id                TEXT PRIMARY KEY,
    name              TEXT,
    login_email       TEXT,
    billing_email     TEXT,
    tiktok_handle     TEXT,
    pipeline_stage    TEXT,
    staff_assignee_id TEXT,             -- NULL until Phase: "My Clients" assigns an owner
    raw_json          TEXT NOT NULL,    -- full brand object, source of truth for now
    synced_at         DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_brands_staff_assignee ON brands(staff_assignee_id);
  CREATE INDEX IF NOT EXISTS idx_brands_login_email     ON brands(login_email);
`);

const upsertStmt = db.prepare(`
  INSERT INTO brands (id, name, login_email, billing_email, tiktok_handle, pipeline_stage, raw_json, synced_at)
  VALUES (@id, @name, @loginEmail, @billingEmail, @tiktokHandle, @pipelineStage, @rawJson, CURRENT_TIMESTAMP)
  ON CONFLICT(id) DO UPDATE SET
    name           = excluded.name,
    login_email    = excluded.login_email,
    billing_email  = excluded.billing_email,
    tiktok_handle  = excluded.tiktok_handle,
    pipeline_stage = excluded.pipeline_stage,
    raw_json       = excluded.raw_json,
    synced_at      = CURRENT_TIMESTAMP
`);

/**
 * syncBrandsToSqlite(clients)
 * Upserts every brand from the given array (the full brands.json `.clients`
 * list) into the `brands` table, and removes any SQLite row whose id is no
 * longer present in the array (keeps the mirror honest after a brand delete).
 * Call this after every saveBrands() write, and once at boot to backfill.
 */
function syncBrandsToSqlite(clients = []) {
  const tx = db.transaction((list) => {
    for (const brand of list) {
      if (!brand || !brand.id) continue;
      upsertStmt.run({
        id:             String(brand.id),
        name:           brand.name || null,
        loginEmail:     brand.loginEmail || null,
        billingEmail:   brand.billingEmail || null,
        tiktokHandle:   brand.tiktokHandle || null,
        pipelineStage:  brand.pipelineStage || null,
        rawJson:        JSON.stringify(brand),
      });
    }
    const ids = list.map((b) => b && b.id).filter(Boolean).map(String);
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM brands WHERE id NOT IN (${placeholders})`).run(...ids);
    } else {
      db.prepare('DELETE FROM brands').run();
    }
  });
  try {
    tx(clients);
  } catch (e) {
    console.error('[db/brands] sync failed:', e.message);
  }
}

module.exports = { db, syncBrandsToSqlite };
