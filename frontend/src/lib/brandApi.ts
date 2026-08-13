/**
 * lib/brandApi.ts — typed client for routes/brand-portal.js (profile +
 * creator marketplace, Phase 7) plus the pre-existing brand-facing routes
 * this portal reuses as-is: routes/content-studio-gen.js (Seedance),
 * dashboard-server.js's /api/client/billing*, /api/client/buffer/*, and
 * /api/client/products. Every shape below was read directly off those route
 * handlers, not guessed.
 */
import { req } from './http';
import type { Contract } from './proposalsApi';

export interface Profile {
  id: string;
  email: string | null;
  handle: string | null;
  name: string | null;
  discordUsername: string | null;
  smsOptIn: boolean;
}

export interface CreatorSummary {
  id: string;
  handle: string | null;
  name: string | null;
}

export interface BrandCreators {
  currentAffiliates: { creator: CreatorSummary; contract: Contract }[];
  exploreCreators: { creator: CreatorSummary }[];
  previousCreators: { creator: CreatorSummary; contractCount: number }[];
}

export const getBrandProfile = () => req<{ profile: Profile }>('/api/brand/profile');
export const updateBrandProfile = (patch: { discordUsername?: string; smsOptIn?: boolean }) =>
  req('/api/brand/profile', { method: 'PATCH', body: JSON.stringify(patch) });

export const getBrandCreators = () => req<BrandCreators>('/api/brand/creators');

// ── Content Studio (Seedance) — routes/content-studio-gen.js ────────────────
export interface Credits {
  balance_cents: number;
  balance_display: string;
  charge_per_generation_cents: number;
  generation_live: boolean;
}

export interface Generation {
  id: number;
  client_id: string;
  product_id: string | null;
  seedance_job_id: string | null;
  status: 'pending' | 'processing' | 'succeeded' | 'failed';
  video_url: string | null;
  cost_cents: number;
  charge_cents: number;
  created_at: string;
}

export interface Reference {
  id: number;
  client_id: string;
  product_id: string | null;
  file_url: string;
  created_at: string;
}

export const getCredits = () => req<Credits>('/api/client/content/credits');
export const getGenerations = () => req<{ generations: Generation[] }>('/api/client/content/generations');
export const getGeneration = (id: number) => req<{ generation: Generation; poll_error?: string }>(`/api/client/content/generate/${id}`);

export const startGeneration = (body: { product_id?: string | null; prompt: string; reference_url?: string | null }) =>
  req<{ generation_id: number; status: string; billed_cents: number; message?: string; seedance_job_id?: string; new_balance_cents?: number }>(
    '/api/client/content/generate',
    { method: 'POST', body: JSON.stringify(body) },
  );

export const getReferences = (productId?: string) =>
  req<{ references: Reference[] }>(`/api/client/content/references${productId ? `?productId=${encodeURIComponent(productId)}` : ''}`);

export async function uploadReference(productId: string, file: File): Promise<{ reference: Reference; references: Reference[] }> {
  const formData = new FormData();
  formData.append('reference', file);
  formData.append('productId', productId);
  const res = await fetch('/api/client/content/references', { method: 'POST', credentials: 'include', body: formData });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

// ── Buffer posting (shared: generated-video schedule + generic post) ────────
export interface BufferChannel {
  id: string;
  name: string;
  service: string;
  serviceId: string;
  avatarUrl: string | null;
}

export const getBufferChannels = () => req<{ channels: BufferChannel[] }>('/api/client/buffer/channels');

export const scheduleGenerationToBuffer = (body: { generationId: number; channelIds: string[]; text?: string; scheduledAt?: string }) =>
  req<{ updates: { channelId: string; ok?: boolean; postId?: string; error?: string }[] }>(
    '/api/client/content/buffer/schedule',
    { method: 'POST', body: JSON.stringify(body) },
  );

// ── Products (TikTok Shop catalog) ───────────────────────────────────────────
export interface Product {
  id: string;
  name: string;
  images: string[];
}

export const getProducts = () => req<{ products: Product[]; error?: string }>('/api/client/products');

// ── Billing (Stripe) ─────────────────────────────────────────────────────────
export interface BillingTier {
  retainer: number;
  commRate: number;
  label?: string;
}

export interface Invoice {
  id: string;
  date: string;
  amount: number;
  status: string;
  url: string | null;
  period: string;
}

export interface BillingInfo {
  currentTier: { retainer: number; commRate: number };
  pendingTier: (BillingTier & { requestedAt: number; effectiveDate: string; effectiveLabel: string }) | null;
  gmv: number;
  revShare: number;
  tiers: BillingTier[];
  cycle: { period: string; nextBillingLabel: string; daysUntilBilling: number };
  hasPaymentMethod: boolean;
  invoices: Invoice[];
}

export const getBilling = () => req<BillingInfo>('/api/client/billing');
export const getBillingPortalUrl = () => req<{ url: string }>('/api/client/billing/portal');
export const changeBillingTier = (retainer: number, commRate: number) =>
  req<{ effectiveLabel: string; tier: BillingTier }>('/api/client/billing/change-tier', {
    method: 'POST',
    body: JSON.stringify({ retainer, commRate }),
  });

export const logoutBrand = () => req('/client/logout', { method: 'POST' });

// ── Support tickets — routes/support-tickets.js's client-side pair ──────────
export interface SupportTicket {
  id: number;
  type: string;
  message: string;
  status: string;
  created_at: string;
}

export const submitSupportTicket = (type: string, message: string) =>
  req('/api/client/support/submit', { method: 'POST', body: JSON.stringify({ type, message }) });

export const getMyTickets = () => req<{ tickets: SupportTicket[] }>('/api/client/support/my-tickets');
