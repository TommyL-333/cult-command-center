/**
 * db/brand-assignments.js — staff-to-brand ownership, powers the "My Clients"
 * view on the employee/ops portal (a brand-new feature — no existing data to
 * migrate, unlike brands.json).
 *
 * staff_id is NOT a foreign key into a SQLite staff_users table (none exists
 * yet) — it's the `id` string from portal-users.json, looked up via
 * routes/portal-team-auth.js's existing findById() when a name/email is
 * needed. portal-users.json is a small, staff-only, low-write-frequency file
 * (a handful of team members) — nowhere near the concurrency risk brands.json
 * carries, so it doesn't need the same dual-write-shim treatment right now.
 *
 * One brand can have more than one assigned staff member (role distinguishes
 * primary owner from support), so this is a join table, not a single
 * staff_assignee_id column.
 */

const { db } = require('./connection');

db.exec(`
  CREATE TABLE IF NOT EXISTS brand_assignments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id     TEXT NOT NULL,
    staff_id     TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'primary',   -- 'primary' | 'support'
    assigned_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    assigned_by  TEXT,                              -- staff_id of whoever made the assignment
    UNIQUE(brand_id, staff_id)
  );

  CREATE INDEX IF NOT EXISTS idx_brand_assignments_staff ON brand_assignments(staff_id);
  CREATE INDEX IF NOT EXISTS idx_brand_assignments_brand ON brand_assignments(brand_id);
`);

const assignStmt = db.prepare(`
  INSERT INTO brand_assignments (brand_id, staff_id, role, assigned_by)
  VALUES (@brandId, @staffId, @role, @assignedBy)
  ON CONFLICT(brand_id, staff_id) DO UPDATE SET role = excluded.role
`);
const unassignStmt = db.prepare(`DELETE FROM brand_assignments WHERE brand_id = ? AND staff_id = ?`);
const brandsForStaffStmt = db.prepare(`SELECT brand_id, role, assigned_at FROM brand_assignments WHERE staff_id = ? ORDER BY assigned_at DESC`);
const staffForBrandStmt = db.prepare(`SELECT staff_id, role, assigned_at FROM brand_assignments WHERE brand_id = ? ORDER BY role, assigned_at`);

function assignBrand(brandId, staffId, role = 'primary', assignedBy = null) {
  if (!brandId || !staffId) throw new Error('brandId and staffId are required');
  if (!['primary', 'support'].includes(role)) throw new Error("role must be 'primary' or 'support'");
  assignStmt.run({ brandId: String(brandId), staffId: String(staffId), role, assignedBy: assignedBy ? String(assignedBy) : null });
}

function unassignBrand(brandId, staffId) {
  unassignStmt.run(String(brandId), String(staffId));
}

/** Brands assigned to a given staff member — "My Clients" data source. */
function getBrandsForStaff(staffId) {
  return brandsForStaffStmt.all(String(staffId));
}

/** Staff assigned to a given brand (primary first). */
function getStaffForBrand(brandId) {
  return staffForBrandStmt.all(String(brandId));
}

module.exports = { db, assignBrand, unassignBrand, getBrandsForStaff, getStaffForBrand };
