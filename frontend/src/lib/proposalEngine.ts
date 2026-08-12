/**
 * lib/proposalEngine.ts — the AI Proposal Generator's financial model,
 * ported from dashboard/segments.html's getMetrics() + the monthCalc/
 * waterfall/break-even/profitability-fix math embedded in buildProposalHTML().
 * Refactored from DOM-reads into pure functions over a typed input — same
 * formulas, same constants (ACTIVATION_RATE, AVG_ACTIVE_MONTHS, the 6%
 * TikTok fee, 2% returns rate), not redesigned.
 */

export interface MetricsInput {
  listPrice: number;
  promoPct: number; // whole number, e.g. 15 = 15%
  shippingPerUnit: number | null; // null -> defaults to 6, matching the original's `?? 6`
  cogsPerUnit: number;
  affiliateCommPct: number; // whole number
  adspendPct: number; // whole number, default 0
  monthlySamples: number;
  manualCreators: number; // rarely set; 0 = use sample-derived count
  videosPerCreator: number;
  avgViews: number;
  ctrPct: number; // whole number
  cvrPct: number; // whole number
  affiliateRetainers: number;
  costPerVideo: number;
  teamFee: number; // monthly retainer $
  revSharePct: number; // whole number, e.g. 6.5
}

export interface Metrics {
  listPrice: number; promoPct: number; sellingPrice: number; shipping: number; cogs: number;
  affCommPct: number; adspendPct: number; tikTokFeePct: number;
  creators: number; videosPerCreator: number; avgViews: number; ctr: number; cvr: number;
  monthlySamples: number; sampleDerivedCreators: number; affiliateRetainers: number; costPerVideo: number;
  retainerVideos: number; totalVideos: number; teamFee: number; revSharePct: number;
  affComm: number; tikTokFee: number; adspend: number; totalCostPerOrder: number;
  grossProfitPerOrder: number; grossMarginPct: number;
  impressions: number; purchases: number; monthlyGMV: number; grossMonthlyProfit: number;
  teamCost: number; sampleCost: number; returns: number; netMonthlyProfit: number;
  fixedCosts: number; netMarginRate: number; breakEvenGMV: number | null;
  minViablePrice: number | null; targetAOV: number | null; targetGrossProfitPerOrder: number | null;
  isUnprofitable: boolean;
}

const ACTIVATION_RATE = 0.65;
const AVG_ACTIVE_MONTHS = 6;
const TIKTOK_FEE_PCT = 0.06;
const RETURNS_RATE = 0.02;

export function computeMetrics(input: MetricsInput): Metrics {
  const listPrice = input.listPrice || 0;
  const promoPct = input.promoPct / 100 || 0;
  const sellingPrice = listPrice * (1 - promoPct);
  const shipping = input.shippingPerUnit ?? 6;
  const cogs = input.cogsPerUnit || 10;
  const affCommPct = input.affiliateCommPct / 100 || 0.25;
  const adspendPct = input.adspendPct / 100 || 0;
  const tikTokFeePct = TIKTOK_FEE_PCT;

  const affComm = sellingPrice * affCommPct;
  const tikTokFee = sellingPrice * tikTokFeePct;
  const adspend = sellingPrice * adspendPct;
  const totalCostPerOrder = shipping + cogs + affComm + tikTokFee + adspend;
  const grossProfitPerOrder = sellingPrice - totalCostPerOrder;
  const grossMarginPct = sellingPrice > 0 ? grossProfitPerOrder / sellingPrice : 0;

  const monthlySamples = input.monthlySamples || 0;
  const sampleDerivedCreators = monthlySamples > 0 ? Math.round(monthlySamples * ACTIVATION_RATE * AVG_ACTIVE_MONTHS) : 0;
  const creators = input.manualCreators || sampleDerivedCreators || 150;

  const videosPerCreator = input.videosPerCreator || 4;
  const avgViews = input.avgViews || 2000;
  const ctr = input.ctrPct / 100 || 0.03;
  const cvr = input.cvrPct / 100 || 0.015;

  const affiliateRetainers = input.affiliateRetainers || 1000;
  const costPerVideo = input.costPerVideo || 75;
  const retainerVideos = costPerVideo > 0 ? Math.floor(affiliateRetainers / costPerVideo) : 0;
  const totalVideos = creators * videosPerCreator + retainerVideos;
  const impressions = totalVideos * avgViews;
  const purchases = Math.round(impressions * ctr * cvr);
  const monthlyGMV = purchases * sellingPrice;
  const grossMonthlyProfit = grossProfitPerOrder * purchases;

  const teamFee = input.teamFee || 2500;
  const revSharePct = (input.revSharePct || 6.5) / 100;
  const teamCost = teamFee + revSharePct * monthlyGMV;
  const sampleCost = (shipping + cogs) * monthlySamples;
  const returns = monthlyGMV * RETURNS_RATE;
  const netMonthlyProfit = grossMonthlyProfit - teamCost - sampleCost - affiliateRetainers - returns;

  const fixedCosts = teamFee + sampleCost + affiliateRetainers;
  const netMarginRate = grossMarginPct - revSharePct - RETURNS_RATE;
  const breakEvenGMV = netMarginRate > 0 ? fixedCosts / netMarginRate : null;

  const variableRateCosts = affCommPct + tikTokFeePct + adspendPct;
  const minViablePrice = variableRateCosts < 1 ? (cogs + shipping) / (1 - variableRateCosts) : null;
  const targetGrossMargin = 0.35;
  const targetAOV = variableRateCosts < 1 - targetGrossMargin
    ? (cogs + shipping) / (1 - variableRateCosts - targetGrossMargin)
    : null;
  const targetGrossProfitPerOrder = targetAOV ? targetAOV * targetGrossMargin : null;
  const isUnprofitable = grossMarginPct < 0.1;

  return {
    listPrice, promoPct, sellingPrice, shipping, cogs, affCommPct, adspendPct, tikTokFeePct,
    creators, videosPerCreator, avgViews, ctr, cvr,
    monthlySamples, sampleDerivedCreators, affiliateRetainers, costPerVideo, retainerVideos, totalVideos, teamFee, revSharePct,
    affComm, tikTokFee, adspend, totalCostPerOrder, grossProfitPerOrder, grossMarginPct,
    impressions, purchases, monthlyGMV, grossMonthlyProfit,
    teamCost, sampleCost, returns, netMonthlyProfit,
    fixedCosts, netMarginRate, breakEvenGMV,
    minViablePrice, targetAOV, targetGrossProfitPerOrder, isUnprofitable,
  };
}

export interface MonthPoint { mo: number; c: number; imp: number; purch: number; gmv: number; gross: number; teamC: number; net: number; }

/** Month-by-month ramp (6 months), same creator-accumulation logic as buildProposalHTML's monthCalc. */
export function computeMonthlyRamp(m: Metrics): MonthPoint[] {
  const useSampleLogic = m.monthlySamples > 0;
  const monthlyCreatorCount = (mo: number) => useSampleLogic
    ? Math.round(m.monthlySamples * ACTIVATION_RATE * Math.min(mo, AVG_ACTIVE_MONTHS))
    : Math.round(m.creators * (mo / AVG_ACTIVE_MONTHS));

  const monthCalc = (mo: number): MonthPoint => {
    const c = monthlyCreatorCount(mo);
    const imp = c * m.videosPerCreator * m.avgViews;
    const purch = Math.round(imp * m.ctr * m.cvr);
    const gmv = purch * m.sellingPrice;
    const gross = m.grossProfitPerOrder * purch;
    const teamC = m.teamFee + m.revSharePct * gmv;
    const net = gross - teamC - m.sampleCost - m.affiliateRetainers - gmv * RETURNS_RATE;
    return { mo, c, imp: Math.round(imp), purch, gmv, gross, teamC, net };
  };

  return Array.from({ length: 6 }, (_, i) => monthCalc(i + 1));
}

export interface WaterfallRow { label: string; val: number; pct: number; color: string; bold: boolean; }
export interface BreakEven {
  useSampleLogic: boolean;
  steadyStateSampleCost: number;
  steadyStateSamples: number;
  scaledNet: number;
  scaled: MonthPoint;
  beGMV: number | null;
  beCreators: number | null;
  beSamples: number | null;
  channelProfitable: boolean;
  waterfallRows: WaterfallRow[];
}

/** All-in cost waterfall + break-even at Month 6 run rate, matching buildProposalHTML exactly. */
export function computeBreakEven(m: Metrics, monthData: MonthPoint[]): BreakEven {
  const useSampleLogic = m.monthlySamples > 0;
  const steadyStateSampleCost = Math.round(m.sampleCost * 0.3);
  const steadyStateSamples = Math.round(m.monthlySamples * 0.3);
  const scaled = monthData[5];
  const scaledNet = scaled.gross - scaled.teamC - steadyStateSampleCost - m.affiliateRetainers - scaled.gmv * RETURNS_RATE;

  const flatNetMarginCalc = m.grossMarginPct - m.revSharePct - RETURNS_RATE;
  const beGMV = flatNetMarginCalc > 0
    ? Math.round((m.teamFee + steadyStateSampleCost + m.affiliateRetainers) / flatNetMarginCalc)
    : null;
  const beCreators = beGMV
    ? Math.ceil(beGMV / (m.sellingPrice * m.videosPerCreator * m.avgViews * m.ctr * m.cvr))
    : null;
  const beSamples = beCreators && useSampleLogic ? Math.ceil(beCreators / (ACTIVATION_RATE * 6)) : null;

  const waterfallRows: WaterfallRow[] = [
    { label: 'Gross Revenue (GMV)', val: scaled.gmv, pct: 1, color: '#e2e8f0', bold: true },
    { label: 'Gross Profit from Sales', val: scaled.gross, pct: scaled.gmv ? scaled.gross / scaled.gmv : 0, color: '#5eead4', bold: false },
    { label: '− Team Fee', val: -m.teamFee, pct: scaled.gmv ? -m.teamFee / scaled.gmv : 0, color: '#ef4444', bold: false },
    { label: `− GMV Rev Share (${(m.revSharePct * 100).toFixed(1)}%)`, val: -(m.revSharePct * scaled.gmv), pct: -m.revSharePct, color: '#ef4444', bold: false },
    { label: `− Sample Budget (~${steadyStateSamples} units/mo · maintenance)`, val: -steadyStateSampleCost, pct: scaled.gmv ? -steadyStateSampleCost / scaled.gmv : 0, color: '#f59e0b', bold: false },
    { label: '− Affiliate Retainers', val: -m.affiliateRetainers, pct: scaled.gmv ? -m.affiliateRetainers / scaled.gmv : 0, color: '#f59e0b', bold: false },
    { label: '− Returns & Refunds (2%)', val: -(scaled.gmv * RETURNS_RATE), pct: -RETURNS_RATE, color: '#64748b', bold: false },
    { label: 'Net Monthly Profit', val: scaledNet, pct: scaled.gmv ? scaledNet / scaled.gmv : 0, color: scaledNet >= 0 ? '#10b981' : '#ef4444', bold: true },
  ];

  return {
    useSampleLogic, steadyStateSampleCost, steadyStateSamples, scaledNet, scaled,
    beGMV, beCreators, beSamples, channelProfitable: scaledNet >= 0, waterfallRows,
  };
}
