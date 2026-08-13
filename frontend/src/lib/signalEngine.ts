/**
 * lib/signalEngine.ts — Signal Engine prospect scoring, ported faithfully
 * from dashboard/segments.html's client-side JS (seLoad/seSaveAll/
 * seCalcHeat/SE_PHASES etc.). This is genuinely 100% client-side in the
 * original — localStorage only, no backend at all — so the port keeps the
 * exact same storage key ('signalEngine_prospects'): any prospects a staff
 * member already scored in the legacy page are still there after cutover,
 * same browser/origin.
 */

export const SE_KEY = 'signalEngine_prospects';

export type SignalKey = 'social' | 'jobs' | 'growth' | 'reviews' | 'glassdoor' | 'intent';
export const SIGNAL_KEYS: SignalKey[] = ['social', 'jobs', 'growth', 'reviews', 'glassdoor', 'intent'];
export const SIGNAL_LABELS: Record<SignalKey, string> = {
  social: 'Social Activity',
  jobs: 'Job Listings / Hiring',
  growth: 'Growth / Press / Funding',
  reviews: 'Client / Customer Reviews',
  glassdoor: 'Employee Sentiment (Glassdoor)',
  intent: 'Intent Data (topic surges)',
};
export const SIGNAL_PLACEHOLDERS: Record<SignalKey, string> = {
  social: 'Summary: what are they posting / asking about?',
  jobs: 'Summary: what roles, what systems/workflows implied?',
  growth: 'Summary: funding rounds, expansions, initiatives?',
  reviews: 'Summary: public gaps you can fill?',
  glassdoor: 'Summary: workflow / tooling pain from employees?',
  intent: 'Summary: Bombora-style topic surges, if available',
};

export type Direction = 'rising' | 'flat' | 'declining';

export interface Prospect {
  id: string;
  name: string;
  company: string;
  role: string;
  email: string;
  source: string;
  signals: Record<SignalKey, number>;
  notes: Record<SignalKey, string>;
  direction: Direction;
  touches: boolean[];
  createdAt: string;
}

export function seLoad(): Prospect[] {
  try {
    return JSON.parse(localStorage.getItem(SE_KEY) || '[]');
  } catch {
    return [];
  }
}

export function seSaveAll(arr: Prospect[]) {
  localStorage.setItem(SE_KEY, JSON.stringify(arr));
}

export function seHeatColor(n: number): string {
  if (n >= 70) return '#10b981';
  if (n >= 40) return '#f59e0b';
  return '#ef4444';
}

/** Average of non-zero signal scores, +bonus (up to 10) when 2+ signals corroborate (both > 40). */
export function seCalcHeat(signals: Record<SignalKey, number> | undefined): number {
  const vals = SIGNAL_KEYS.map((k) => (signals && signals[k]) || 0);
  const nonZero = vals.filter((v) => v > 0);
  if (!nonZero.length) return 0;
  const avg = nonZero.reduce((a, b) => a + b, 0) / nonZero.length;
  const strong = nonZero.filter((v) => v > 40).length;
  const bonus = strong >= 2 ? Math.min(10, (strong - 1) * 4) : 0;
  return Math.min(100, Math.round(avg + bonus));
}

export function newProspect(input: { name: string; company: string; role: string; email: string; source: string }): Prospect {
  return {
    id: Date.now().toString(),
    name: input.name,
    company: input.company,
    role: input.role,
    email: input.email,
    source: input.source,
    signals: { social: 0, jobs: 0, growth: 0, reviews: 0, glassdoor: 0, intent: 0 },
    notes: { social: '', jobs: '', growth: '', reviews: '', glassdoor: '', intent: '' },
    direction: 'flat',
    touches: [],
    createdAt: new Date().toISOString(),
  };
}

// ── 25-touch phase tracker — exact copy of SE_PHASES from segments.html ────
export interface TouchStep { ch: string; day: number; }
export interface Phase { label: string; touches: TouchStep[]; }

export const SE_PHASES: Phase[] = [
  { label: 'Phase 1 — Awareness', touches: [
    { ch: 'LinkedIn View', day: 1 }, { ch: 'LinkedIn Comment', day: 2 },
    { ch: 'Email', day: 3 }, { ch: 'LinkedIn DM', day: 5 }, { ch: 'Email', day: 7 },
  ] },
  { label: 'Phase 2 — Engagement', touches: [
    { ch: 'LinkedIn Comment', day: 9 }, { ch: 'Email', day: 10 }, { ch: 'LinkedIn DM', day: 12 },
    { ch: 'Email', day: 14 }, { ch: 'LinkedIn View', day: 15 }, { ch: 'Email', day: 17 },
  ] },
  { label: 'Phase 3 — Pursuit', touches: [
    { ch: 'LinkedIn DM', day: 19 }, { ch: 'Email', day: 21 }, { ch: 'LinkedIn Comment', day: 22 },
    { ch: 'Email', day: 24 }, { ch: 'LinkedIn DM', day: 26 }, { ch: 'Email', day: 28 },
    { ch: 'LinkedIn View', day: 30 },
  ] },
  { label: 'Phase 4 — Dynamic Budget', touches: [
    { ch: 'Email', day: 33 }, { ch: 'LinkedIn DM', day: 35 }, { ch: 'Email', day: 38 },
    { ch: 'LinkedIn Comment', day: 40 }, { ch: 'Email', day: 43 }, { ch: 'LinkedIn DM', day: 46 },
  ] },
];

export const TOTAL_TOUCHES = SE_PHASES.reduce((n, p) => n + p.touches.length, 0);

const CHANNELS = ['Email', 'LinkedIn DM', 'LinkedIn View', 'LinkedIn Comment', 'SMS'];
export function nextChannel(touchCount: number): string {
  return CHANNELS[touchCount % CHANNELS.length];
}

/** Builds the exact ConductorBot prompt text the original "Build Prompt" button generated, for copy-paste into an external AI tool. */
export function buildOutreachPrompt(p: Prospect, opts: { channel: string; touchNumber: number; senderName: string; senderCompany: string }): string {
  const signals: Record<string, { score: number; summary: string }> = {};
  const sigLabelKeys: Record<SignalKey, string> = {
    social: 'social_activity', jobs: 'job_listings', growth: 'growth_announcements',
    reviews: 'client_reviews', glassdoor: 'employee_sentiment', intent: 'intent_data',
  };
  SIGNAL_KEYS.forEach((k) => {
    signals[sigLabelKeys[k]] = { score: p.signals[k] || 0, summary: p.notes[k] || '' };
  });

  const input = {
    prospect: { name: p.name, company: p.company, role: p.role },
    signals,
    request: {
      action: 'GENERATE_MESSAGE',
      channel: opts.channel,
      sender_name: opts.senderName,
      sender_company: opts.senderCompany,
      touch_number: opts.touchNumber,
    },
  };

  const phase = opts.touchNumber <= 5 ? 'awareness phase, low pressure'
    : opts.touchNumber <= 11 ? 'engagement phase, reference a specific detail'
    : opts.touchNumber <= 18 ? 'pursuit phase, clearer ask'
    : 'dynamic phase, follow wherever engagement is highest';

  return `You are ConductorBot, an outreach message generator. Given the signals below, generate a ${opts.channel.replace('_', ' ')} message.

Rules:
- Lead with the single strongest qualifying signal as the hook
- Keep it specific to what the signal actually says
- Sender: ${opts.senderName} from ${opts.senderCompany} (inject naturally, never hardcode a pitch)
- Touch #${opts.touchNumber} — ${phase}
- Output JSON only, matching this schema:

{
  "decision": "PROCEED" or "HOLD",
  "selected_signal": "SIGNAL_TYPE",
  "signal_score": 0,
  "touch_angle": "PRIMARY_SIGNAL",
  "message": { "body": "...", "cta_type": "SOFT_OPEN|DIRECT_ASK|FOLLOW_UP", "word_count": 0 },
  "crm_instructions": { "log_note": "...", "tags_to_add": [] }
}

Input:
${JSON.stringify(input, null, 2)}`;
}
