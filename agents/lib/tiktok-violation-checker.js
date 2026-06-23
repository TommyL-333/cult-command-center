/**
 * ic-content-checker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * IC Content Engine — TikTok violation checker.
 *
 * Scans creator script / caption / hook text against TikTok Shop's content and
 * advertising compliance rules BEFORE a video is filmed or published, so Inner
 * Circle creators avoid takedowns, affiliate-link suppression, and shop strikes.
 *
 * Each rule is a self-contained detector. The public API (`checkViolations`)
 * runs every rule's `test(text)` over the input and aggregates the findings into
 * a single report with severity-weighted scoring.
 *
 * ── Rule contract ───────────────────────────────────────────────────────────
 *   {
 *     id:       string   // stable machine id, SCREAMING_SNAKE_CASE
 *     rule:     string   // human-readable label shown to creators
 *     severity: 'high' | 'medium' | 'low'
 *     test:     (text: string) => Array<{
 *                  matchedText: string,   // the offending substring
 *                  explanation: string,   // why it violates TikTok policy
 *                  suggestion:  string,   // compliant rewrite / fix
 *               }>
 *   }
 *
 * A rule returns an EMPTY array when the text is clean for that rule.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

/**
 * scan — shared detector helper.
 *
 * Runs an array of detector specs against `text`. Each spec is:
 *   { re: RegExp(global), explanation: string, suggestion: string }
 * or a function (text) => Array<match> for custom logic.
 *
 * Returns an array of { matchedText, explanation, suggestion }. De-duplicates
 * on the lowercased matchedText so the same phrase isn't reported twice by the
 * same rule.
 *
 * @param {string} text
 * @param {Array<{re:RegExp, explanation:string, suggestion:string}>} specs
 * @returns {Array<{matchedText:string, explanation:string, suggestion:string}>}
 */
function scan(text, specs) {
  const out = [];
  const seen = new Set();
  if (typeof text !== 'string' || !text) return out;

  for (const spec of specs) {
    // Context gate: when a spec sets `requires` to a falsy value it means the
    // surrounding contextual precondition (e.g. cosmetic / food context) was NOT
    // met, so this spec is skipped. Specs that omit `requires` are never gated.
    if (Object.prototype.hasOwnProperty.call(spec, 'requires') && !spec.requires) {
      continue;
    }

    // Custom-function spec: spec is { fn }
    if (typeof spec.fn === 'function') {
      const customMatches = spec.fn(text) || [];
      for (const m of customMatches) {
        if (!m || !m.matchedText) continue;
        const key = m.matchedText.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(m);
      }
      continue;
    }

    // Regex spec. Ensure the regex is global so we can iterate all matches.
    const re = spec.re.global
      ? spec.re
      : new RegExp(spec.re.source, spec.re.flags + 'g');
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const matchedText = match[0];
      const key = matchedText.toLowerCase();
      // Guard against zero-length matches causing an infinite loop.
      if (match.index === re.lastIndex) re.lastIndex++;
      if (!matchedText || seen.has(key)) continue;
      seen.add(key);
      out.push({
        matchedText,
        explanation: spec.explanation,
        suggestion: spec.suggestion,
      });
    }
  }
  return out;
}

/**
 * The complete rule registry. 11 rules.
 *
 * @type {Array<{id:string, rule:string, severity:'high'|'medium'|'low', test:(text:string)=>Array<{matchedText:string, explanation:string, suggestion:string}>}>}
 */
const RULES = [
  {
    id: 'EXAGGERATED_PROMISES',
    rule: 'Exaggerated or absolute performance promises',
    // Per spec: exaggerated promises are MEDIUM severity.
    severity: 'medium',
    // Detects absolutes / guarantees / superlative price + result claims like
    // "instantly", "right away", "removes acne in days", "guaranteed results",
    // "lowest price", "cheapest", "best price", "get slim legs".
    test: function (text) {
      return scan(text, [
        {
          re: /\bremoves?\s+acne\s+in\s+(?:days|a\s+(?:few\s+)?days|\d+\s+days)\b/i,
          explanation:
            'Promising a product "removes acne in days" is an absolute, time-bound result claim TikTok treats as misleading.',
          suggestion:
            'Describe your personal experience instead, e.g. "my skin looked clearer after a few weeks of use".',
        },
        {
          re: /\bright\s+away\b/i,
          explanation:
            '"Right away" promises an immediate, guaranteed effect that results may not support.',
          suggestion:
            'Soften to a personal, non-guaranteed statement like "I noticed a difference fairly quickly for me".',
        },
        {
          re: /\binstantly\b/i,
          explanation:
            '"Instantly" is an absolute speed claim TikTok flags as an exaggerated performance promise.',
          suggestion:
            'Avoid absolute timing words; describe what you personally noticed over time instead.',
        },
        {
          re: /\bguaranteed\s+results?\b/i,
          explanation:
            'Guaranteeing results is a prohibited absolute performance promise — outcomes vary by person.',
          suggestion:
            'Replace with "results vary" framing, e.g. "here\'s what worked for me — everyone\'s different".',
        },
        {
          re: /\bget\s+slim\s+legs\b/i,
          explanation:
            'Promising the product will "get slim legs" is an exaggerated body-result promise.',
          suggestion:
            'Focus on how the product feels or fits rather than promising a body transformation.',
        },
        {
          re: /\blowest\s+price\b/i,
          explanation:
            '"Lowest price" is an unsubstantiated superlative price claim.',
          suggestion:
            'Reference the actual on-platform discount instead, e.g. "it\'s X% off right now on the shop".',
        },
        {
          re: /\bcheapest\b/i,
          explanation:
            '"Cheapest" is an unsubstantiated superlative price claim TikTok treats as exaggerated.',
          suggestion:
            'State the real price or the on-platform discount rather than an absolute superlative.',
        },
        {
          re: /\bbest\s+price\b/i,
          explanation:
            '"Best price" is an unsubstantiated superlative price claim.',
          suggestion:
            'Point to the concrete discount shown on the TikTok Shop listing instead.',
        },
      ]);
    },
  },
  {
    id: 'MEDICAL_CLAIMS',
    rule: 'Unauthorized medical / disease treatment claims',
    severity: 'high',
    // Detects claims to cure / treat / prevent / diagnose + a disease/condition term.
    test: function (text) {
      // Disease / condition vocabulary that, combined with a treatment verb,
      // constitutes an unauthorized medical claim.
      const CONDITIONS =
        '(?:acne|eczema|psoriasis|rosacea|cancer|tumou?rs?|diabetes|diabetic|' +
        'depression|anxiety|insomnia|arthritis|inflammation|infections?|' +
        'disease|diseases|illness|illnesses|migraines?|hypertension|' +
        'high\\s+blood\\s+pressure|cholesterol|asthma|allergies|allergy|' +
        'covid|flu|colds?|virus|viruses|hair\\s+loss|baldness|wrinkles?|' +
        'pain|cramps?|menopause|hormonal\\s+imbalance|ibs|adhd|ptsd)';
      const VERBS = '(?:cures?|cured|curing|treats?|treated|treating|' +
        'prevents?|prevented|preventing|diagnoses?|diagnosed|diagnosing|' +
        'heals?|healed|healing)';

      // "<verb> ... <condition>" within a short window (up to ~30 chars between)
      const phraseRe = new RegExp(
        VERBS + '\\s+(?:your\\s+|the\\s+|my\\s+|a\\s+|an\\s+)?(?:[a-z]+\\s+){0,4}?' + CONDITIONS,
        'gi'
      );

      return scan(text, [
        {
          re: phraseRe,
          explanation:
            'Claiming a product can cure, treat, prevent, or diagnose a disease or medical condition is a prohibited unauthorized medical claim on TikTok Shop.',
          suggestion:
            'Remove the medical claim. Describe a cosmetic or lifestyle benefit instead, and never name a disease as something the product acts on.',
        },
      ]);
    },
  },
  {
    id: 'WEIGHT_MANAGEMENT',
    rule: 'Prohibited weight-loss / body-shaming claims',
    severity: 'high',
    // Detects weight-loss claims, "lose N lbs/pounds/kg", GLP-1 / Ozempic /
    // semaglutide equivalence, "before and after" weight framing, and
    // body-image shaming.
    test: function (text) {
      return scan(text, [
        {
          re: /\blose\s+\d+\s?(?:lbs|lb|pounds|pound|kg|kgs|kilos|kilograms)\b/i,
          explanation:
            'Specific weight-loss amount claims ("lose N lbs/kg") are prohibited on TikTok Shop.',
          suggestion:
            'Remove the numeric weight claim entirely; focus on how the product fits into a healthy routine.',
        },
        {
          re: /\bweight\s+loss\b/i,
          explanation:
            'Direct "weight loss" positioning is a restricted health claim for shop products.',
          suggestion:
            'Avoid weight-loss framing; describe taste, ingredients, or how it supports your day instead.',
        },
        {
          re: /\blose\s+weight\b/i,
          explanation:
            '"Lose weight" is a prohibited weight-management result claim.',
          suggestion:
            'Reframe away from weight outcomes — talk about how the product feels or fits your lifestyle.',
        },
        {
          re: /\b(?:like\s+|just\s+like\s+|nature[''`]?s?\s+)?(?:ozempic|semaglutide|wegovy|glp-?\s?1|glp1)\b/i,
          explanation:
            'Comparing a product to GLP-1 drugs (Ozempic / semaglutide / Wegovy) implies a prescription-drug equivalence — a prohibited medical/weight claim.',
          suggestion:
            'Never compare the product to prescription weight-loss drugs. Remove the comparison entirely.',
        },
        {
          re: /\bbefore\s+and\s+after\b/i,
          explanation:
            '"Before and after" framing tied to weight/body transformation is restricted and frequently removed.',
          suggestion:
            'Avoid before/after transformation claims; show or describe the product itself instead.',
        },
        {
          re: /\b(?:fat|chubby|flabby|overweight|ugly|gross)\b/i,
          explanation:
            'Body-image shaming language is prohibited; it violates TikTok community and ad policies.',
          suggestion:
            'Remove any body-shaming language and use positive, inclusive framing.',
        },
      ]);
    },
  },
  {
    id: 'COSMETICS_OVERREACH',
    rule: 'Cosmetic product overreaching into drug-level claims',
    // Per spec: cosmetic drug-level overreach is HIGH severity.
    severity: 'high',
    // A COSMETIC product (skincare / haircare / makeup / cream / serum / lotion)
    // crosses into prohibited DRUG-level territory the moment it claims to
    // "treat", "cure", "modify your skin's physiological function", or to act
    // "pharmacologically", "immunologically", or via a "metabolic effect".
    // Those verbs define a drug under FDA/TikTok policy, not a cosmetic.
    test: function (text) {
      // Cosmetic context cue — the offending claim must concern a cosmetic
      // product / body surface, otherwise a generic "pharmacological" mention
      // (e.g. quoting a study) shouldn't trip this beauty-focused rule.
      const COSMETIC_CONTEXT =
        /\b(?:cosmetic|skin(?:care)?|hair(?:care)?|makeup|make-?up|cream|creams|serum|serums|lotion|lotions|moistur(?:e|er|izer|iser)|cleanser|toner|mask|masks|complexion|pores?|wrinkles?|collagen|cuticle|scalp|lash(?:es)?|nails?)\b/i;
      const hasCosmeticContext = COSMETIC_CONTEXT.test(text);

      return scan(text, [
        {
          // "treat / cure / modify ... (skin's) physiological function"
          re: /\b(?:treats?|treating|cures?|curing|modif(?:y|ies|ying)|alters?|altering|changes?)\b[^.!?]{0,60}?\bphysiolog(?:ical|y)\b[^.!?]{0,20}?\bfunction\b/i,
          explanation:
            'Claiming a cosmetic product treats, cures, or modifies the skin\'s physiological function reclassifies it as an unapproved DRUG under TikTok / FDA cosmetic rules — cosmetics may only cleanse or beautify, not alter the body\'s function.',
          suggestion:
            'Describe a cosmetic/sensory benefit instead, e.g. "leaves my skin feeling softer and more hydrated" — never claim it changes how the skin functions.',
          requires: hasCosmeticContext,
        },
        {
          // Shorthand: "modifies ... physiological <X>" where X is NOT "function"
          // (the "...physiological function" form is already covered by the
          // primary spec above, so the negative lookahead prevents a redundant
          // double-report of the same claim).
          re: /\bmodif(?:y|ies|ying)\b[^.!?]{0,40}?\bphysiolog(?:ical|y)\b(?!\s+function\b)/i,
          explanation:
            'Saying a cosmetic "modifies physiological ..." is a drug-level claim — cosmetics are not permitted to alter the body\'s biological processes.',
          suggestion:
            'Reframe to an appearance benefit ("looks smoother", "feels more nourished") rather than a physiological change.',
          requires: hasCosmeticContext,
        },
        {
          re: /\bpharmacolog(?:ical|ically|y)\b/i,
          explanation:
            'Describing a cosmetic\'s action as "pharmacological" frames it as a drug, which is prohibited for cosmetic shop listings on TikTok.',
          suggestion:
            'Remove the pharmacological framing; talk about how the product feels or looks, not how it acts on the body like a medicine.',
          requires: hasCosmeticContext,
        },
        {
          re: /\bimmunolog(?:ical|ically|y)\b/i,
          explanation:
            'Claiming a cosmetic has an "immunological" effect asserts a drug-level mechanism of action that cosmetics may not make.',
          suggestion:
            'Drop the immunological claim entirely and focus on cosmetic, surface-level benefits.',
          requires: hasCosmeticContext,
        },
        {
          re: /\bmetabolic\s+effect\b/i,
          explanation:
            'Saying a cosmetic produces a "metabolic effect" claims it alters the body\'s metabolism — a drug claim disallowed for cosmetic products.',
          suggestion:
            'Avoid metabolic / biological-effect language; describe the cosmetic result you can see or feel instead.',
          requires: hasCosmeticContext,
        },
      ]);
    },
  },
  {
    id: 'FOOD_MEDICINAL',
    rule: 'Food / supplement framed with medicinal effect',
    // Per spec: food positioned as medicine is HIGH severity.
    severity: 'high',
    // A FOOD or supplement (drink, gummy, tea, snack, powder, bar, etc.) becomes
    // a prohibited medicinal claim when it is said to "cure", "treat", "prevent",
    // have "medicinal properties", or "boost immunity to fight disease".
    test: function (text) {
      // Food / ingestible context cue so a generic "prevents" elsewhere doesn't
      // wrongly trip this food-specific rule.
      const FOOD_CONTEXT =
        /\b(?:food|foods|drink|drinks|beverage|tea|teas|coffee|juice|smoothie|gummy|gummies|snack|snacks|bar|bars|powder|supplement|supplements|vitamin|vitamins|capsule|capsules|tablet|tablets|shot|shots|tonic|elixir|superfood|probiotic|electrolyte|protein)\b/i;
      const hasFoodContext = FOOD_CONTEXT.test(text);

      return scan(text, [
        {
          re: /\bmedicinal\s+propert(?:y|ies)\b/i,
          explanation:
            'Attributing "medicinal properties" to a food or supplement positions it as a drug — TikTok Shop prohibits ingestibles from making medicinal claims.',
          suggestion:
            'Describe taste, ingredients, or how it fits a balanced routine instead of claiming medicinal properties.',
          requires: hasFoodContext,
        },
        {
          re: /\bboosts?\s+(?:your\s+)?immunity\s+to\s+fight\s+(?:off\s+)?(?:disease|diseases|illness|illnesses|infections?)\b/i,
          explanation:
            'Claiming a food "boosts immunity to fight disease" is an unauthorized disease-prevention claim for an ingestible product.',
          suggestion:
            'Avoid disease-fighting language; you may mention it "contains vitamin C" without claiming it fights disease.',
          requires: hasFoodContext,
        },
        {
          re: /\bcures?\b/i,
          explanation:
            'Saying a food or supplement "cures" something is a prohibited medicinal claim — ingestibles on TikTok Shop may not claim to cure conditions.',
          suggestion:
            'Remove the word "cure"; describe a general wellness or lifestyle benefit instead.',
          requires: hasFoodContext,
        },
        {
          re: /\btreats?\b/i,
          explanation:
            'Claiming a food or supplement "treats" a condition frames it as medicine, which is disallowed for ingestible shop products.',
          suggestion:
            'Avoid "treats"; talk about how the product fits into your day rather than what it treats.',
          requires: hasFoodContext,
        },
        {
          re: /\bprevents?\b/i,
          explanation:
            'Saying a food or supplement "prevents" illness is an unauthorized disease-prevention claim TikTok prohibits for ingestibles.',
          suggestion:
            'Drop preventive-health claims; describe the ingredients or taste instead of what it prevents.',
          requires: hasFoodContext,
        },
      ]);
    },
  },
  {
    id: 'CHARITABLE_DONATION',
    rule: 'Unverifiable charitable-donation claims',
    // Per spec: charitable-donation claims are MEDIUM severity.
    severity: 'medium',
    // Donation claims ("we donate", "portion of proceeds to charity",
    // "every purchase feeds...", "X% goes to...") require on-platform proof and
    // are frequently flagged when unsubstantiated.
    test: function (text) {
      return scan(text, [
        {
          re: /\bwe\s+donate\b/i,
          explanation:
            'A "we donate" claim is an unverifiable charitable statement that TikTok requires the brand to substantiate before it can appear in shop content.',
          suggestion:
            'Remove the donation claim from the creator script, or have the brand provide verifiable proof of the charitable commitment before mentioning it.',
        },
        {
          re: /\bportion\s+of\s+(?:the\s+)?proceeds\b[^.!?]{0,30}?\b(?:charity|charities|donat\w*|good\s+cause)\b/i,
          explanation:
            'Claiming a "portion of proceeds" goes to charity is an unverifiable donation claim that needs documented proof to be compliant.',
          suggestion:
            'Drop the proceeds-to-charity claim unless the brand supplies verifiable evidence of the arrangement.',
        },
        {
          re: /\bevery\s+purchase\s+(?:feeds|helps|supports|donates|provides|gives|plants?)\b/i,
          explanation:
            'An "every purchase feeds/helps..." claim is an unverifiable cause-marketing statement that TikTok requires brands to prove.',
          suggestion:
            'Avoid the per-purchase impact claim in the script unless the brand can verify it on platform.',
        },
        {
          re: /\b\d{1,3}\s?%\s+(?:of\s+(?:all\s+)?(?:proceeds|profits|sales|purchases?)\s+)?(?:goes?|go|going|donated)\s+to\b/i,
          explanation:
            'A "X% goes to..." donation claim is an unverifiable charitable statement requiring substantiation under TikTok policy.',
          suggestion:
            'Remove the percentage-donation claim unless the brand provides verifiable proof of the donation.',
        },
        {
          re: /\b\d{1,3}\s?%\s+to\s+charity\b/i,
          explanation:
            'Stating a specific percentage goes "to charity" is an unverifiable donation claim that must be substantiated to remain compliant.',
          suggestion:
            'Drop the specific donation percentage unless the brand can document the charitable contribution.',
        },
      ]);
    },
  },
  {
    id: 'REDIRECT_OFFPLATFORM',
    rule: 'Redirecting buyers off TikTok',
    severity: 'high',
    // Detects any redirect off TikTok: external URLs (http/https, www., bare
    // .com/.net/.io domains+paths), emails, phone numbers, social handles,
    // "follow me on <platform>", "link in bio", "DM me", and "scan the QR code".
    test: function (text) {
      return scan(text, [
        {
          // Full URLs: http:// or https://
          re: /https?:\/\/[^\s]*[^\s,.;:!?)\]'"]/i,
          explanation:
            'Including an external URL pushes buyers off TikTok, which violates TikTok Shop policy — purchases must stay on the platform.',
          suggestion:
            'Remove the off-platform redirect. Keep the purchase on TikTok Shop via the product link / yellow basket.',
        },
        {
          // www. domains without a scheme
          re: /\bwww\.[^\s]*[^\s,.;:!?)\]'"]/i,
          explanation:
            'A "www." web address directs buyers off TikTok, which TikTok Shop prohibits — sales must complete on-platform.',
          suggestion:
            'Remove the off-platform redirect. Keep the purchase on TikTok Shop via the product link / yellow basket.',
        },
        {
          // Bare domains / domain paths: example.com, shop.net/deals, site.io/x
          re: /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|io)(?:\/[^\s]*[^\s,.;:!?)\]'"])?/i,
          explanation:
            'A bare domain (.com/.net/.io) sends buyers to an off-platform store, which violates TikTok Shop policy.',
          suggestion:
            'Remove the off-platform redirect. Keep the purchase on TikTok Shop via the product link / yellow basket.',
        },
        {
          // Email addresses
          re: /\S+@\S+\.\S+/i,
          explanation:
            'Sharing an email address moves the transaction off TikTok, which TikTok Shop does not allow.',
          suggestion:
            'Remove the off-platform contact. Keep the purchase on TikTok Shop via the product link / yellow basket.',
        },
        {
          // Phone numbers: optional +, then digit + 7-? of [digits - ( ) space] + digit
          re: /\+?\d[\d\-() ]{7,}\d/,
          explanation:
            'Listing a phone number invites off-platform ordering, which violates TikTok Shop policy.',
          suggestion:
            'Remove the off-platform contact. Keep the purchase on TikTok Shop via the product link / yellow basket.',
        },
        {
          // "follow me on instagram/youtube/snap/..." style off-platform pulls
          re: /\bfollow\s+(?:me|us)\s+on\s+(?:instagram|insta|ig|youtube|yt|snap(?:chat)?|facebook|fb|twitter|x|telegram|whatsapp|pinterest|threads)\b/i,
          explanation:
            'Telling viewers to follow you on another platform redirects them off TikTok, which TikTok Shop prohibits in shoppable content.',
          suggestion:
            'Remove the cross-platform follow ask. Keep engagement and the purchase on TikTok Shop.',
        },
        {
          // Social handles: @name (letters/digits/_/.)
          re: /@[A-Za-z0-9_.]+/,
          explanation:
            'Tagging a social handle can redirect buyers to another platform or off-platform store, which violates TikTok Shop policy.',
          suggestion:
            'Remove the off-platform handle. Keep the purchase on TikTok Shop via the product link / yellow basket.',
        },
        {
          // "link in bio"
          re: /\blink\s+in\s+bio\b/i,
          explanation:
            '"Link in bio" routes buyers to an off-platform destination, which TikTok Shop does not permit.',
          suggestion:
            'Remove the off-platform redirect. Keep the purchase on TikTok Shop via the product link / yellow basket.',
        },
        {
          // "DM me" / "DM us"
          re: /\bDM\s+(?:me|us)\b/i,
          explanation:
            'Asking buyers to "DM me" moves the sale into private off-platform messaging, which violates TikTok Shop policy.',
          suggestion:
            'Remove the DM-to-buy ask. Keep the purchase on TikTok Shop via the product link / yellow basket.',
        },
        {
          // "scan the QR code"
          re: /\bscan\s+(?:the\s+|this\s+|our\s+)?QR\s*code\b/i,
          explanation:
            'A QR code typically links to an off-platform store, redirecting buyers away from TikTok in violation of policy.',
          suggestion:
            'Remove the QR-code redirect. Keep the purchase on TikTok Shop via the product link / yellow basket.',
        },
      ]);
    },
  },
  {
    id: 'VAGUE_PRICE_COMPARISON',
    rule: 'Vague or unsubstantiated price comparisons',
    // Per spec: vague price comparisons are MEDIUM severity.
    severity: 'medium',
    // Detects comparative price / value claims made against unnamed competitors
    // ("cheaper than competitors", "half the price of others", "better value
    // than the leading brand") that assert a price/value advantage WITHOUT a
    // cited source or concrete number. A claim that includes a real figure or a
    // named, verifiable basis (e.g. "20% cheaper per ounce") is NOT flagged.
    test: function (text) {
      return scan(text, [
        {
          // "cheaper / less expensive / lower price than competitors/others/the
          // leading brand/everyone else/the rest" — no number/source.
          re: /\b(?:way\s+|much\s+|far\s+|so\s+)?(?:cheaper|less\s+expensive|lower\s+priced?)\s+than\s+(?:competitors?|other\s+brands?|the\s+others?|others|everyone\s+else|the\s+competition|the\s+rest|the\s+leading\s+brand|the\s+other\s+guys)\b/i,
          explanation:
            'A vague price comparison ("cheaper than competitors") with no cited source or specific number is an unsubstantiated comparative claim that TikTok Shop can suppress or take down.',
          suggestion:
            'Drop the vague comparison or back it with a concrete, verifiable figure (e.g. "$12 vs the $24 leading brand, price-per-ounce as of June 2026").',
        },
        {
          // "half / a fraction of / a third of the price of others/competitors/
          // the leading brand" — fractional comparison without a real number.
          re: /\b(?:half|a\s+fraction|a\s+third|a\s+quarter|a\s+tenth)\s+(?:of\s+)?the\s+(?:price|cost)\s+of\s+(?:others|other\s+brands?|competitors?|the\s+others?|the\s+leading\s+brand|the\s+competition|everyone\s+else)\b/i,
          explanation:
            'A fractional price claim ("half the price of others") presented without a cited source or actual prices is an unsubstantiated comparative claim under TikTok Shop policy.',
          suggestion:
            'State the real prices being compared and the basis/date (e.g. "$15 vs the $30 market average, per [source]"), or remove the comparison.',
        },
        {
          // "better value / more value / better deal / better bang for your buck
          // than the leading brand/competitors/others" — no number/source.
          re: /\b(?:better|greater|more)\s+(?:value|deal|bang\s+for\s+your\s+buck)\s+than\s+(?:the\s+leading\s+brand|competitors?|other\s+brands?|the\s+others?|others|everyone\s+else|the\s+competition|the\s+other\s+guys)\b/i,
          explanation:
            'A "better value than the leading brand" claim with no cited source or supporting number is a vague comparative value claim TikTok Shop can flag as unsubstantiated.',
          suggestion:
            'Quantify and source the value comparison (e.g. "50% more servings per dollar vs Brand X, per label") or remove the comparative claim.',
        },
      ]);
    },
  },
  {
    id: 'DISPARAGING_COMPETITOR',
    rule: 'Disparaging or naming competitor brands',
    severity: 'medium',
    // Detects derogatory framing aimed at competitors — named or unnamed —
    // such as "unlike that garbage brand", "their product is trash/scam/fake",
    // or generic "worse than ..." put-downs. Disparaging rival products
    // violates TikTok Shop's content policy regardless of whether the rival is
    // named.
    test: function (text) {
      return scan(text, [
        {
          // Derogatory adjective attached to "brand/brands/product/products/stuff/
          // company": "that garbage brand", "this trash product", "their fake stuff".
          re: /\b(?:that|this|those|their|the\s+other|other|some)\s+(?:\w+\s+){0,2}?(?:garbage|trash|crappy|crap|junk|scam|scammy|fake|knock[\s-]?off|cheap[\s-]?o|worthless|useless|toxic|sketchy|shady)\s+(?:brands?|products?|stuff|company|companies|competitors?|knock[\s-]?offs?)\b/i,
          explanation:
            'Calling a competitor or their product "garbage/trash/fake/scam" disparages a rival, which TikTok Shop content policy prohibits in shoppable content.',
          suggestion:
            'Remove the put-down and focus on your own product\'s benefits (e.g. "here\'s what makes ours work for me") instead of attacking competitors.',
        },
        {
          // "their/the competitor's product/stuff/brand is trash/garbage/a scam/
          // fake/junk/useless".
          re: /\b(?:their|the\s+other\s+(?:brand|guys|one)(?:'s)?|the\s+competitor(?:'s)?|that\s+brand(?:'s)?|its)\s+(?:\w+\s+){0,2}?(?:product|products|stuff|brand|formula|version)?\s*(?:is|are|are\s+just|is\s+just|'s)\s+(?:a\s+|an\s+|the\s+)?(?:total\s+|complete\s+|pure\s+|absolute\s+|straight[\s-]?up\s+|just\s+)?(?:garbage|trash|scam|fake|junk|useless|worthless|rip[\s-]?off|joke|crap|toxic)\b/i,
          explanation:
            'Stating a competitor\'s product "is trash / a scam / fake" is a disparaging claim against a rival, which violates TikTok Shop policy.',
          suggestion:
            'Drop the disparaging claim. Make positive, verifiable points about your own product rather than attacking the competitor.',
        },
        {
          // Generic put-down: "their stuff is total garbage", "this is garbage/trash/
          // a scam" used about a competing offering.
          re: /\b(?:their|the\s+other|those|its|that)\s+(?:stuff|product|products|brand|formula)\s+(?:is|are)\s+(?:total\s+|complete\s+|pure\s+|absolute\s+|just\s+|straight[\s-]?up\s+)?(?:garbage|trash|junk|crap|a\s+scam|fake|useless|worthless|toxic)\b/i,
          explanation:
            'Describing a competing brand\'s product as "total garbage" disparages a rival product, which TikTok Shop content policy does not allow.',
          suggestion:
            'Remove the insult and let your product stand on its own merits with honest, specific benefits.',
        },
        {
          // "worse than ..." put-down comparisons against other brands/products.
          re: /\b(?:way\s+|much\s+|far\s+|a\s+lot\s+)?worse\s+than\s+(?:\w+\s+){0,3}?(?:brands?|products?|competitors?|the\s+others?|others|everyone\s+else|the\s+other\s+(?:brand|guys|stuff)|nothing|ours|mine|this|that|anything\s+else)\b/i,
          explanation:
            'A "worse than ..." comparison framing a rival negatively is a disparaging competitor claim under TikTok Shop policy.',
          suggestion:
            'Avoid negative comparisons. Highlight what your product does well instead of running down the competition.',
        },
      ]);
    },
  },
  {
    id: 'MINOR_TARGETING',
    rule: 'Targeting or appealing to minors',
    severity: 'high',
    // Detects language that directs the pitch at children/teens or instructs an
    // adult to push the product onto a minor. TikTok Shop strictly prohibits
    // shoppable content aimed at or featuring minors.
    test: function (text) {
      return scan(text, [
        {
          re: /\bkids\b/i,
          explanation:
            'Aiming the pitch at "kids" targets minors, which TikTok Shop content policy prohibits for shoppable content.',
          suggestion:
            'Speak to your adult audience instead of directing the product at children.',
        },
        {
          re: /\bteens\b/i,
          explanation:
            'Aiming the pitch at "teens" targets minors, which TikTok Shop content policy prohibits.',
          suggestion:
            'Address adult viewers rather than marketing the product to teenagers.',
        },
        {
          re: /\bperfect\s+for\s+minors\b/i,
          explanation:
            '"Perfect for minors" explicitly markets the product to under-18s, a prohibited audience for shoppable content.',
          suggestion:
            'Remove minor-targeting language and speak to an adult audience.',
        },
        {
          re: /\bas\s+a\s+teenager\s+you\s+should\b/i,
          explanation:
            'Instructing a teenager what they "should" do targets minors directly, which TikTok Shop policy forbids.',
          suggestion:
            'Reframe for adults — avoid telling teenagers what to buy or do.',
        },
        {
          re: /\bget\s+your\s+child\s+to\b/i,
          explanation:
            'Telling viewers to "get your child to" use the product involves a minor in the purchase, which is prohibited.',
          suggestion:
            'Avoid involving children; focus on the adult viewer\u2019s own use of the product.',
        },
      ]);
    },
  },
  {
    id: 'STITCH_AND_CREDIT',
    rule: 'Stitch / duet / reuse without proper credit',
    severity: 'medium',
    // Flags borrowed-content language (referencing another creator's clip,
    // reposting, duetting) ONLY when the script does NOT also include
    // crediting/stitching keywords. If proper credit/stitch attribution is
    // present, the borrowed-content reference is acceptable and not flagged.
    test: function (text) {
      if (typeof text !== 'string' || !text) return [];

      // Attribution present? If so, the borrowed-content language is fine.
      const CREDIT_RE = /\b(?:stitched|stitching|crediting\s+@|credit\s+to\s+@|tagging\s+the\s+creator|tagged\s+the\s+creator|original\s+by\s+@)/i;
      const hasCredit = CREDIT_RE.test(text);

      const BORROWED = [
        {
          re: /\bthis\s+creator\s+said\b/i,
          explanation:
            'Quoting "this creator said" reuses another creator\u2019s content without on-screen stitch/credit attribution.',
        },
        {
          re: /\bas\s+seen\s+in\s+@\w+(?:'s)?\s+video\b/i,
          explanation:
            'Referencing "as seen in @someone\u2019s video" reuses borrowed content without a proper stitch or credit.',
        },
        {
          re: /\breposting\s+this\b/i,
          explanation:
            '"Reposting this" reuses another creator\u2019s content without stitching or crediting them.',
        },
        {
          re: /\bduet\s+of\b/i,
          explanation:
            'Describing a "duet of" another creator\u2019s clip reuses their content; without explicit credit it can violate reuse policy.',
        },
        {
          re: /\busing\s+their\s+clip\b/i,
          explanation:
            '"Using their clip" reuses another creator\u2019s footage without a stitch or credit attribution.',
        },
      ];

      // Context gate: each borrowed-content spec only fires when credit/stitch
      // attribution is ABSENT. We pass `requires: !hasCredit` so scan() skips
      // them entirely when proper credit is present.
      const SUGGESTION = 'Stitch the original and tag/credit the creator.';
      const specs = BORROWED.map((b) => ({
        re: b.re,
        explanation: b.explanation,
        suggestion: SUGGESTION,
        requires: !hasCredit,
      }));

      return scan(text, specs);
    },
  },
];

/**
 * checkViolations — the public entry point of the IC content checker.
 *
 * @param {string} scriptText - The creator's script / caption / hook text.
 * @returns {{
 *   clean: boolean,
 *   violations: Array<{rule:string, severity:string, matchedText:string, explanation:string}>,
 *   suggestedFixes: Array<{original:string, suggestion:string}>
 * }}
 */
function checkViolations(scriptText) {
  const originalText = typeof scriptText === 'string' ? scriptText : '';

  const violations = [];
  const suggestedFixes = [];

  for (let i = 0; i < RULES.length; i++) {
    const rule = RULES[i];

    let matches;
    try {
      matches = rule.test(originalText);
    } catch (err) {
      matches = [];
    }
    if (!Array.isArray(matches) || matches.length === 0) continue;

    for (const m of matches) {
      if (!m) continue;

      violations.push({
        rule: rule.rule,
        severity: rule.severity,
        matchedText: m.matchedText,
        explanation: m.explanation,
      });

      if (m.suggestion) {
        suggestedFixes.push({
          original: m.matchedText,
          suggestion: m.suggestion,
        });
      }
    }
  }

  return {
    clean: violations.length === 0,
    violations,
    suggestedFixes,
  };
}

module.exports = { RULES, checkViolations, scan };

/* ───────────────────────────────────────────────────────────────────────────
 * Self-test — run directly with: node agents/lib/tiktok-violation-checker.js
 *
 * Exercises every one of the 11 rules with a known-bad string (expected
 * clean:false) and a set of known-good clean strings (expected clean:true).
 * Prints, per case: input snippet, clean boolean, violation count, rule ids
 * hit. Tallies mismatches; on any mismatch it console.error's and sets
 * process.exitCode = 1 so CI fails loudly. Exits 0 when all assertions pass.
 * ───────────────────────────────────────────────────────────────────────── */
if (require.main === module) {
  // Map human-readable rule label -> stable rule id, so we can surface the
  // rule ids hit (checkViolations reports the label + severity, not the id).
  const LABEL_TO_ID = {};
  for (const r of RULES) LABEL_TO_ID[r.rule] = r.id;

  // Inspect one script: returns { clean, count, ids[] }.
  function inspect(text) {
    const res = checkViolations(text);
    const ids = Array.from(
      new Set(res.violations.map((v) => LABEL_TO_ID[v.rule] || 'UNKNOWN'))
    );
    return { clean: res.clean, count: res.violations.length, ids };
  }

  const snippet = (s) => (s.length > 60 ? s.slice(0, 57) + '...' : s);

  // One known-bad string per rule. Each MUST yield clean:false AND its rule id.
  const BAD = [
    { id: 'EXAGGERATED_PROMISES', text: 'You get guaranteed results instantly with this.' },
    { id: 'MEDICAL_CLAIMS', text: 'This product cures eczema for everyone.' },
    { id: 'WEIGHT_MANAGEMENT', text: 'Lose 20 lbs fast with this weight loss drink.' },
    { id: 'COSMETICS_OVERREACH', text: 'This skincare serum has a real pharmacological effect on your face.' },
    { id: 'FOOD_MEDICINAL', text: 'This supplement gummy has medicinal properties.' },
    { id: 'CHARITABLE_DONATION', text: 'For every order, we donate to a great cause.' },
    { id: 'REDIRECT_OFFPLATFORM', text: 'Buy it now at shopnow.com, link in bio!' },
    { id: 'VAGUE_PRICE_COMPARISON', text: "It's way cheaper than competitors, trust me." },
    { id: 'DISPARAGING_COMPETITOR', text: 'Their product is total garbage compared to ours.' },
    { id: 'MINOR_TARGETING', text: 'This is perfect for minors and kids everywhere.' },
    { id: 'STITCH_AND_CREDIT', text: 'Reposting this clip I found, using their clip here.' },
  ];

  // Known-good strings — must be clean across ALL rules (no stray handles/urls).
  const GOOD = [
    'I added this serum to my nightly routine and my skin felt softer to me over a few weeks.',
    'This drink tastes great and fits nicely into my busy mornings.',
    "Grab it on the TikTok Shop via the yellow basket — it's 20 percent off right now.",
    'I stitched the original clip and credited the creator in my video.',
    'Honestly I just love how this lip mask feels; everyone is different so results vary.',
  ];

  let failures = 0;

  console.log('=== TikTok Violation Checker — self-test ===\n');
  console.log('--- Known-BAD (expect clean:false + matching rule id) ---');
  for (const c of BAD) {
    const r = inspect(c.text);
    const idMatch = r.ids.includes(c.id);
    const pass = r.clean === false && idMatch;
    if (!pass) failures++;
    console.log(
      `${pass ? 'PASS' : 'FAIL'} [${c.id}] clean=${r.clean} count=${r.count} ids=${r.ids.join(',') || '(none)'}`
    );
    console.log(`     input: "${snippet(c.text)}"`);
    if (!pass) {
      console.error(
        `  ✗ MISMATCH [${c.id}]: expected clean:false with id "${c.id}", got clean:${r.clean} ids:[${r.ids.join(',')}]`
      );
    }
  }

  console.log('\n--- Known-GOOD (expect clean:true, 0 violations) ---');
  for (const text of GOOD) {
    const r = inspect(text);
    const pass = r.clean === true && r.count === 0;
    if (!pass) failures++;
    console.log(
      `${pass ? 'PASS' : 'FAIL'} clean=${r.clean} count=${r.count} ids=${r.ids.join(',') || '(none)'}`
    );
    console.log(`     input: "${snippet(text)}"`);
    if (!pass) {
      console.error(
        `  ✗ MISMATCH (good): expected clean:true/0, got clean:${r.clean} count:${r.count} ids:[${r.ids.join(',')}]`
      );
    }
  }

  const totalRules = RULES.length;
  const coveredIds = new Set(BAD.map((b) => b.id));
  const uncovered = RULES.map((r) => r.id).filter((id) => !coveredIds.has(id));
  if (uncovered.length) {
    failures++;
    console.error(`  ✗ COVERAGE GAP: rules with no known-bad case: ${uncovered.join(', ')}`);
  }

  console.log(
    `\n=== Summary: ${BAD.length} bad + ${GOOD.length} good cases, ${totalRules} rules covered, ${failures} failure(s) ===`
  );

  if (failures > 0) {
    console.error(`SELF-TEST FAILED with ${failures} mismatch(es).`);
    process.exitCode = 1;
  } else {
    console.log('SELF-TEST PASSED — all assertions held.');
  }
}
