/**
 * ghl-contact-resolver.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GHL contact resolution + completeness gating for the Target Collab (TC) flow.
 *
 * Purpose: TikTok Target Collab invites should only fire for creators whose CRM
 * record is COMPLETE — i.e. we can actually reach them and attribute them. A
 * half-filled contact (no phone, no name) is not a viable match key and must be
 * skipped before any TC send is attempted.
 *
 * This module exposes `isContactComplete(contact)` which validates a GHL contact
 * object against the required-field set and returns a structured result the TC
 * send path can branch on.
 *
 * ── Completeness contract ───────────────────────────────────────────────────
 *   Required fields:  phone, email, firstName, lastName
 *
 *   Minimum viable match key:  phone + firstName + lastName must ALL be present.
 *   (email is also required for a "complete" contact, but the match key — the
 *   identity we key the TC send on — is phone + name.)
 *
 *   A field is considered PRESENT when, after trimming, it is a non-empty string
 *   (or a non-null/non-undefined value coerced to a non-empty trimmed string).
 *
 * Returns: { complete: boolean, missing: string[] }
 *   - complete: true only when every required field is present.
 *   - missing:  the required field names that are absent, in declaration order.
 */

'use strict';

/** Fields that must all be present for a contact to count as "complete". */
const REQUIRED_FIELDS = ['phone', 'email', 'firstName', 'lastName'];

/**
 * Fields that form the minimum viable match key used to key a TC send.
 * Exported for callers that want to gate on the match key specifically.
 */
const MATCH_KEY_FIELDS = ['phone', 'firstName', 'lastName'];

/**
 * True when a value, once coerced to a trimmed string, is non-empty.
 * Handles undefined, null, numbers (e.g. phone as number), and whitespace.
 * @param {*} value
 * @returns {boolean}
 */
function isPresent(value) {
  if (value === null || value === undefined) return false;
  return String(value).trim().length > 0;
}

/**
 * Validate a GHL contact for TC-send eligibility.
 *
 * @param {object} [contact] - GHL contact object (phone, email, firstName, lastName).
 * @returns {{ complete: boolean, missing: string[] }}
 */
function isContactComplete(contact) {
  const c = contact && typeof contact === 'object' ? contact : {};
  const missing = REQUIRED_FIELDS.filter((field) => !isPresent(c[field]));
  return {
    complete: missing.length === 0,
    missing,
  };
}

/**
 * True when the minimum viable match key (phone + firstName + lastName) is
 * fully present, regardless of email. Useful when email is unavailable but a
 * keyed send is still possible.
 *
 * @param {object} [contact]
 * @returns {boolean}
 */
function hasMatchKey(contact) {
  const c = contact && typeof contact === 'object' ? contact : {};
  return MATCH_KEY_FIELDS.every((field) => isPresent(c[field]));
}

module.exports = {
  isContactComplete,
  hasMatchKey,
  isPresent,
  REQUIRED_FIELDS,
  MATCH_KEY_FIELDS,
};
