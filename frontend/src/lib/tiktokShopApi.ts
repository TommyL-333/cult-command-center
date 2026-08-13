/**
 * lib/tiktokShopApi.ts — typed client for the TikTok Shop Partner Center
 * reconciliation endpoint (GET /api/tiktokshop/shops). The endpoint itself
 * already existed but was never called from any frontend; this session
 * enhanced it to cross-reference against brand records and degrade
 * honestly when the Partner Center connection hasn't been authorized yet.
 */
import { req } from './http';

export interface PartnerCenterShop {
  shopId: string | null;
  name: string | null;
  region: string | null;
  matchedBrandId: string | null;
  matchedBrandName: string | null;
}

export interface ShopReconciliation {
  ok: boolean;
  configured: boolean;
  message?: string;
  authUrl?: string;
  shops?: PartnerCenterShop[];
  unmatchedCount?: number;
}

export const getPartnerCenterShops = () => req<ShopReconciliation>('/api/tiktokshop/shops');
