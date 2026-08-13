/**
 * lib/proposalHtml.ts — the proposal DOCUMENT builder, ported from
 * dashboard/segments.html's buildProposalHTML() + the pm-* CSS block +
 * exportProposalHTML()'s embedded chart script, nearly verbatim (same
 * class names, same copy, same layout) since this is a client-facing sales
 * document — fidelity matters more than idiomatic componentization here.
 *
 * One document builder serves two purposes, by design (simpler and more
 * faithful than the original, which had two separately-maintained copies
 * of the chart JS — one for the live modal via Chart.js global, one
 * embedded as a string inside exportProposalHTML() for the exported file):
 *   - the live in-app preview, rendered in an <iframe srcDoc=...>
 *   - the payload sent to POST /api/proposals/publish for the public link
 * Same HTML both times, so what staff preview is exactly what gets shared.
 */
import type { GeneratedProposal } from './crmApi';
import { computeMetrics, computeMonthlyRamp, computeBreakEven, type Metrics, type MetricsInput } from './proposalEngine';

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const fmt$ = (n: number) => '$' + Math.round(n).toLocaleString();
const fmtPct = (n: number) => (n * 100).toFixed(1) + '%';
const fmtK = (n: number) => (n >= 1000 ? '$' + (n / 1000).toFixed(0) + 'k' : fmt$(n));

/** Same CSS as dashboard/segments.html's pm-* block, verbatim. */
export const PROPOSAL_CSS = `
.pm-body{padding:0 32px 60px;max-width:860px;margin:0 auto;}
.pm-hero{padding:48px 0 32px;border-bottom:1px solid #0b2528;}
.pm-hero-brand{font-size:2rem;font-weight:800;color:#fff;letter-spacing:-.02em;margin-bottom:6px;}
.pm-hero-tagline{font-size:1rem;color:#5eead4;font-style:italic;margin-bottom:20px;line-height:1.5;}
.pm-hero-meta{display:flex;gap:16px;font-size:.72rem;color:#64748b;}
.pm-hero-meta span{display:flex;align-items:center;gap:4px;}
.pm-section{padding:32px 0;border-bottom:1px solid #0b2528;}
.pm-section:last-child{border-bottom:none;}
.pm-section-label{font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#0d9488;margin-bottom:12px;}
.pm-section-title{font-size:1.1rem;font-weight:700;color:#e2e8f0;margin-bottom:12px;}
.pm-body-text{font-size:.85rem;color:#94a3b8;line-height:1.7;margin-bottom:10px;}
.pm-metrics{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0;}
.pm-metric{background:#091819;border:1px solid #0f3035;border-radius:10px;padding:12px 18px;}
.pm-metric-val{font-size:1.4rem;font-weight:800;color:#fff;}
.pm-metric-label{font-size:.65rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-top:2px;}
.pm-fin-table{width:100%;border-collapse:collapse;font-size:.82rem;margin:12px 0;}
.pm-fin-table td{padding:9px 14px;border-bottom:1px solid #0b2528;color:#94a3b8;}
.pm-fin-table td:first-child{color:#e2e8f0;font-weight:600;width:55%;}
.pm-fin-table tr:last-child td{border-bottom:none;color:#10b981;font-size:.9rem;font-weight:700;}
.pm-fin-box{background:#091819;border:1px solid #0f3035;border-radius:10px;overflow:hidden;}
.pm-roadmap{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:12px 0;}
.pm-phase{background:#091819;border:1px solid #0f3035;border-radius:10px;padding:16px;}
.pm-phase-label{font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#0d9488;margin-bottom:4px;}
.pm-phase-title{font-size:.82rem;font-weight:700;color:#e2e8f0;margin-bottom:10px;}
.pm-phase ul{list-style:none;padding:0;}
.pm-phase ul li{font-size:.74rem;color:#94a3b8;padding:4px 0;border-bottom:1px solid #0b252822;line-height:1.4;}
.pm-phase ul li::before{content:"→ ";color:#0d9488;font-weight:700;}
.pm-calc{background:#091819;border:1px solid #0f3035;border-radius:12px;padding:20px;margin:12px 0;}
.pm-calc-row{display:flex;align-items:center;gap:12px;margin-bottom:14px;}
.pm-calc-label{font-size:.73rem;color:#94a3b8;min-width:160px;}
.pm-calc-slider{flex:1;accent-color:#20d5c4;}
.pm-calc-val{font-size:.8rem;font-weight:700;color:#e2e8f0;min-width:70px;text-align:right;}
.pm-chart-wrap{position:relative;height:220px;margin-top:12px;}
.pm-breakeven-callout{display:flex;align-items:center;gap:12px;background:#0f1e15;border:1px solid #166534;border-radius:10px;padding:14px 18px;margin-top:14px;}
.pm-breakeven-callout .be-icon{font-size:1.4rem;}
.pm-breakeven-callout .be-text{font-size:.78rem;color:#86efac;line-height:1.5;}
.pm-breakeven-callout .be-text strong{color:#4ade80;font-size:.9rem;}
.pm-pricing-card{background:#091819;border:1px solid #20d5c444;border-radius:12px;padding:24px;text-align:center;margin:12px 0;}
.pm-pricing-retainer{font-size:2.4rem;font-weight:900;color:#fff;letter-spacing:-.03em;}
.pm-pricing-sub{font-size:.78rem;color:#0d9488;margin-bottom:16px;}
.pm-pricing-gmv{font-size:1.1rem;font-weight:700;color:#5eead4;margin-bottom:20px;}
.pm-pricing-features{list-style:none;padding:0;text-align:left;}
.pm-pricing-features li{font-size:.78rem;color:#94a3b8;padding:6px 0;border-bottom:1px solid #0b2528;display:flex;align-items:center;gap:8px;}
.pm-pricing-features li::before{content:"✓";color:#10b981;font-weight:700;}
.pm-why-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:12px 0;}
.pm-why-item{background:#091819;border:1px solid #0f3035;border-radius:10px;padding:14px 16px;}
.pm-why-title{font-size:.8rem;font-weight:700;color:#e2e8f0;margin-bottom:4px;}
.pm-why-desc{font-size:.73rem;color:#64748b;line-height:1.5;}
.pm-steps{list-style:none;padding:0;}
.pm-steps li{display:flex;align-items:flex-start;gap:14px;padding:12px 0;border-bottom:1px solid #0b2528;}
.pm-steps li:last-child{border-bottom:none;}
.pm-step-num{width:26px;height:26px;border-radius:50%;background:#20d5c422;border:1px solid #20d5c466;color:#5eead4;font-size:.72rem;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.pm-step-text{font-size:.82rem;color:#94a3b8;line-height:1.5;padding-top:3px;}
.pm-footer{padding:32px 0;text-align:center;border-top:1px solid #0b2528;color:#64748b;font-size:.75rem;}
.pm-footer a{color:#20d5c4;text-decoration:none;}
`;

/**
 * Content-only HTML (the modal body / document body content) — ported
 * verbatim from buildProposalHTML(p). `metrics` should be
 * computeMetrics(...) run against the confirmed review-step values.
 */
export function buildProposalBodyHtml(p: GeneratedProposal, metrics: Metrics, brandLogoUrl: string | null): string {
  const m = metrics;
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const monthData = computeMonthlyRamp(m);
  const be = computeBreakEven(m, monthData);
  const useSampleLogic = be.useSampleLogic;

  const metricsHtml = (p.currentStateMetrics || []).map((m2) =>
    `<div class="pm-metric"><div class="pm-metric-val">${esc(m2.value)}</div><div class="pm-metric-label">${esc(m2.label)}</div></div>`).join('');

  const unitRows: [string, string, string][] = [
    ['List Price', fmt$(m.listPrice), '100%'],
    ['Promo Discount', `−${fmtPct(m.promoPct)}`, `−${fmtPct(m.promoPct)}`],
    ['Selling Price', fmt$(m.sellingPrice), '100%'],
    ['— Shipping', `−${fmt$(m.shipping)}`, `−${fmtPct(m.sellingPrice ? m.shipping / m.sellingPrice : 0)}`],
    ['— COGS', `−${fmt$(m.cogs)}`, `−${fmtPct(m.sellingPrice ? m.cogs / m.sellingPrice : 0)}`],
    ['— Affiliate Commission', `−${fmt$(m.affComm)}`, `−${fmtPct(m.affCommPct)}`],
    ['— TikTok Fee (6%)', `−${fmt$(m.tikTokFee)}`, '−6.0%'],
    ...(m.adspendPct > 0 ? [['— Adspend', `−${fmt$(m.adspend)}`, `−${fmtPct(m.adspendPct)}`] as [string, string, string]] : []),
    ['Gross Profit / Order', fmt$(m.grossProfitPerOrder), fmtPct(m.grossMarginPct)],
  ];
  const unitTableHtml = `<div class="pm-fin-box"><table class="pm-fin-table">
    ${unitRows.map((r, i) => `<tr style="${i === unitRows.length - 1 ? 'background:#0d1a12' : ''}"><td>${r[0]}</td><td>${r[1]}</td><td style="color:#64748b;font-size:.7rem">${r[2]}</td></tr>`).join('')}
  </table></div>`;

  const kpiTableHtml = `<div class="pm-fin-box" style="margin-top:16px"><table class="pm-fin-table">
    <tr style="background:#091819"><td style="color:#5eead4;font-weight:800">Month</td><td style="color:#5eead4">Creators</td><td style="color:#5eead4">Impressions/mo</td><td style="color:#5eead4">Purchases/mo</td><td style="color:#5eead4">Est. GMV/mo</td></tr>
    ${monthData.map((d) => `<tr><td style="font-weight:700;color:#e2e8f0">Month ${d.mo}</td><td>${d.c.toLocaleString()}</td><td>${d.imp.toLocaleString()}</td><td>${d.purch.toLocaleString()}</td><td style="color:#10b981;font-weight:700">${fmtK(d.gmv)}</td></tr>`).join('')}
    ${be.beCreators && be.beGMV != null && be.beCreators > monthData[5].c ? `
    <tr style="background:#0d1a0d;border-top:1px dashed #166534">
      <td style="font-weight:700;color:#4ade80">🎯 Break-Even Scale</td>
      <td style="color:#4ade80;font-weight:700">${be.beCreators}</td>
      <td style="color:#4ade80">${(be.beCreators * m.videosPerCreator * m.avgViews).toLocaleString()}</td>
      <td style="color:#4ade80">${Math.round(be.beGMV / m.sellingPrice).toLocaleString()}</td>
      <td style="color:#4ade80;font-weight:700">${fmtK(be.beGMV)}</td>
    </tr>` : ''}
  </table></div>`;

  const waterfallHtml = `<div class="pm-section-label" style="margin-top:24px">All-In Cost Waterfall — Month 6 Run Rate</div>
  <div class="pm-fin-box"><table class="pm-fin-table">
    ${be.waterfallRows.map((r) => `
      <tr style="${r.bold ? 'background:#0d1a12' : ''}">
        <td style="color:${r.bold ? r.color : '#94a3b8'};font-weight:${r.bold ? '800' : '400'}">${r.label}</td>
        <td style="color:${r.color};font-weight:${r.bold ? '800' : '600'}">${r.val >= 0 ? fmt$(r.val) : '(' + fmt$(Math.abs(r.val)) + ')'}</td>
        <td style="color:#64748b;font-size:.7rem">${(r.pct * 100).toFixed(1)}%</td>
      </tr>`).join('')}
  </table></div>`;

  let beHtml: string;
  if (be.channelProfitable) {
    beHtml = `<div class="pm-breakeven-callout"><div class="be-icon">📊</div><div class="be-text">
      GMV rev share: <strong>${fmtPct(m.revSharePct)}</strong> throughout all phases.
      Break-even at <strong>${be.beGMV != null ? fmtK(be.beGMV) : '—'}/mo GMV</strong>.
      At ${fmtK(be.scaled.gmv)}/mo run rate, net profit is <strong style="color:#4ade80">${fmt$(be.scaledNet)}/mo</strong>.
    </div></div>`;
  } else if (be.beGMV != null && be.beCreators) {
    beHtml = `<div class="pm-breakeven-callout" style="background:#0f1a0f;border-color:#166534;flex-direction:column;align-items:flex-start;gap:10px">
      <div style="display:flex;align-items:center;gap:10px">
        <div class="be-icon">🎯</div>
        <div class="be-text">
          GMV rev share: <strong>${fmtPct(m.revSharePct)}</strong> throughout all phases.
          Month 6 run rate (<strong>${fmtK(be.scaled.gmv)}/mo</strong>) is below break-even — the channel covers its costs at
          <strong style="color:#4ade80">${fmtK(be.beGMV)}/mo GMV</strong>.
        </div>
      </div>
      <table style="width:100%;font-size:.75rem;border-collapse:collapse">
        <tr>
          <td style="color:#64748b;padding:4px 0">Month 6 projection (${monthData[5].c} creators${useSampleLogic ? ` — ${m.monthlySamples} samples/mo` : ''})</td>
          <td style="text-align:right;color:#f87171;font-weight:700">${fmtK(be.scaled.gmv)}/mo</td>
          <td style="text-align:right;color:#f87171;padding-left:16px">${fmt$(be.scaledNet)}/mo net</td>
        </tr>
        <tr>
          <td style="color:#4ade80;font-weight:700;padding:4px 0">🎯 Break-even (${be.beCreators} creators${be.beSamples ? ` — ${be.beSamples} samples/mo` : ''})</td>
          <td style="text-align:right;color:#4ade80;font-weight:700">${fmtK(be.beGMV)}/mo</td>
          <td style="text-align:right;color:#4ade80;padding-left:16px">$0/mo net</td>
        </tr>
        <tr>
          <td style="color:#86efac;padding:4px 0">Scale target (${be.beCreators * 2}+ creators${be.beSamples ? ` — ${be.beSamples * 2} samples/mo` : ''})</td>
          <td style="text-align:right;color:#86efac;font-weight:700">${fmtK(be.beGMV * 2)}/mo</td>
          <td style="text-align:right;color:#86efac;padding-left:16px">~${fmt$(Math.round(be.beGMV * (m.grossMarginPct - m.revSharePct - 0.02)))}/mo net</td>
        </tr>
      </table>
      <div style="font-size:.72rem;color:#64748b">The channel turns profitable as the creator roster scales past ${be.beCreators}${be.beSamples ? ` (requires ${be.beSamples} samples/mo outreach)` : ''}. Projections above reflect actual month-by-month accumulation — the roadmap targets ${be.beCreators}+ active creators by Month 6.</div>
    </div>`;
  } else {
    beHtml = `<div class="pm-breakeven-callout"><div class="be-icon">📊</div><div class="be-text">
      GMV rev share: <strong>${fmtPct(m.revSharePct)}</strong> throughout all phases.
      At ${fmtK(be.scaled.gmv)}/mo run rate, net profit is <strong style="color:#f87171">${fmt$(be.scaledNet)}/mo</strong>.
      See AOV strategy below.
    </div></div>`;
  }

  // Profitability alert + fix
  const pf = p.profitabilityFix || {};
  let profitabilityHtml = '';
  if (m.isUnprofitable) {
    const fmt2 = (n: number | null) => (n != null ? '$' + n.toFixed(2) : '—');
    const targetGM = m.targetAOV ? Math.round((1 - (m.cogs + m.shipping) / m.targetAOV - (m.affCommPct + m.tikTokFeePct + m.adspendPct)) * 100) : 35;
    const tPrice = m.targetAOV || 0;
    const tGross = m.targetGrossProfitPerOrder || 0;
    const tGMV = tPrice * monthData[2].purch;
    const tGmvShare = m.revSharePct * tGMV;
    const tNet = tGross * monthData[2].purch - m.teamFee - tGmvShare - be.steadyStateSampleCost - m.affiliateRetainers - tGMV * 0.02;

    profitabilityHtml = `
    <div style="margin:32px 0;border:1.5px solid #ef4444;border-radius:12px;overflow:hidden">
      <div style="background:#2d0a0a;padding:16px 20px;display:flex;align-items:center;gap:12px">
        <span style="font-size:1.4rem">⚠️</span>
        <div>
          <div style="font-size:.95rem;font-weight:800;color:#f87171">Unit Economics Problem Detected</div>
          <div style="font-size:.75rem;color:#fca5a5;margin-top:2px">At the current hero SKU price, every sale loses money before our fees are counted.</div>
        </div>
      </div>
      <div style="padding:20px;background:#1a0808">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px">
          <div>
            <div style="font-size:.7rem;color:#ef4444;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">❌ Current State</div>
            <table style="width:100%;border-collapse:collapse;font-size:.78rem">
              <tr><td style="color:#94a3b8;padding:4px 0">Selling Price</td><td style="text-align:right;color:#e2e8f0;font-weight:700">${fmt$(m.sellingPrice)}</td></tr>
              <tr><td style="color:#94a3b8;padding:4px 0">COGS + Shipping</td><td style="text-align:right;color:#ef4444">−${fmt$(m.cogs + m.shipping)}</td></tr>
              <tr><td style="color:#94a3b8;padding:4px 0">Commissions (${Math.round((m.affCommPct + m.tikTokFeePct) * 100)}%)</td><td style="text-align:right;color:#ef4444">−${fmt$(m.affComm + m.tikTokFee)}</td></tr>
              <tr style="border-top:1px solid #3d1515"><td style="color:#f87171;font-weight:700;padding:6px 0 2px">Gross Profit/Order</td><td style="text-align:right;color:#ef4444;font-weight:800">${fmt$(m.grossProfitPerOrder)}</td></tr>
              <tr><td style="color:#f87171;font-weight:700">Gross Margin</td><td style="text-align:right;color:#ef4444;font-weight:800">${(m.grossMarginPct * 100).toFixed(1)}%</td></tr>
            </table>
          </div>
          <div>
            <div style="font-size:.7rem;color:#10b981;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">✅ Target State (${fmt2(m.targetAOV)} AOV)</div>
            <table style="width:100%;border-collapse:collapse;font-size:.78rem">
              <tr><td style="color:#94a3b8;padding:4px 0">Selling Price</td><td style="text-align:right;color:#e2e8f0;font-weight:700">${fmt2(m.targetAOV)}</td></tr>
              <tr><td style="color:#94a3b8;padding:4px 0">COGS + Shipping</td><td style="text-align:right;color:#f59e0b">−${fmt$(m.cogs + m.shipping)}</td></tr>
              <tr><td style="color:#94a3b8;padding:4px 0">Commissions (${Math.round((m.affCommPct + m.tikTokFeePct) * 100)}%)</td><td style="text-align:right;color:#f59e0b">−${m.targetAOV ? fmt$((m.affCommPct + m.tikTokFeePct) * m.targetAOV) : '—'}</td></tr>
              <tr style="border-top:1px solid #0d2d1a"><td style="color:#4ade80;font-weight:700;padding:6px 0 2px">Gross Profit/Order</td><td style="text-align:right;color:#10b981;font-weight:800">${fmt2(m.targetGrossProfitPerOrder)}</td></tr>
              <tr><td style="color:#4ade80;font-weight:700">Gross Margin</td><td style="text-align:right;color:#10b981;font-weight:800">~${targetGM}%</td></tr>
            </table>
          </div>
        </div>
        <div style="background:#0d1a12;border-radius:8px;padding:14px 16px;margin-bottom:16px">
          <div style="font-size:.72rem;color:#5eead4;font-weight:700;margin-bottom:6px">💡 MINIMUM VIABLE AOV</div>
          <div style="font-size:.85rem;color:#e2e8f0">Break-even per unit requires a selling price of at least <strong style="color:#f59e0b">${m.minViablePrice ? '$' + m.minViablePrice.toFixed(2) : '—'}</strong> given current COGS + shipping. At ${fmt2(m.targetAOV)} AOV you reach ~${targetGM}% gross margin — enough to cover team costs and generate profit.</div>
          ${tNet > 0 && m.targetAOV ? `<div style="margin-top:8px;font-size:.82rem;color:#4ade80;font-weight:700">At ${fmt2(m.targetAOV)} AOV: estimated <strong>${fmt$(tNet)}/mo net profit</strong> at Month 7–12 run rate.</div>` : ''}
        </div>
        ${pf.primaryIssue || pf.bundleIdea || (pf.strategySteps || []).length > 0 ? `
        <div style="font-size:.72rem;color:#fbbf24;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">🎯 The Fix: AOV Growth Strategy</div>
        ${pf.primaryIssue ? `<div style="font-size:.8rem;color:#94a3b8;margin-bottom:12px">${esc(pf.primaryIssue)}</div>` : ''}
        ${pf.bundleIdea ? `<div style="background:#1c1828;border-left:3px solid #fbbf24;padding:10px 14px;border-radius:0 6px 6px 0;margin-bottom:12px;font-size:.82rem;color:#e2e8f0"><strong style="color:#fbbf24">Recommended Bundle:</strong> ${esc(pf.bundleIdea)}</div>` : ''}
        ${(pf.strategySteps || []).length > 0 ? `<ol style="margin:0;padding-left:18px">${(pf.strategySteps || []).map((s) => `<li style="font-size:.8rem;color:#94a3b8;margin-bottom:6px">${esc(s)}</li>`).join('')}</ol>` : ''}
        ` : ''}
      </div>
    </div>`;
  }

  const rm = p.roadmap || {};
  const roadmapHtml = `<div class="pm-roadmap">
    <div class="pm-phase"><div class="pm-phase-label">Phase 1</div><div class="pm-phase-title">Month 1 — Foundation</div><ul>${(rm.month1Bullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>
    <div class="pm-phase"><div class="pm-phase-label">Phase 2</div><div class="pm-phase-title">Months 1–2 — Launch</div><ul>${(rm.months12Bullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>
    <div class="pm-phase"><div class="pm-phase-label">Phase 3</div><div class="pm-phase-title">Month 3+ — Scale</div><ul>${(rm.month3plusBullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>
  </div>`;

  const stepsHtml = `<ol class="pm-steps">${(p.nextSteps || []).map((s, i) => `<li><div class="pm-step-num">${i + 1}</div><div class="pm-step-text">${esc(s)}</div></li>`).join('')}</ol>`;

  const gmvPctFromRetainer = (10 - ((m.teamFee - 1500) / 3500) * 7).toFixed(1);

  return `
    <div class="pm-hero">
      <div style="display:flex;align-items:center;gap:20px;margin-bottom:20px;flex-wrap:wrap">
        <img src="https://assets.cdn.filesafe.space/c216j58Vx9XxYa7WYMiA/media/68529ceff63e1913ceb4e2e0.png" style="height:156px;width:auto" alt="Cult Content">
        <img src="https://assets.cdn.filesafe.space/c216j58Vx9XxYa7WYMiA/media/6978e226d119a5154347af54.png" style="height:132px;width:auto" alt="TikTok Shop Partner Agency">
        ${brandLogoUrl ? `<img src="${brandLogoUrl}" style="height:44px;width:auto;object-fit:contain;background:#fff;border-radius:6px;padding:4px 8px" alt="${esc(p.brandName)}" onerror="this.style.display='none'">` : ''}
      </div>
      <div class="pm-hero-brand">${esc(p.brandName)} × Cult Content</div>
      <div class="pm-hero-tagline">"${esc(p.tagline)}"</div>
      <div class="pm-hero-meta"><span>📅 ${today}</span><span>🔒 Confidential</span><span>🌐 cultcontent.cc</span></div>
    </div>

    <div class="pm-section">
      <div class="pm-section-label">The Opportunity</div>
      <p class="pm-body-text" style="font-size:.95rem;color:#c4b5fd;font-style:italic;line-height:1.7">${esc(p.strategicQuestion)}</p>
      ${metricsHtml ? `<div class="pm-metrics">${metricsHtml}</div>` : ''}
    </div>

    <div class="pm-section">
      <div class="pm-section-label">Channel Economics</div>
      <div class="pm-section-title">Unit Economics — Per Order</div>
      <p class="pm-body-text">Every dollar of GMV carries this cost structure. These numbers drive the projections below.</p>
      ${unitTableHtml}
      <div class="pm-section-title" style="margin-top:24px">KPI Projections — Creator-to-GMV Model</div>
      <p class="pm-body-text">${useSampleLogic
        ? `Based on ${m.monthlySamples} samples/mo × 65% activation rate — creator roster accumulates each month (accelerated by Cult Content's 500+ member affiliate community). ${m.videosPerCreator} videos/creator/mo × ${m.avgViews.toLocaleString()} avg views, ${(m.ctr * 100).toFixed(1)}% CTR, ${(m.cvr * 100).toFixed(1)}% CVR.`
        : `Based on ${m.creators.toLocaleString()} active creators at steady state. ${m.videosPerCreator} videos/creator/mo × ${m.avgViews.toLocaleString()} avg views, ${(m.ctr * 100).toFixed(1)}% CTR, ${(m.cvr * 100).toFixed(1)}% CVR.`}</p>
      ${kpiTableHtml}
      ${waterfallHtml}
      ${beHtml}
      ${profitabilityHtml}
    </div>

    <div class="pm-section">
      <div class="pm-section-label">Financial Projections</div>
      <div class="pm-section-title">12-Month P&amp;L Model</div>
      <div class="pm-calc">
        <div class="pm-calc-row"><span class="pm-calc-label">Affiliate Commission %</span><input type="range" class="pm-calc-slider" id="pm-affcomm-s" min="5" max="30" step="1" value="${Math.round(m.affCommPct * 100)}" oninput="updateProjChart()"><span class="pm-calc-val" id="pm-affcomm-s-val">${Math.round(m.affCommPct * 100)}%</span></div>
        <div class="pm-calc-row"><span class="pm-calc-label">COGS ($/unit)</span><input type="range" class="pm-calc-slider" id="pm-cogs-s" min="1" max="100" step="1" value="${Math.round(m.cogs)}" oninput="updateProjChart()"><span class="pm-calc-val" id="pm-cogs-s-val">${fmt$(m.cogs)}</span></div>
        <div class="pm-calc-row"><span class="pm-calc-label">Monthly Samples</span><input type="range" class="pm-calc-slider" id="pm-samples-s" min="0" max="1000" step="50" value="${m.monthlySamples}" oninput="updateProjChart()"><span class="pm-calc-val" id="pm-samples-s-val">${m.monthlySamples}</span></div>
      </div>
      <div class="pm-chart-wrap"><canvas id="proj-chart"></canvas></div>
    </div>

    <div class="pm-section">
      <div class="pm-section-label">Investment</div>
      <div class="pm-pricing-card">
        <div class="pm-pricing-retainer">${fmt$(m.teamFee)}</div>
        <div class="pm-pricing-sub">per month · month-to-month</div>
        <div class="pm-pricing-gmv">+ ${fmtPct(m.revSharePct)} GMV revenue share</div>
        <ul class="pm-pricing-features">
          <li>Dedicated affiliate manager + shop manager</li>
          <li>AI content system — creative briefs, hooks, scripts</li>
          <li>Creator recruitment, sampling &amp; compliance</li>
          <li>GMV Max paid amplification strategy</li>
          <li>Weekly performance reporting + bi-weekly syncs</li>
          <li>Cancel with 30 days notice — no lock-in</li>
        </ul>
      </div>
    </div>

    <div class="pm-section">
      <div class="pm-section-label">Pricing Model</div>
      <div class="pm-section-title">Built Around Your Bottom Line</div>
      <p class="pm-body-text">We don't lock brands into fixed contracts. The retainer and GMV share are inversely linked — slide to whatever balance makes sense for your margin structure. Every configuration is month-to-month. You stay because results compound, not because a contract forces you to.</p>
      <div class="pm-calc" style="margin-top:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <span style="font-size:.72rem;color:#5eead4;font-weight:700">Monthly Retainer</span>
          <span style="font-size:.72rem;color:#5eead4;font-weight:700">GMV Revenue Share</span>
        </div>
        <div class="pm-calc-row" style="margin-bottom:8px;gap:16px">
          <span id="pm-pricing-ret-val" style="min-width:100px;font-size:1.5rem;font-weight:800;color:#fff;white-space:nowrap">${fmt$(m.teamFee)}<span style="font-size:.7rem;color:#64748b;font-weight:400">/mo</span></span>
          <input type="range" class="pm-calc-slider" id="pm-pricing-slider" min="1500" max="5000" step="100" value="${m.teamFee}" oninput="updatePricingSlider()" style="flex:1">
          <span id="pm-pricing-gmv-val" style="min-width:70px;font-size:1.5rem;font-weight:800;color:#10b981;text-align:right">${gmvPctFromRetainer}%</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:.65rem;color:#1a5a60;margin-bottom:20px"><span>$1,500/mo · 10% GMV</span><span>$5,000/mo · 3% GMV</span></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div style="background:#091819;border:1px solid #0f3035;border-radius:10px;padding:16px"><div style="font-size:.65rem;color:#5eead4;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Lower retainer</div><div style="font-size:.8rem;color:#94a3b8;line-height:1.5">Higher GMV share means we're fully aligned with your growth. The more you sell, the more we earn — so we have every reason to push hard from day one.</div></div>
          <div style="background:#091819;border:1px solid #0f3035;border-radius:10px;padding:16px"><div style="font-size:.65rem;color:#10b981;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Higher retainer</div><div style="font-size:.8rem;color:#94a3b8;line-height:1.5">Lower GMV share protects your margin at scale. As your channel matures, shifting the balance means more profit stays with you — without renegotiating the whole relationship.</div></div>
        </div>
        <div style="margin-top:14px;padding:14px 18px;background:#0d1a12;border:1px solid #166534;border-radius:8px;font-size:.78rem;color:#86efac;line-height:1.6"><strong style="color:#4ade80">Month-to-month, no lock-in.</strong> Cancel with 30 days notice. Adjust the structure as your business evolves. We're not interested in holding brands to contracts that don't reflect reality — we'd rather earn your business every month.</div>
      </div>
    </div>

    <div class="pm-section">
      <div class="pm-section-label">Execution Plan</div>
      <div class="pm-section-title">What We'll Build</div>
      ${roadmapHtml}
    </div>

    <div class="pm-section">
      <div class="pm-section-label">Why Cult Content</div>
      <div class="pm-why-grid">
        <div class="pm-why-item"><div class="pm-why-title">Founder-Led Execution</div><div class="pm-why-desc">Tommy Lynch runs your account directly. Not a junior account manager. Not a team you'll never meet.</div></div>
        <div class="pm-why-item"><div class="pm-why-title">AI Content System</div><div class="pm-why-desc">Faster creative iteration at a fraction of traditional production cost. Volume without bloated budgets.</div></div>
        <div class="pm-why-item"><div class="pm-why-title">GMV Max Expertise</div><div class="pm-why-desc">We don't run ads until organic is converting. Then we amplify what's already working. No wasted ad spend.</div></div>
        <div class="pm-why-item"><div class="pm-why-title">Full-Stack Shop Management</div><div class="pm-why-desc">Affiliate recruitment, compliance, listing optimization, creator briefing, and reporting — all under one roof.</div></div>
        <div class="pm-why-item"><div class="pm-why-title">Aligned Incentives</div><div class="pm-why-desc">The performance fee means we only win when you do. No retainer-padding. No inflated deliverables.</div></div>
        <div class="pm-why-item"><div class="pm-why-title">Proven at Scale</div><div class="pm-why-desc">100M+ views generated. $1M+ in GMV driven. We know what works on TikTok Shop and what doesn't.</div></div>
      </div>
    </div>

    <div class="pm-section">
      <div class="pm-section-label">Next Steps</div>
      ${stepsHtml}
    </div>

    <div class="pm-footer">
      <div style="display:flex;align-items:center;justify-content:center;gap:16px;margin-bottom:16px">
        <img src="https://assets.cdn.filesafe.space/c216j58Vx9XxYa7WYMiA/media/68529ceff63e1913ceb4e2e0.png" style="height:28px;width:auto;opacity:.7" alt="Cult Content">
        <img src="https://assets.cdn.filesafe.space/c216j58Vx9XxYa7WYMiA/media/6978e226d119a5154347af54.png" style="height:22px;width:auto;opacity:.7" alt="TikTok Shop Partner Agency">
      </div>
      <div style="font-size:1rem;font-weight:700;color:#e2e8f0;margin-bottom:6px">Ready to move forward?</div>
      <a href="https://cultcontent.cc/book-with-tommy" target="_blank" style="display:inline-block;background:#ee1d52;color:#fff;padding:10px 28px;border-radius:8px;font-size:.85rem;font-weight:600;text-decoration:none;margin-bottom:16px">Book a Call →</a>
      <div>Tommy Lynch · <a href="mailto:tommy@cultcontent.cc">tommy@cultcontent.cc</a> · cultcontent.cc</div>
      <div style="margin-top:6px;color:#2a5a60">Confidential — prepared exclusively for ${esc(p.brandName)}</div>
    </div>
  `;
}

/**
 * The embedded, interactive chart + pricing-slider script — ported
 * verbatim from exportProposalHTML()'s embedded `_renderChart`/
 * `updateProjChart`/`updatePricingSlider`. Needs `_p` (the same JSON the
 * original passes: {brandName, pricing, _metrics: MetricsInput-shaped}).
 */
function chartScript(p: GeneratedProposal, metricsInput: MetricsInput): string {
  const payload = JSON.stringify({ pricing: p.pricing, _metrics: metricsInput });
  return `
const _p = ${payload};
let _chartInst = null;
function _renderChart(p) {
  const canvas = document.getElementById('proj-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (_chartInst) { _chartInst.destroy(); _chartInst = null; }
  const m = p._metrics || {};
  const pr = p.pricing || {};
  const affCommPct = (parseFloat(document.getElementById('pm-affcomm-s')?.value || m.affiliateCommPct || 25)) / 100;
  const cogsVal = parseFloat(document.getElementById('pm-cogs-s')?.value || m.cogsPerUnit || 0);
  const samplesVal = parseFloat(document.getElementById('pm-samples-s')?.value || m.monthlySamples || 0);
  const listPrice = m.listPrice || 0;
  const promoPct = (m.promoPct || 0) / 100;
  const sel = listPrice * (1 - promoPct);
  const shipping = m.shippingPerUnit ?? 6;
  const affComm = sel * affCommPct;
  const tikTokFee = sel * 0.06;
  const adspend = sel * ((m.adspendPct||0)/100);
  const gpp = sel - shipping - cogsVal - affComm - tikTokFee - adspend;
  const sampleCost = (shipping + cogsVal) * samplesVal;
  const baseRevShare = pr.gmvPct != null ? pr.gmvPct / 100 : ((m.revSharePct||6.5) / 100);
  const teamFee = pr.retainer != null ? pr.retainer : (m.teamFee || 2500);
  const affRetainers = m.affiliateRetainers || 0;
  const videosPerCreator = m.videosPerCreator || 6;
  const avgViews = m.avgViews || 8000;
  const ctr = (m.ctrPct||3)/100;
  const cvr = (m.cvrPct||2)/100;
  const ACTIVATION_RATE = 0.65, AVG_ACTIVE_MONTHS = 6;
  const useSampleLogic = samplesVal > 0;
  const creators = useSampleLogic ? Math.round(samplesVal * ACTIVATION_RATE * AVG_ACTIVE_MONTHS) : (m.manualCreators || 150);
  const ramp = [0.1,0.2,0.3,0.45,0.55,0.65,0.75,0.82,0.88,0.93,0.97,1.0];
  const labels = ['M1','M2','M3','M4','M5','M6','M7','M8','M9','M10','M11','M12'];
  const gmvData = ramp.map(r => {
    const c = Math.round(creators * r);
    const imp = c * videosPerCreator * avgViews;
    const purch = Math.round(imp * ctr * cvr);
    return Math.round(purch * sel);
  });
  const netData = gmvData.map((gmv, i) => {
    const purch = gmv / (sel || 1);
    const gross = gpp * purch;
    const sc = i >= 6 ? sampleCost * 0.5 : sampleCost;
    return Math.round(gross - teamFee - (baseRevShare * gmv) - sc - affRetainers - gmv * 0.02);
  });
  _chartInst = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Monthly GMV', data: gmvData, backgroundColor: 'rgba(32,213,196,.25)', borderColor: '#20d5c4', borderWidth: 1, borderRadius: 3, yAxisID: 'y' },
      { label: 'Net Profit (after all costs)', data: netData, type: 'line', borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.06)', borderWidth: 2, pointRadius: 3, pointBackgroundColor: netData.map(v => v >= 0 ? '#10b981' : '#ef4444'), tension: .35, fill: true, yAxisID: 'y' },
      { label: 'Break-even', data: Array(12).fill(0), type: 'line', borderColor: '#f59e0b', borderWidth: 1, borderDash: [5,3], pointRadius: 0, yAxisID: 'y' },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#64748b', font: { size: 11 }, boxWidth: 12 } },
        tooltip: { callbacks: { label: ctx => { const v = ctx.raw; return ' ' + ctx.dataset.label + ': ' + (v<0?'(':'') + '$' + Math.abs(v).toLocaleString() + (v<0?')':''); } } }
      },
      scales: {
        x: { grid: { color: '#1a1830' }, ticks: { color: '#64748b', font: { size: 10 } } },
        y: { grid: { color: '#1a1830' }, ticks: { color: '#64748b', font: { size: 10 }, callback: v => (v<0?'(':'') + '$' + (Math.abs(v)>=1000?(Math.abs(v)/1000).toFixed(0)+'k':Math.abs(v)) + (v<0?')':'') } }
      },
    },
  });
}
function updateProjChart() {
  const ac = document.getElementById('pm-affcomm-s');
  const cc = document.getElementById('pm-cogs-s');
  const sc = document.getElementById('pm-samples-s');
  if (ac) document.getElementById('pm-affcomm-s-val').textContent = ac.value + '%';
  if (cc) document.getElementById('pm-cogs-s-val').textContent = '$' + cc.value;
  if (sc) document.getElementById('pm-samples-s-val').textContent = sc.value;
  _renderChart(_p);
}
function updatePricingSlider() {
  const slider = document.getElementById('pm-pricing-slider');
  if (!slider) return;
  const retainer = parseInt(slider.value);
  const t = (retainer - 1500) / (5000 - 1500);
  const gmvPct = (10 - t * 7).toFixed(1);
  const retEl = document.getElementById('pm-pricing-ret-val');
  const gmvEl = document.getElementById('pm-pricing-gmv-val');
  if (retEl) retEl.textContent = '$' + retainer.toLocaleString() + '/mo';
  if (gmvEl) gmvEl.textContent = gmvPct + '%';
}
document.addEventListener('DOMContentLoaded', () => _renderChart(_p));
`;
}

/**
 * Full standalone HTML document — same one used for the live iframe
 * preview and for POST /api/proposals/publish's payload, so preview and
 * published page are always identical by construction.
 */
export function buildStandaloneProposalDocument(p: GeneratedProposal, metricsInput: MetricsInput, brandLogoUrl: string | null): string {
  const metrics = computeMetrics(metricsInput);
  const bodyHtml = buildProposalBodyHtml(p, metrics, brandLogoUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${esc(p.brandName)} × Cult Content</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
${PROPOSAL_CSS}
body{background:#050e0f;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;margin:0;}
</style>
</head>
<body>
<div class="pm-body">${bodyHtml}</div>
<script>${chartScript(p, metricsInput)}</script>
</body>
</html>`;
}
