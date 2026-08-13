/**
 * lib/creatorApi.ts — typed client for routes/creator-portal.js +
 * routes/support-tickets.js (creator-facing paths). Proposal/contract calls
 * live in lib/proposalsApi.ts (shared with the brand portal).
 */
import { req } from './http';
import type { Contract } from './proposalsApi';

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

export const submitSupportTicket = (type: string, message: string) =>
  req('/api/inner-circle/support/submit', { method: 'POST', body: JSON.stringify({ type, message }) });

export const getMyTickets = () => req<{ tickets: SupportTicket[] }>('/api/inner-circle/support/my-tickets');

export const logoutCreator = () => req('/api/inner-circle/logout', { method: 'POST' });
