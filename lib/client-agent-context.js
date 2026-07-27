// lib/client-agent-context.js
// Client Agent — deterministic data layer, Phase 1 of the roadmap.
//
// getCompletedTasks(brandName, { start, end }, helpers) returns every Ops
// Engine task completed for a given client within a date range — the "tasks
// completed by Cult Content for them" section of the weekly report.
//
// Deliberately has ZERO LLM involvement. This is pure data-fetching and
// filtering, reusing the exact same Lark Bitable helpers the admin task view
// already uses (routes/ops-my-tasks.js exposes them via `_helpers`, added
// specifically "for later steps" — this is that later step).

'use strict';

/**
 * @param {string} brandName - must match the task's resolved `client` field
 *   (case-insensitive, trimmed) — this is the same brand name shown in the
 *   admin task view's client column.
 * @param {{start: number, end: number}} range - Unix ms timestamps, inclusive.
 *   Lark Bitable "Completed On" fields are stored as ms-epoch numbers.
 * @param {{listAllTaskRecords: Function, getClientsMap: Function, shapeTask: Function}} helpers
 *   - pass `require('../routes/ops-my-tasks')._helpers` (only valid AFTER
 *   that module has been mounted once, since the helpers are attached to the
 *   factory function as a side effect of running it).
 * @returns {Promise<Array<{task: string, pillar: string, priority: string,
 *   ownerName: string, completedOn: number}>>}
 */
async function getCompletedTasks(brandName, range, helpers) {
  const { listAllTaskRecords, getClientsMap, shapeTask } = helpers || {};
  if (!listAllTaskRecords || !getClientsMap || !shapeTask) {
    throw new Error('getCompletedTasks: missing helpers — pass require(\'../routes/ops-my-tasks\')._helpers');
  }
  const { start, end } = range || {};
  if (!brandName) throw new Error('getCompletedTasks: brandName required');
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error('getCompletedTasks: range.start and range.end must be numeric ms timestamps');
  }

  const targetBrand = brandName.trim().toLowerCase();

  const [records, clientsMap] = await Promise.all([
    listAllTaskRecords(),
    getClientsMap(),
  ]);

  const completed = [];
  for (const rec of records) {
    const shaped = shapeTask(rec, clientsMap);
    if (shaped.status !== 'Completed') continue;
    if (!shaped.completedOn) continue;
    if (shaped.completedOn < start || shaped.completedOn > end) continue;
    if ((shaped.client || '').trim().toLowerCase() !== targetBrand) continue;

    completed.push({
      task: shaped.task,
      pillar: shaped.pillar,
      priority: shaped.priority,
      ownerName: shaped.ownerName,
      completedOn: shaped.completedOn,
    });
  }

  // Most recently completed first — reads better in a weekly report.
  completed.sort((a, b) => b.completedOn - a.completedOn);
  return completed;
}

module.exports = { getCompletedTasks };
