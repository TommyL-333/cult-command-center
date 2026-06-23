/**
 * Unit test for buildScriptPrompt (Step 4 of IC Content Engine — script gen).
 *
 * Pure function test — no network. Asserts the prompt:
 *  - demands EXACTLY numScripts scripts (default 5 when omitted)
 *  - injects every product field (name/description/ingredients)
 *  - injects every audience/creator field
 *  - names all 7 required script keys
 *  - names the TOF/MOF/BOF funnel stages
 *  - demands JSON-only output shaped as {scripts:[...]}
 *  - names the target model claude-opus-4-8
 *
 * Run: node lib/ic-script-generator.test.js
 */

'use strict';

const assert = require('assert');
const {
  buildScriptPrompt,
  SCRIPT_KEYS,
  FUNNEL_STAGES,
  DEFAULT_NUM_SCRIPTS,
  TARGET_MODEL,
} = require('./ic-script-generator');

let passed = 0;
function check(label, cond) {
  assert.ok(cond, `FAILED: ${label}`);
  passed += 1;
}

// ---------------------------------------------------------------------------
// Sample inputs — explicit values so we can assert each one appears.
// ---------------------------------------------------------------------------
const samplePayload = {
  numScripts: 5,
  creatorAgeGroup: '25-34 millennial',
  credibility: 'former esthetician with 8 years of skincare experience',
  targetGender: 'Female',
  targetAgeRange: '18-29',
  targetInterests: ['skincare routines', 'clean beauty', 'GRWM'],
  painPoints: ['dry cracked lips', 'flaky winter skin'],
  funnelStages: ['TOF', 'MOF', 'BOF'],
  scriptLength: '30-45 seconds',
  format: 'UGC talking-head demo',
};

const sampleContext = {
  productName: 'YUGLO Peach Lip Sleeping Mask',
  description: 'An overnight lip mask that locks in moisture for soft, plump lips by morning.',
  ingredients: ['peach extract', 'shea butter', 'vitamin E'],
};

const prompt = buildScriptPrompt(samplePayload, sampleContext);

// ---- Basic type ----
check('returns a string', typeof prompt === 'string' && prompt.length > 0);

// ---- numScripts (count requirement) ----
check('mentions EXACTLY 5 scripts', /EXACTLY\s+5\b/.test(prompt));

// ---- Product fields injected ----
check('injects productName', prompt.includes('YUGLO Peach Lip Sleeping Mask'));
check('injects description', prompt.includes('overnight lip mask that locks in moisture'));
check('injects ingredients', prompt.includes('peach extract') &&
  prompt.includes('shea butter') && prompt.includes('vitamin E'));

// ---- Creator fields injected ----
check('injects creatorAgeGroup', prompt.includes('25-34 millennial'));
check('injects credibility freetext', prompt.includes('former esthetician with 8 years'));

// ---- Audience fields injected ----
check('injects targetGender', prompt.includes('Female'));
check('injects targetAgeRange', prompt.includes('18-29'));
check('injects targetInterests', prompt.includes('skincare routines') &&
  prompt.includes('clean beauty') && prompt.includes('GRWM'));
check('injects painPoints', prompt.includes('dry cracked lips') &&
  prompt.includes('flaky winter skin'));

// ---- Creative direction fields injected ----
check('injects scriptLength', prompt.includes('30-45 seconds'));
check('injects format', prompt.includes('UGC talking-head demo'));

// ---- Funnel stages ----
FUNNEL_STAGES.forEach((stage) => {
  check(`mentions funnel stage ${stage}`, prompt.includes(stage));
});

// ---- All required script keys named ----
SCRIPT_KEYS.forEach((key) => {
  check(`names required key "${key}"`, prompt.includes(key));
});

// ---- JSON-only output contract ----
check('demands JSON only', /JSON ONLY/i.test(prompt));
check('forbids markdown fences', /no markdown/i.test(prompt) || /code fences/i.test(prompt));
check('specifies {"scripts": [...]} shape', prompt.includes('"scripts"'));

// ---- Target model named ----
check(`names target model ${TARGET_MODEL}`, prompt.includes(TARGET_MODEL));

// ---------------------------------------------------------------------------
// Default numScripts (omitted) → DEFAULT_NUM_SCRIPTS
// ---------------------------------------------------------------------------
const defaultPrompt = buildScriptPrompt(
  { ...samplePayload, numScripts: undefined },
  sampleContext
);
check(
  `defaults to ${DEFAULT_NUM_SCRIPTS} scripts when numScripts omitted`,
  new RegExp(`EXACTLY\\s+${DEFAULT_NUM_SCRIPTS}\\b`).test(defaultPrompt)
);

// ---------------------------------------------------------------------------
// Robustness — empty/undefined inputs must not throw and still name keys.
// ---------------------------------------------------------------------------
const emptyPrompt = buildScriptPrompt({}, {});
check('handles empty inputs without throwing', typeof emptyPrompt === 'string');
check('empty inputs still name all script keys',
  SCRIPT_KEYS.every((k) => emptyPrompt.includes(k)));
check('empty inputs default to 5 scripts',
  new RegExp(`EXACTLY\\s+${DEFAULT_NUM_SCRIPTS}\\b`).test(emptyPrompt));

console.log(`\n✅ ic-script-generator.test.js — all ${passed} assertions passed.`);
