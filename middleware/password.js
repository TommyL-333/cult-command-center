/**
 * middleware/password.js — one scrypt implementation, shared.
 *
 * Two independent hand-rolled scrypt implementations existed before this:
 * routes/inner-circle-sqlite.js and routes/portal-team-auth.js. Both used the
 * identical core algorithm (scrypt, 16-byte random salt, 64-byte derived key,
 * hex encoding, crypto.timingSafeEqual comparison) — confirmed by reading
 * both side by side before consolidating — but serialized the result
 * differently:
 *   - inner-circle-sqlite.js stores one combined "salt:hash" string
 *     (inner_circle_creators.password_hash)
 *   - portal-team-auth.js stores salt and hash as two separate fields
 *     (portal-users.json .salt / .passwordHash)
 *
 * This module keeps ONE real implementation (scryptHash/scryptVerify,
 * operating on {salt, hash}) and exposes both existing storage shapes as
 * thin wrappers on top, so each caller's on-disk data format — and therefore
 * every already-stored credential — keeps working unchanged. Nothing about
 * how passwords are verified changes; this is a relocation, not a rewrite.
 *
 * bcrypt (used for brand/client portal passwords, dashboard-server.js) is
 * DELIBERATELY NOT touched here. Migrating that path to scrypt-with-bcrypt-
 * fallback is a real behavior change to a live login flow — it belongs in
 * its own reviewed pass, not folded into this mechanical dedup.
 */

const crypto = require('crypto');

const KEY_LENGTH = 64;

function scryptHash(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, KEY_LENGTH).toString('hex');
  return { hash, salt };
}

function scryptVerify(password, hash, salt) {
  if (!hash || !salt) return false;
  try {
    const candidate = crypto.scryptSync(String(password), salt, KEY_LENGTH).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'));
  } catch (_) {
    return false;
  }
}

// ── Combined "salt:hash" string format (routes/inner-circle-sqlite.js) ──────
function hashPasswordCombined(password) {
  const { hash, salt } = scryptHash(password);
  return salt + ':' + hash;
}
function verifyPasswordCombined(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  return scryptVerify(password, hash, salt);
}

// ── Split {hash, salt} format (routes/portal-team-auth.js) ──────────────────
function hashPasswordSplit(password, salt) {
  return scryptHash(password, salt);
}
function verifyPasswordSplit(password, hash, salt) {
  return scryptVerify(password, hash, salt);
}

module.exports = {
  // low-level, format-agnostic
  scryptHash,
  scryptVerify,
  // inner-circle-sqlite.js call shape
  hashPasswordCombined,
  verifyPasswordCombined,
  // portal-team-auth.js call shape
  hashPasswordSplit,
  verifyPasswordSplit,
};
