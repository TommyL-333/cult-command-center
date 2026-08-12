/**
 * lib/crmApi.ts — typed client for the Growth Partners CRM (pipeline,
 * Fireflies meeting picker, AI proposal extraction/generation, GHL
 * contract + invoice sending, public proposal publishing). Every endpoint
 * here already exists in dashboard-server.js (GHL/Fireflies/Claude-backed)
 * and already sits behind the app-wide `app.use(requireAuth)` wall — none
 * of this is new backend, just a typed wrapper + a React port of what
 * dashboard/segments.html's Growth Partners tab already does.
 *
 * Still not wrapped here: the Shopify Prospector (scrape + add) — deferred
 * alongside the rest of the still-incomplete segments.html port.
 */
import { req } from './http';

export interface Contact {
  id: string;
  name: string;
  email: string;
}

export interface Opportunity {
  id: string;
  name: string;
  stageName: string;
  contact: Contact;
  monetaryValue?: number;
  [key: string]: unknown; // raw GHL opportunity fields pass through untouched
}

export interface PipelineStage {
  name: string;
  stageId: string;
  opportunities: Opportunity[];
}

export interface PipelineData {
  total: number;
  byStage: PipelineStage[];
  opportunities: Opportunity[];
}

export const getPipeline = (segment: string) => req<PipelineData>(`/api/pipeline/${segment}`);

export const updateOpportunityStage = (segment: string, oppId: string, stageId: string) =>
  req(`/api/pipeline/${segment}/${oppId}/stage`, { method: 'PUT', body: JSON.stringify({ stageId }) });

export const addGrowthPartnerProspect = (body: { name: string; email?: string; company?: string }) =>
  req<{ contactId: string; oppId: string }>('/api/growth-partners/add-prospect', { method: 'POST', body: JSON.stringify(body) });

// ── Fireflies meeting picker ─────────────────────────────────────────────────
export interface FirefliesMeeting {
  id: string;
  title: string;
  date: number | string;
  participants: string[];
  summary?: { short_summary?: string; action_items?: string };
  _idx: number;
}

export const getFirefliesMeetings = () =>
  req<{ connected: boolean; meetings?: FirefliesMeeting[]; accountCount?: number; error?: string }>('/api/fireflies/meetings');

export const getFirefliesTranscript = (id: string) =>
  req<{ id: string; title: string; date: string; participants: string[]; summary?: { short_summary?: string; action_items?: string }; transcript: string; error?: string }>(`/api/fireflies/transcript/${id}`);

export const syncFirefliesMeetings = (days = 365) =>
  req<{ added: number }>('/api/meetings/sync-fireflies', { method: 'POST', body: JSON.stringify({ days }) });

// ── AI proposal generation (2-step) ──────────────────────────────────────────
export interface ExtractedMetrics {
  brandName: string;
  heroProduct: string;
  metrics: {
    listPrice: number | null; promoPct: number | null; shippingPerUnit: number | null; cogsPerUnit: number | null;
    affiliateCommPct: number | null; avgViews: number | null; monthlySamples: number | null; affiliateRetainers: number | null;
  };
  sources: Record<string, 'shopify' | 'transcript' | 'ai' | 'missing'>;
  shopifyData: { domain: string; products: { title: string; typicalPrice: number; compareAtPrice: number | null }[] } | null;
  error?: string;
}

export const extractProposalMetrics = (context: string) =>
  req<ExtractedMetrics>('/api/ai/extract-metrics', { method: 'POST', body: JSON.stringify({ context }) });

export interface GeneratedProposal {
  brandName: string;
  tagline: string;
  strategicQuestion: string;
  currentStateMetrics: { label: string; value: string }[];
  financialBreakdown: Record<string, unknown>;
  roadmap: { month1Bullets?: string[]; months12Bullets?: string[]; month3plusBullets?: string[] };
  nextSteps: string[];
  profitabilityFix: { isUnprofitable?: boolean; primaryIssue?: string; bundleIdea?: string; strategySteps?: string[] };
  projections: Record<string, unknown>;
  pricing: { retainer: number; gmvPct: number; breakEvenGMV: number };
}

export const generateProposal = (body: {
  context: string; retainer: string; gmv: string;
  confirmedMetrics: {
    listPrice: number | null; promoPct: number; shippingPerUnit: number; cogsPerUnit: number | null;
    affiliateCommPct: number; monthlySamples: number; affiliateRetainers: number; avgViews: number | null;
  };
}) => req<{ proposal: GeneratedProposal; shopifyData: unknown; error?: string }>('/api/ai/propose', { method: 'POST', body: JSON.stringify(body) });

// ── GHL contracts + invoices ──────────────────────────────────────────────────
export interface ContractTemplate { id: string; name: string; published: boolean; }

export const getContractTemplates = () => req<{ templates: ContractTemplate[] }>('/api/ghl/contract-templates');

export const sendContract = (templateId: string, contactId: string) =>
  req('/api/ghl/send-contract', { method: 'POST', body: JSON.stringify({ templateId, contactId }) });

export const sendRetainerInvoice = (body: { contactId: string; retainerAmount: string; contactName?: string; contactEmail?: string }) =>
  req<{ invoiceId: string; amount: number }>('/api/ghl/send-retainer-invoice', { method: 'POST', body: JSON.stringify(body) });

export const sendGmvInvoice = (body: { contactId: string; contactName?: string; contactEmail?: string; gmvAmount: string; gmvPercent: string; month: string }) =>
  req<{ invoiceId: string; gmv: number; pct: number; fee: number }>('/api/ghl/send-gmv-invoice', { method: 'POST', body: JSON.stringify(body) });

// ── Publish a proposal as a public shareable page ────────────────────────────
export const publishProposal = (html: string) =>
  req<{ url: string; error?: string }>('/api/proposals/publish', { method: 'POST', body: JSON.stringify({ html }) });
