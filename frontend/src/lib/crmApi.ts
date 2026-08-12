/**
 * lib/crmApi.ts — typed client for the Growth Partners CRM pipeline
 * (Phase 8 CRM port, first increment: Pipeline board + Add Prospect).
 * Every endpoint here already exists in dashboard-server.js (GHL-backed)
 * and already sits behind the app-wide `app.use(requireAuth)` wall — none
 * of this is new backend, just a typed wrapper + a React port of what
 * dashboard/segments.html's Growth Partners tab already does.
 *
 * The AI proposal/contract/invoice wizard (Fireflies -> AI extraction ->
 * economics -> GHL contract/invoice send) is a separate, larger follow-up
 * increment — its endpoints aren't wrapped here yet.
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
