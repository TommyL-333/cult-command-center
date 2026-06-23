/**
 * ic-script-generator.js
 *
 * Inner Circle Content Engine — script generation core.
 * -----------------------------------------------------------------------------
 * This module owns the PURE, network-free pieces of the script-generation
 * pipeline. The HTTP route + LLM connector live elsewhere (so the model/provider
 * is swappable); this file holds the deterministic prompt construction so it can
 * be unit-tested in isolation and reused regardless of which connector calls it.
 *
 * Step 4 — buildScriptPrompt(payload, productContext):
 *   Returns a single string prompt that instructs the model to produce EXACTLY
 *   `numScripts` (default 5) TikTok Shop affiliate scripts as STRICT JSON.
 *
 *   The model is required to return JSON-only (no prose, no markdown fences),
 *   shaped as:  { "scripts": [ { ...keys... }, ... ] }
 *
 *   Each script object MUST contain exactly these keys:
 *     - hook            : the on-screen text hook (first 1-2 seconds)
 *     - credibility     : the creator's credibility / authority beat
 *     - problem         : the pain/problem the product solves
 *     - proofStack      : the stacked proof points (ingredients, results, social proof)
 *     - cta             : the call to action
 *     - visualHookIdeas : concrete visual/shot ideas for the hook
 *     - fullScript      : the complete spoken+on-screen script, ready to film
 *
 * The product/audience/funnel context is INJECTED into the prompt so the model
 * has everything it needs without a second round trip.
 *
 * Pure function: no network, no env reads that change output, no side effects.
 */

'use strict';

// Target model for the Inner Circle content engine. Kept as a constant so the
// prompt explicitly names the model contract; the connector that actually calls
// the API can override, but the generated instructions reference this model.
const TARGET_MODEL = 'claude-opus-4-8';

// Default number of scripts to request when payload.numScripts is absent.
const DEFAULT_NUM_SCRIPTS = 5;

// The exact key set every script object must contain, in canonical order.
const SCRIPT_KEYS = [
  'hook',
  'credibility',
  'problem',
  'proofStack',
  'cta',
  'visualHookIdeas',
  'fullScript',
];

// Canonical funnel stages. We always surface the TOF/MOF/BOF vocabulary so the
// model understands how to vary intent across the requested scripts.
const FUNNEL_STAGES = ['TOF', 'MOF', 'BOF'];

/**
 * Coerce a value that may be a string, array, or null/undefined into a clean,
 * human-readable comma-separated string for prompt injection. Never throws.
 */
function asList(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value
      .map((v) => (v == null ? '' : String(v).trim()))
      .filter(Boolean)
      .join(', ');
  }
  return String(value).trim();
}

/**
 * Coerce a possibly-missing scalar into a trimmed string, with a fallback
 * placeholder so the prompt always names the field (even if unspecified) —
 * this keeps the injected context explicit and unit-testable.
 */
function asText(value, fallback = 'Not specified') {
  if (value == null) return fallback;
  const s = String(value).trim();
  return s.length ? s : fallback;
}

/**
 * Resolve the requested funnel stages from the payload. Accepts an array or a
 * comma/space separated string; falls back to all three canonical stages.
 * Filters to the canonical TOF/MOF/BOF set (case-insensitive).
 */
function resolveFunnelStages(funnelStages) {
  let requested = [];
  if (Array.isArray(funnelStages)) {
    requested = funnelStages;
  } else if (typeof funnelStages === 'string' && funnelStages.trim()) {
    requested = funnelStages.split(/[\s,]+/);
  }
  const upper = requested.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  const filtered = FUNNEL_STAGES.filter((stage) => upper.includes(stage));
  return filtered.length ? filtered : FUNNEL_STAGES.slice();
}

/**
 * buildScriptPrompt(payload, productContext) → string
 *
 * @param {object} payload - Generation request fields:
 *   numScripts {number}        : how many scripts to produce (default 5)
 *   creatorAgeGroup {string}   : the creator's age group / persona
 *   credibility {string}       : freetext credibility/authority angle for the creator
 *   targetGender {string}      : audience gender target
 *   targetAgeRange {string}    : audience age range target
 *   targetInterests {string|string[]} : audience interests
 *   painPoints {string|string[]}      : audience pain points the product addresses
 *   funnelStages {string|string[]}    : TOF/MOF/BOF stages to cover
 *   scriptLength {string}      : desired script length (e.g. "30-45s")
 *   format {string}            : content format (e.g. "talking head", "UGC demo")
 *
 * @param {object} productContext - Resolved brand/product context (from
 *   product-resolver + brands.json):
 *   productName {string}       : the product's name
 *   description {string}       : product description / positioning
 *   ingredients {string|string[]} : key ingredients / components
 *
 * @returns {string} A single prompt string, JSON-output-only instructions.
 */
function buildScriptPrompt(payload, productContext) {
  const p = payload || {};
  const ctx = productContext || {};

  const numScripts =
    Number.isFinite(Number(p.numScripts)) && Number(p.numScripts) > 0
      ? Math.floor(Number(p.numScripts))
      : DEFAULT_NUM_SCRIPTS;

  // ---- Product context (injected) ----
  const productName = asText(ctx.productName, 'the product');
  const description = asText(ctx.description);
  const ingredients = asList(ctx.ingredients) || 'Not specified';

  // ---- Creator + audience context (injected) ----
  const creatorAgeGroup = asText(p.creatorAgeGroup);
  const credibility = asText(p.credibility);
  const targetGender = asText(p.targetGender, 'All');
  const targetAgeRange = asText(p.targetAgeRange);
  const targetInterests = asList(p.targetInterests) || 'Not specified';
  const painPoints = asList(p.painPoints) || 'Not specified';
  const scriptLength = asText(p.scriptLength, '30-45 seconds');
  const format = asText(p.format, 'UGC talking-head');

  const funnelStages = resolveFunnelStages(p.funnelStages);
  const funnelLine = funnelStages.join(', ');

  // The required JSON key list, rendered for the model.
  const keyList = SCRIPT_KEYS.join(', ');

  // A compact JSON shape example so the model has zero ambiguity about output.
  const shapeExample = JSON.stringify(
    {
      scripts: [
        {
          hook: 'On-screen text hook (first 1-2 seconds)',
          credibility: "The creator's credibility / authority beat",
          problem: 'The pain/problem this product solves',
          proofStack: 'Stacked proof points (ingredients, results, social proof)',
          cta: 'The call to action',
          visualHookIdeas: 'Concrete visual / shot ideas for the hook',
          fullScript: 'The complete spoken + on-screen script, ready to film',
        },
      ],
    },
    null,
    2
  );

  return [
    `You are an elite TikTok Shop affiliate scriptwriter generating short-form video scripts for the Cult Content Inner Circle creator program.`,
    `You are running as model ${TARGET_MODEL}.`,
    ``,
    `TASK: Write EXACTLY ${numScripts} distinct TikTok Shop affiliate video scripts for the product below. Each script must be a complete, ready-to-film concept that a creator can read and shoot today.`,
    ``,
    `PRODUCT`,
    `- Product name: ${productName}`,
    `- Description: ${description}`,
    `- Key ingredients / components: ${ingredients}`,
    ``,
    `CREATOR`,
    `- Creator age group: ${creatorAgeGroup}`,
    `- Creator credibility / authority angle: ${credibility}`,
    ``,
    `TARGET AUDIENCE`,
    `- Gender: ${targetGender}`,
    `- Age range: ${targetAgeRange}`,
    `- Interests: ${targetInterests}`,
    `- Pain points to address: ${painPoints}`,
    ``,
    `CREATIVE DIRECTION`,
    `- Funnel stages to cover (vary intent across the ${numScripts} scripts): ${funnelLine}`,
    `  (TOF = top of funnel / broad awareness, MOF = middle of funnel / consideration, BOF = bottom of funnel / conversion.)`,
    `- Script length: ${scriptLength}`,
    `- Format: ${format}`,
    ``,
    `RULES`,
    `- Produce EXACTLY ${numScripts} script objects — no more, no fewer.`,
    `- Distribute the scripts across the requested funnel stages (${funnelLine}).`,
    `- Each "fullScript" must be filmable as-is, matching the ${scriptLength} length and ${format} format.`,
    `- Ground every claim in the product description and ingredients above. Do not invent unsupported medical or absolute-guarantee claims.`,
    ``,
    `OUTPUT FORMAT — READ CAREFULLY`,
    `- Respond with STRICT, VALID JSON ONLY. No prose, no commentary, no markdown code fences.`,
    `- The top-level JSON object must be shaped as: {"scripts": [ ... ]}`,
    `- The "scripts" array must contain EXACTLY ${numScripts} objects.`,
    `- Each script object must contain EXACTLY these keys: ${keyList}.`,
    `- Every key must be present in every object. Do not add extra keys. Do not omit any key.`,
    ``,
    `JSON SHAPE EXAMPLE (structure only — replace all placeholder values):`,
    shapeExample,
    ``,
    `Return only the JSON object now.`,
  ].join('\n');
}

module.exports = {
  buildScriptPrompt,
  // Exported for tests and downstream consumers (connector/validator).
  SCRIPT_KEYS,
  FUNNEL_STAGES,
  DEFAULT_NUM_SCRIPTS,
  TARGET_MODEL,
};
