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


// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — generateScripts(payload, productContext)  [THE SINGLE SWAP POINT]
// ──────────────────────────���──────────────────────────────────────────────────
// This is the ONE function the route calls. Today it is LLM-backed (Anthropic).
// Tomorrow a 3rd-party script tool — or our own model — drops in by replacing
// the body of this function ONLY; its contract (async (payload, productContext)
// → { scripts: [...] }) stays fixed. It is deliberately free of any Express /
// req / res coupling so it can be lifted out and swapped without touching routes.
//
// CONTRACT
//   - Builds the prompt via buildScriptPrompt (the pure step-4 function).
//   - Makes exactly ONE model call (model = TARGET_MODEL).
//   - Parses the model output robustly: strips markdown code fences, then
//     JSON.parse the { scripts: [...] } envelope.
//   - On ANY failure — missing API key, API error, unparseable output, wrong
//     script count, malformed objects — it THROWS a typed ScriptGenerationError.
//     It NEVER returns fabricated / placeholder scripts. A caller that gets a
//     resolved value can trust every script is model-authored and well-formed.
//
// THROWS: ScriptGenerationError with a .code of one of:
//   'NO_API_KEY' | 'API_ERROR' | 'EMPTY_RESPONSE' | 'PARSE_ERROR' |
//   'BAD_SHAPE' | 'WRONG_COUNT' | 'MISSING_KEYS'

class ScriptGenerationError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'ScriptGenerationError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Strip markdown code fences (```json ... ``` or bare ```) and surrounding
 * whitespace from a model response, returning the inner candidate JSON string.
 * If no fences are present the trimmed input is returned unchanged. As a final
 * safety net, if there is still leading/trailing prose, it slices from the first
 * '{' to the last '}' so a stray sentence around the JSON does not break parsing.
 */
function stripCodeFences(raw) {
  let s = String(raw == null ? '' : raw).trim();
  // Remove a leading fence line like ```json or ```
  const fenceMatch = s.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) {
    s = fenceMatch[1].trim();
  } else {
    // Strip a stray opening fence with no closing one.
    s = s.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  // Last-resort: clip to the outermost JSON object braces.
  if (s && (s[0] !== '{')) {
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      s = s.slice(first, last + 1).trim();
    }
  }
  return s;
}

/**
 * Extract the plain-text content from an Anthropic messages.create response.
 * The SDK returns { content: [ { type:'text', text }, ... ] }. We concatenate
 * every text block. Returns '' if nothing usable is present.
 */
function extractAnthropicText(msg) {
  if (!msg || !Array.isArray(msg.content)) return '';
  return msg.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
}

/**
 * Validate the parsed envelope is { scripts: [...] } with exactly numScripts
 * well-formed objects (each containing every SCRIPT_KEYS entry as a non-empty
 * string). Throws a typed ScriptGenerationError on any violation.
 */
function validateScripts(parsed, expectedCount) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ScriptGenerationError('BAD_SHAPE', 'Model output is not a JSON object with a "scripts" array');
  }
  const scripts = parsed.scripts;
  if (!Array.isArray(scripts)) {
    throw new ScriptGenerationError('BAD_SHAPE', 'Model output is missing a top-level "scripts" array');
  }
  if (scripts.length !== expectedCount) {
    throw new ScriptGenerationError(
      'WRONG_COUNT',
      'Model returned ' + scripts.length + ' scripts; expected exactly ' + expectedCount
    );
  }
  scripts.forEach((script, i) => {
    if (!script || typeof script !== 'object' || Array.isArray(script)) {
      throw new ScriptGenerationError('MISSING_KEYS', 'Script #' + (i + 1) + ' is not an object');
    }
    const missing = SCRIPT_KEYS.filter((k) => {
      const v = script[k];
      return v == null || (typeof v === 'string' && v.trim() === '');
    });
    if (missing.length) {
      throw new ScriptGenerationError(
        'MISSING_KEYS',
        'Script #' + (i + 1) + ' is missing/empty required keys: ' + missing.join(', ')
      );
    }
  });
  return scripts;
}

/**
 * generateScripts(payload, productContext) → Promise<{ scripts: [...] }>
 *
 * THE SINGLE SWAP POINT. See the block comment above. Express-free; throws a
 * typed ScriptGenerationError on every failure path; never fabricates output.
 */
async function generateScripts(payload, productContext) {
  const p = payload || {};
  const numScripts =
    Number.isFinite(Number(p.numScripts)) && Number(p.numScripts) > 0
      ? Math.floor(Number(p.numScripts))
      : DEFAULT_NUM_SCRIPTS;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ScriptGenerationError('NO_API_KEY', 'ANTHROPIC_API_KEY is not set — cannot generate scripts');
  }

  // Build the deterministic prompt (pure step-4 function).
  const prompt = buildScriptPrompt(p, productContext);

  // ONE model call, using the repo's established Anthropic client/key pattern
  // (require('@anthropic-ai/sdk') + new Anthropic({ apiKey }) + messages.create).
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch (e) {
    throw new ScriptGenerationError('API_ERROR', 'Anthropic SDK is not installed: ' + e.message, e);
  }

  let msg;
  try {
    const anthropic = new Anthropic({ apiKey });
    msg = await anthropic.messages.create({
      model: TARGET_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (e) {
    throw new ScriptGenerationError('API_ERROR', 'Anthropic API call failed: ' + (e && e.message ? e.message : String(e)), e);
  }

  const text = extractAnthropicText(msg);
  if (!text) {
    throw new ScriptGenerationError('EMPTY_RESPONSE', 'Model returned an empty response');
  }

  const candidate = stripCodeFences(text);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    throw new ScriptGenerationError(
      'PARSE_ERROR',
      'Could not parse model output as JSON: ' + e.message,
      e
    );
  }

  const scripts = validateScripts(parsed, numScripts);
  return { scripts };
}



// ─────────────────────────────────────────────────────────────────────────────
// Step 6 — runViolationChecks(scripts)  [policy gate over generated scripts]
// ─────────────────────────────────────────────────────────────────────────────
//
// Runs every generated script through the standalone TikTok Shop content-policy
// checker (Task 3: agents/lib/ic-content-checker.js -> checkViolations(text)),
// attaching { violations:[], suggestedFixes:[] } to each script object.
//
// The checker is required LAZILY (and tolerantly): if the module is not yet
// deployed, or does not export checkViolations, every script gets the empty
// arrays plus checkerError:true rather than the whole batch failing. Likewise,
// if checkViolations THROWS on one script, only that script is marked
// checkerError:true — the rest of the batch is still checked.
//
// Relevant text fed to the checker = fullScript + hook + cta combined (the
// spoken + on-screen + call-to-action copy that carries policy risk). Returns a
// NEW array of script objects (non-mutating); every returned script is
// GUARANTEED to have violations + suggestedFixes arrays.
//
// Contract of checkViolations(text) (Task 3):
//   { violations:[{rule, severity, matchedText, explanation}],
//     suggestedFixes:[{original, suggestion}], clean:boolean }

// Candidate paths for the checker module. The committed name is
// agents/lib/ic-content-checker.js; tiktok-violation-checker.js is the
// task-spec alias. Try both so a rename does not break the gate.
const VIOLATION_CHECKER_PATHS = [
  '../agents/lib/ic-content-checker.js',
  '../agents/lib/tiktok-violation-checker.js',
];

let _checkViolations = null;
let _checkerResolved = false;
function _resolveChecker() {
  if (_checkerResolved) return _checkViolations;
  _checkerResolved = true;
  for (const rel of VIOLATION_CHECKER_PATHS) {
    try {
      const mod = require(rel);
      if (mod && typeof mod.checkViolations === 'function') {
        _checkViolations = mod.checkViolations;
        return _checkViolations;
      }
    } catch (_) { /* try next candidate */ }
  }
  _checkViolations = null; // not deployed yet — gate degrades gracefully
  return null;
}

// Combine the policy-relevant text of one script. Tolerant of missing keys.
function _relevantText(script) {
  const s = script || {};
  return [s.fullScript, s.hook, s.cta]
    .filter((v) => typeof v === 'string' && v.trim() !== '')
    .join('\n');
}

/**
 * runViolationChecks(scripts) -> Array<script & {violations, suggestedFixes, checkerError?}>
 *
 * Resilient batch gate. Never throws on a single bad script; never fabricates
 * results. Returns a new array (does not mutate the input scripts).
 */
function runViolationChecks(scripts) {
  const list = Array.isArray(scripts) ? scripts : [];
  const check = _resolveChecker();

  return list.map((script) => {
    const base = (script && typeof script === 'object') ? script : {};

    // Checker unavailable -> attach empty arrays + checkerError, keep going.
    if (typeof check !== 'function') {
      return Object.assign({}, base, { violations: [], suggestedFixes: [], checkerError: true });
    }

    try {
      const text = _relevantText(base);
      const result = check(text) || {};
      const violations = Array.isArray(result.violations) ? result.violations : [];
      const suggestedFixes = Array.isArray(result.suggestedFixes) ? result.suggestedFixes : [];
      return Object.assign({}, base, { violations, suggestedFixes });
    } catch (_err) {
      // One script's checker failure must not fail the batch.
      return Object.assign({}, base, { violations: [], suggestedFixes: [], checkerError: true });
    }
  });
}


module.exports = {
  buildScriptPrompt,
  generateScripts,
  runViolationChecks,
  ScriptGenerationError,
  // Exported for tests and downstream consumers (connector/validator).
  SCRIPT_KEYS,
  FUNNEL_STAGES,
  DEFAULT_NUM_SCRIPTS,
  TARGET_MODEL,
};
