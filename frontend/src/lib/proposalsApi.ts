/**
 * lib/proposalsApi.ts — client for routes/proposals.js (Phase 5). Shared
 * between the creator and brand portals since the underlying API doesn't
 * care which side is calling — req.identity.type (server-side) determines
 * everything.
 */
import { req } from './http';

export interface Contract {
  id: number;
  creator_id: string;
  brand_id: string;
  proposal_id: number;
  terms_json: string;
  started_at: string;
  ended_at: string | null;
}

export const sendProposal = (counterpartyId: string, terms: Record<string, unknown>, message?: string) =>
  req<{ proposal: { id: number } }>('/api/proposals', { method: 'POST', body: JSON.stringify({ counterpartyId, terms, message }) });

export const getContractHistory = (creatorId: string | number, brandId: string) =>
  req<{ contracts: Contract[] }>(`/api/contracts/pair?creatorId=${encodeURIComponent(String(creatorId))}&brandId=${encodeURIComponent(brandId)}`);
