// lib/weekly-report.js
// Weekly Report — rendering + narrative generation.
//
// Both functions here are pure: no TikTok tokens, no brand-lookup, no
// closures over dashboard-server.js state. That's deliberate — it's what
// lets this same module be required both by dashboard-server.js (the real
// pipeline) and by lib/weekly-report-narrative.eval.js (the eval harness),
// with no server boot required to test the narrative generator in isolation.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// Deterministic HTML render — zero LLM. This alone is a complete, honest
// report; the narrative below only adds a few sentences of context on top.
function renderReportHTML(context) {
  const pct = (n) => (n == null ? '—' : (n * 100).toFixed(1) + '%');
  const usd = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
  const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));

  const affiliatesRows = (context.topAffiliates || []).map(a =>
    `<tr><td>@${esc(a.handle)}</td><td style="text-align:right">${usd(a.gmv)}</td></tr>`
  ).join('') || '<tr><td colspan="2" style="color:#888">No affiliate data available</td></tr>';

  const taskRows = (context.completedTasks || []).map(t =>
    `<tr><td>${esc(t.task)}</td><td>${esc(t.pillar)}</td><td>${new Date(t.completedOn).toLocaleDateString()}</td></tr>`
  ).join('') || '<tr><td colspan="3" style="color:#888">No tasks completed in this window</td></tr>';

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${esc(context.brandName)} — Weekly Report</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;padding:32px;color:#1a1a1a}
h1{font-size:22px;margin-bottom:4px} .sub{color:#666;font-size:13px;margin-bottom:24px}
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:28px}
.stat{background:#f7f7f5;border-radius:8px;padding:14px}
.stat .label{font-size:11px;text-transform:uppercase;color:#888;letter-spacing:.04em}
.stat .value{font-size:22px;font-weight:700;margin-top:2px}
h2{font-size:15px;margin-top:28px;margin-bottom:8px}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:6px 0;border-bottom:1px solid #eee}
.narrative{background:#f7f7f5;border-left:3px solid #999;padding:12px 16px;margin-bottom:24px;font-size:14px;line-height:1.5}
.note{color:#999;font-size:11px;margin-top:4px}
</style></head><body>
<h1>${esc(context.brandName)} — Weekly Report</h1>
<div class="sub">${new Date(context.range.start).toLocaleDateString()} – ${new Date(context.range.end).toLocaleDateString()}</div>
${context.narrative ? `<div class="narrative">${esc(context.narrative)}</div>` : ''}
<div class="stats">
  <div class="stat"><div class="label">Impressions</div><div class="value">${num(context.shopMetrics?.impressions)}</div></div>
  <div class="stat"><div class="label">Sales</div><div class="value">${usd(context.shopMetrics?.sales)}</div></div>
  <div class="stat"><div class="label">CTR</div><div class="value">${pct(context.shopMetrics?.ctr)}</div></div>
  <div class="stat"><div class="label">Click-to-Order Rate</div><div class="value">${pct(context.shopMetrics?.clickToOrderRate)}</div></div>
</div>
<h2>Top Performing Affiliates <span class="note">(recent, not exactly this week — see note)</span></h2>
<table><tbody>${affiliatesRows}</tbody></table>
<h2>Completed This Week</h2>
<table><tbody>${taskRows}</tbody></table>
</body></html>`;
}

// LLM narrative. Strictly grounded: the system prompt forbids stating any
// number not present in the JSON handed to it, and requires an honest
// "no data" response rather than a guess — the anti-hallucination rule from
// the roadmap, enforced in the prompt itself, not just hoped for.
async function generateNarrative(context) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: `You write a 2-4 sentence narrative summary for a TikTok Shop client's weekly performance report.
RULES (do not break these):
- Only reference numbers that appear in the JSON provided below. Never estimate, round differently, or invent a figure not present.
- If a figure is null, say data wasn't available for it — never guess a value.
- Be honest about a bad week. Do not spin a decline as a positive.
- No greeting, no sign-off — just the summary body.`,
      messages: [{
        role: 'user',
        content: `Client: ${context.brandName}\nWindow: ${new Date(context.range.start).toISOString().slice(0,10)} to ${new Date(context.range.end).toISOString().slice(0,10)}\n\nData:\n${JSON.stringify({ shopMetrics: context.shopMetrics, topAffiliates: context.topAffiliates, completedTaskCount: (context.completedTasks || []).length }, null, 2)}`,
      }],
    });
    return msg.content?.[0]?.text || null;
  } catch (e) {
    console.error('[client-agent] narrative generation failed:', e.message);
    return null; // report still renders fine without narrative — see renderReportHTML
  }
}

module.exports = { renderReportHTML, generateNarrative };
