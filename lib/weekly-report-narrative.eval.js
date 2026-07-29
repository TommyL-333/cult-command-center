/**
 * Eval harness for generateNarrative (lib/weekly-report.js).
 *
 * NOT a pure-function unit test — this makes real Anthropic API calls, so it
 * requires ANTHROPIC_API_KEY and costs a handful of tokens per run. It exists
 * to answer a different question than a unit test: "does the prompt still
 * behave well across a range of real situations," checked by a human reading
 * the output, not by an automated pass/fail.
 *
 * Run any time you touch the system prompt in lib/weekly-report.js:
 *   ANTHROPIC_API_KEY=sk-... node lib/weekly-report-narrative.eval.js
 *
 * What to look for in the output:
 *  - Every number/figure mentioned should be traceable to the "Data" printed
 *    above it — nothing invented, nothing rounded to a suspiciously different
 *    value.
 *  - The DECLINE fixture should read honestly, not spun positive.
 *  - The NO DATA fixture should say data wasn't available, not guess.
 *  - Tone should be plain and factual, no filler greeting/sign-off.
 *
 * The GROUNDING CHECK below is a best-effort heuristic (regex over $ and %
 * figures), not a guarantee — it catches obvious invented numbers, not
 * subtle ones. Treat a "flagged" line as "go look at this," not "this failed."
 */

'use strict';

const { generateNarrative } = require('./weekly-report');

const now = Date.now();
const weekAgo = now - 7 * 86400000;

// ---------------------------------------------------------------------------
// Fixtures — deliberately cover distinct, tricky situations, not just the
// happy path. Real historical data isn't used here on purpose: synthetic
// fixtures let us control edge cases precisely and stay repeatable.
// ---------------------------------------------------------------------------
const fixtures = [
  {
    label: 'GOOD_WEEK',
    context: {
      brandName: 'Roots by GA',
      range: { start: weekAgo, end: now },
      shopMetrics: { impressions: 182_400, sales: 11_567.46, ctr: 0.021, clickToOrderRate: 0.034 },
      topAffiliates: [{ handle: 'skincare_sammy', gmv: 3200 }, { handle: 'glow_with_g', gmv: 1850 }],
      completedTasks: [{}, {}, {}], // count is all generateNarrative sees
    },
  },
  {
    label: 'DECLINE_WEEK',
    context: {
      brandName: 'Yuglo',
      range: { start: weekAgo, end: now },
      shopMetrics: { impressions: 40_100, sales: 890.00, ctr: 0.008, clickToOrderRate: 0.011 },
      topAffiliates: [{ handle: 'lip_lover_22', gmv: 210 }],
      completedTasks: [{}],
    },
  },
  {
    label: 'NO_DATA_AT_ALL',
    context: {
      brandName: 'Fresh Onboard Brand',
      range: { start: weekAgo, end: now },
      shopMetrics: { impressions: null, sales: null, ctr: null, clickToOrderRate: null },
      topAffiliates: [],
      completedTasks: [],
    },
  },
  {
    label: 'NO_AFFILIATES_STRONG_SALES',
    context: {
      brandName: 'Approved Science',
      range: { start: weekAgo, end: now },
      shopMetrics: { impressions: 95_000, sales: 8_200, ctr: 0.019, clickToOrderRate: 0.027 },
      topAffiliates: [],
      completedTasks: [{}, {}],
    },
  },
  {
    label: 'PARTIAL_NULLS',
    context: {
      brandName: 'Trusted Rituals',
      range: { start: weekAgo, end: now },
      shopMetrics: { impressions: 61_000, sales: null, ctr: 0.014, clickToOrderRate: null },
      topAffiliates: [{ handle: 'ritual_ray', gmv: 640 }],
      completedTasks: [{}, {}, {}, {}],
    },
  },
];

// Extracts $N and N% figures from narrative text for a best-effort grounding check.
function extractMentionedNumbers(text) {
  const dollars = [...text.matchAll(/\$([\d,]+(?:\.\d+)?)/g)].map(m => parseFloat(m[1].replace(/,/g, '')));
  const percents = [...text.matchAll(/([\d.]+)%/g)].map(m => parseFloat(m[1]));
  return { dollars, percents };
}

function groundingWarnings(context, narrative) {
  const warnings = [];
  const { dollars, percents } = extractMentionedNumbers(narrative);
  const knownDollars = [context.shopMetrics?.sales, ...(context.topAffiliates || []).map(a => a.gmv)]
    .filter(n => n != null);
  const knownPercents = [context.shopMetrics?.ctr, context.shopMetrics?.clickToOrderRate]
    .filter(n => n != null).map(n => Math.round(n * 1000) / 10); // as a percent, 1 decimal

  for (const d of dollars) {
    const matches = knownDollars.some(k => Math.abs(k - d) < 1);
    if (!matches) warnings.push(`mentions $${d} — not found in context.shopMetrics.sales or topAffiliates[].gmv`);
  }
  for (const p of percents) {
    const matches = knownPercents.some(k => Math.abs(k - p) < 0.5);
    if (!matches) warnings.push(`mentions ${p}% — not close to any known percent figure`);
  }
  return warnings;
}

(async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('ANTHROPIC_API_KEY not set — nothing to eval. Set it and re-run:');
    console.log('  ANTHROPIC_API_KEY=sk-... node lib/weekly-report-narrative.eval.js');
    process.exit(0);
  }

  console.log(`Running ${fixtures.length} fixtures against generateNarrative()...\n`);

  for (const { label, context } of fixtures) {
    console.log('='.repeat(70));
    console.log(label);
    console.log('-'.repeat(70));
    console.log('Data:', JSON.stringify(context.shopMetrics), '| affiliates:', context.topAffiliates.length, '| tasks:', context.completedTasks.length);
    console.log('');

    const narrative = await generateNarrative(context);
    if (!narrative) {
      console.log('(no narrative returned — check ANTHROPIC_API_KEY / network)\n');
      continue;
    }
    console.log(narrative);

    const warnings = groundingWarnings(context, narrative);
    if (warnings.length) {
      console.log('\n⚠️  GROUNDING CHECK — review these lines by hand:');
      warnings.forEach(w => console.log('   - ' + w));
    } else {
      console.log('\n✓ grounding check: no unmatched figures found');
    }
    console.log('');
  }

  console.log('='.repeat(70));
  console.log('Done. Read every block above — this script does not pass/fail for you.');
})();
