/**
 * lib/creatorApi.ts — typed client for routes/creator-portal.js +
 * routes/proposals.js + routes/support-tickets.js (creator-facing paths).
 * Same-origin, cookie-based auth — see lib/api.ts.
 */

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || `${path} failed (${res.status})`);
  }
  return body;
}

export interface Profile {
  id: number;
  email: string;
  handle: string;
  name: string;
  discordUsername: string | null;
  smsOptIn: boolean;
}

export interface BrandSummary {
  id: string;
  name: string | null;
  website: string | null;
  tiktokHandle: string | null;
}

export interface Contract {
  id: number;
  creator_id: string;
  brand_id: string;
  proposal_id: number;
  terms_json: string;
  started_at: string;
  ended_at: string | null;
}

export interface CreatorBrands {
  myBrands: { brand: BrandSummary; contract: Contract }[];
  newBrands: { brand: BrandSummary }[];
  previousBrands: { brand: BrandSummary; contractCount: number }[];
}

export interface FinancialSummary {
  rate: { per_video_cents: number | null; retainer_monthly_cents: number | null; package_label: string | null } | null;
  retainerAgreements: { id: number; brand_id: string; amount_cents: number; videos_committed: number; videos_delivered: number; status: string }[];
  retainerOffers: { id: number; brand_name: string; offer_type: string; amount_cents: number; status: string }[];
}

export interface SupportTicket {
  id: number;
  type: string;
  message: string;
  status: string;
  created_at: string;
}

export const getProfile = () => req<{ profile: Profile }>('/api/creator/profile');
export const updateProfile = (patch: { discordUsername?: string; smsOptIn?: boolean }) =>
  req('/api/creator/profile', { method: 'PATCH', body: JSON.stringify(patch) });

export const getCreatorBrands = () => req<CreatorBrands>('/api/creator/brands');
export const getFinancialSummary = () => req<FinancialSummary>('/api/creator/financial-summary');

export const sendProposal = (counterpartyId: string, terms: Record<string, unknown>, message?: string) =>
  req<{ proposal: { id: number } }>('/api/proposals', { method: 'POST', body: JSON.stringify({ counterpartyId, terms, message }) });

export const getContractHistory = (creatorId: string | number, brandId: string) =>
  req<{ contracts: Contract[] }>(`/api/contracts/pair?creatorId=${encodeURIComponent(String(creatorId))}&brandId=${encodeURIComponent(brandId)}`);

export const submitSupportTicket = (type: string, message: string) =>
  req('/api/inner-circle/support/submit', { method: 'POST', body: JSON.stringify({ type, message }) });

export const getMyTickets = () => req<{ tickets: SupportTicket[] }>('/api/inner-circle/support/my-tickets');
