/**
 * lib/payoutsApi.ts — creator-facing client for routes/creator-payouts.js
 * (Phase 9: Stripe Connect). Shapes read directly off the route handlers.
 */
import { req } from './http';

export interface ConnectAccount {
  onboardingStatus: 'pending' | 'complete' | 'restricted';
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

export interface Payout {
  id: number;
  creator_id: number;
  stripe_transfer_id: string | null;
  amount_cents: number;
  currency: string;
  status: 'pending' | 'paid' | 'failed' | 'reversed';
  description: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
}

export const getPayoutAccountStatus = () => req<{ account: ConnectAccount | null }>('/api/creator/payouts/status');
export const startPayoutOnboarding = () => req<{ url: string }>('/api/creator/payouts/onboard', { method: 'POST' });
export const getPayoutHistory = () => req<{ payouts: Payout[] }>('/api/creator/payouts/history');
