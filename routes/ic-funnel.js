/**
 * ic-funnel.js — canonical Inner Circle funnel-state mapping.
 *
 * WHY THIS EXISTS: the Inner Circle UI needs to distinguish, per creator,
 * between "signed up", "target collab accepted", "sample requested/shipped",
 * and "posted" — but Reacher's per-creator boolean fields
 * (tc_invited / tc_accepted / sample_requested) come back NULL and CANNOT be
 * trusted. The only reliable signal is Reacher's `stage` string. This module
 * maps that string to ONE canonical funnel state so the rest of the app never
 * has to re-interpret raw Reacher vocabulary.
 *
 * Canonical states (single source of truth):
 *   'tc_invited'        — target collab invited, no acceptance/activity yet (Idle)
 *   'tc_accepted'       — collab accepted / creator actively showcasing product
 *   'sample_requested'  — sample requested (not yet shipped)
 *   'sample_shipped'    — sample shipped to creator
 *   'posted'            — content posted / collab completed
 *   'expired'           — sample request / collab expired
 *   'idle'              — explicitly idle (alias kept for callers that want it)
 *   'unknown'           — unrecognized / empty stage
 *
 * Observed Reacher `stage` values (shop 10021):
 *   'Idle', 'Showcasing Product', 'Sample Shipped',
 *   'Sample Request Expired', 'Completed'
 *
 * IMPORTANT: derive state from `stage` ONLY. Do not read tc_invited /
 * tc_accepted / sample_requested booleans — they are null in Reacher.
 */

'use strict';

// Normalized-lowercase Reacher stage -> canonical funnel state.
const STAGE_MAP = {
  'idle': 'tc_invited',                  // invited via target collab, no activity yet
  'showcasing product': 'tc_accepted',   // accepted collab / sample requested / showcasing
  'sample requested': 'sample_requested',
  'sample shipped': 'sample_shipped',
  'sample request expired': 'expired',
  'completed': 'posted',
};

/**
 * Map a Reacher `stage` string to a canonical funnel state.
 * Pure, side-effect-free. Trims + lowercases for resilient matching.
 *
 * @param {string} stage - raw Reacher stage string
 * @returns {('tc_invited'|'tc_accepted'|'sample_requested'|'sample_shipped'|'posted'|'expired'|'idle'|'unknown')}
 */
function reacherStageToFunnel(stage) {
  if (stage == null) return 'unknown';
  const key = String(stage).trim().toLowerCase();
  if (!key) return 'unknown';
  return STAGE_MAP[key] || 'unknown';
}

/** Ordered canonical funnel states (signup -> posted), for UI/sorting. */
const FUNNEL_ORDER = [
  'tc_invited',
  'tc_accepted',
  'sample_requested',
  'sample_shipped',
  'posted',
  'expired',
  'idle',
  'unknown',
];

module.exports = { reacherStageToFunnel, STAGE_MAP, FUNNEL_ORDER };
