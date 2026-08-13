/**
 * db/seed-team.js — one-time, idempotent bootstrap for the new staff-portal
 * features (My Clients, Points, Team Assignments). Two real gaps this
 * closes, found by inspection, not invented:
 *
 *   1. routes/portal-team-auth.js's bootstrap only ever auto-creates ONE
 *      portal-users.json account (Tommy, from PORTAL_ADMIN_PASSWORD).
 *      routes/ops-my-tasks.js's ADMIN_EMAILS/MANAGER_EMAILS/BRAND_MANAGERS
 *      already treat Daniel, Hasan, Shayan, and Gourab as real teammates
 *      with real trust levels — they just have no account record, so
 *      routes/staff-portal.js's currentStaffUser() can never resolve them
 *      and the new features show empty/degraded for all four.
 *   2. db/brand-assignments.js's brand_assignments table has been sitting
 *      empty since it was created — routes/ops-my-tasks.js's BRAND_MANAGERS
 *      already encodes real, actively-maintained staff-to-brand knowledge
 *      (confirmed still being edited in production) that was never wired
 *      into it.
 *
 * Permission levels mirror EXISTING trust tiers already encoded elsewhere
 * in this app, not new grants: Daniel/Hasan get 'full' because
 * ADMIN_EMAILS already trusts them as admins; Shayan/Gourab get no
 * elevated permissions because they only ever appear as brand managers,
 * never as admins.
 *
 * Passwords are generated fresh at creation time (crypto.randomBytes) --
 * never hardcoded, never committed to source, never persisted anywhere
 * except the one-time console log line printed the moment each account is
 * created (same "show a secret exactly once" pattern PORTAL_ADMIN_PASSWORD
 * already relies on for Tommy's bootstrap account). Whoever has server/
 * deploy-log access at creation time can hand it to that teammate directly;
 * after that, an existing user_admin holder (Tommy already has one) can set
 * a new password for them anytime via PATCH /portal-admin/users/:id. Nobody
 * strictly needs a password at all, though: routes/staff-portal.js also
 * resolves identity from the Cloudflare-Access-authenticated email alone,
 * no password required, for every read in the new portal.
 *
 * Safe to run on every boot: createUser() is skipped (not overwritten) if
 * the account already exists, and assignBrand()'s ON CONFLICT upsert makes
 * re-running the assignment seed a no-op after the first successful run.
 */

const crypto = require('crypto');

function genPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, (m) => ({ '+': '8', '/': '9', '=': 'x' }[m]));
}

const TEAM_ROSTER = [
  { username: 'daniel', email: 'daniel@cultcontent.cc', name: 'Daniel', role: 'admin', permissions: 'full' },
  { username: 'hasan', email: 'hasan@cultcontent.cc', name: 'Hasan', role: 'admin', permissions: 'full' },
  { username: 'shayan', email: 'shayan@cultcontent.cc', name: 'Shayan', role: 'member', permissions: [] },
  { username: 'gourab', email: 'gourab@cultcontent.cc', name: 'Gourab', role: 'member', permissions: [] },
];

function normalizeBrandName(s) {
  return String(s || '').trim().toLowerCase();
}

function seedTeamAccounts({ createUser, findByUsername }) {
  for (const person of TEAM_ROSTER) {
    if (findByUsername(person.email)) {
      console.log(`[seed-team] ${person.email} already has an account — skipped`);
      continue;
    }
    const password = genPassword();
    try {
      createUser({
        username: person.username,
        email: person.email,
        name: person.name,
        password,
        role: person.role,
        permissions: person.permissions,
        createdBy: 'seed-team',
      });
      // One-time display, matching PORTAL_ADMIN_PASSWORD's existing "shared
      // secret lives in the environment/logs, not in source" convention --
      // this is the ONLY place this value is ever written down.
      console.log(`[seed-team] created account "${person.username}" (${person.email}, ${person.permissions === 'full' ? 'full permissions' : 'baseline permissions'}) -- one-time password: ${password}`);
    } catch (e) {
      console.error(`[seed-team] failed to create ${person.email}:`, e.message);
    }
  }
}

function seedBrandAssignments({ findByUsername, loadBrands, brandAssignments, brandManagers }) {
  const brands = loadBrands();
  const byName = new Map((brands.clients || []).map((b) => [normalizeBrandName(b.name), b]));

  let assigned = 0;
  const unmatched = [];
  for (const [email, brandNames] of Object.entries(brandManagers || {})) {
    const staffUser = findByUsername(email);
    if (!staffUser) {
      console.log(`[seed-team] skipping brand assignments for ${email} — no account yet`);
      continue;
    }
    for (const brandName of brandNames) {
      const brand = byName.get(normalizeBrandName(brandName));
      if (!brand) {
        unmatched.push(`"${brandName}" (for ${email})`);
        continue;
      }
      try {
        brandAssignments.assignBrand(brand.id, staffUser.id, 'primary', 'seed-team');
        assigned++;
      } catch (e) {
        console.error(`[seed-team] failed to assign ${brandName} -> ${email}:`, e.message);
      }
    }
  }
  console.log(`[seed-team] brand_assignments seed: ${assigned} assigned` + (unmatched.length ? `, ${unmatched.length} unmatched (exact-name-match only, by design -- assign these manually via Team Assignments): ${unmatched.join(', ')}` : ', 0 unmatched'));
}

function seedTeamAndAssignments({ portalTeamAuth, loadBrands }) {
  if (!portalTeamAuth) return;
  let brandAssignments;
  try {
    brandAssignments = require('./brand-assignments');
  } catch (e) {
    console.error('[seed-team] could not load db/brand-assignments, skipping assignment seed:', e.message);
    seedTeamAccounts(portalTeamAuth);
    return;
  }
  let brandManagers = {};
  try {
    brandManagers = require('../routes/ops-my-tasks').BRAND_MANAGERS || {};
  } catch (e) {
    console.error('[seed-team] could not load BRAND_MANAGERS from routes/ops-my-tasks, skipping assignment seed:', e.message);
  }

  seedTeamAccounts(portalTeamAuth);
  seedBrandAssignments({ ...portalTeamAuth, loadBrands, brandAssignments, brandManagers });
}

module.exports = { seedTeamAndAssignments, TEAM_ROSTER };
