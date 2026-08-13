/**
 * lib/staffApi.ts — typed client for routes/staff-portal.js (Phase 8, first
 * pass: My Clients, roster, points) plus the pre-existing staff-facing
 * support ticket endpoints (routes/support-tickets.js) this portal reuses
 * as-is. All shapes read directly off those route handlers.
 */
import { req } from './http';

export interface StaffProfile {
  id: string | null;
  email: string | null;
  name: string | null;
  role: string | null;
  permissions: string[];
}

export interface RosterEntry {
  id: string;
  name: string;
  email: string | null;
}

export interface BrandSummary {
  id: string;
  name: string | null;
  website: string | null;
  onboardingStatus: string | null;
}

export interface MyClient {
  brand: BrandSummary;
  role: string;
  assignedAt: string;
}

export interface AssignmentBoardEntry {
  brand: BrandSummary;
  staff: { staff_id: string; role: string; assigned_at: string }[];
}

export interface LeaderboardEntry {
  email: string;
  name: string;
  total: number;
  task_count: number;
  last_award_at: string;
}

export interface MyPoints {
  email: string;
  name: string;
  total: number;
  taskCount: number;
  recent: { id: number; task_record_id: string | null; task_title: string | null; points: number; awarded_at: string }[];
}

export const getStaffProfile = () => req<{ profile: StaffProfile }>('/api/staff/profile');
export const getRoster = () => req<{ roster: RosterEntry[] }>('/api/staff/roster');
export const getMyClients = () => req<{ clients: MyClient[] }>('/api/staff/my-clients');
export const getAssignmentBoard = () => req<{ brands: AssignmentBoardEntry[] }>('/api/staff/assignments');

export const assignBrand = (brandId: string, staffId: string, role: 'primary' | 'support' = 'primary') =>
  req('/api/staff/clients/assign', { method: 'POST', body: JSON.stringify({ brandId, staffId, role }) });

export const unassignBrand = (brandId: string, staffId: string) =>
  req('/api/staff/clients/unassign', { method: 'POST', body: JSON.stringify({ brandId, staffId }) });

export const getLeaderboard = () => req<{ leaderboard: LeaderboardEntry[] }>('/api/staff/points/leaderboard');
export const getMyPoints = () => req<MyPoints>('/api/staff/points/mine');

// ── Support Inbox — routes/support-tickets.js's employee-facing pair ────────
export interface SupportTicket {
  id: number;
  submitterType: 'client' | 'creator';
  brandId: string | null;
  brandName: string | null;
  creatorId: number | null;
  creatorName: string | null;
  creatorHandle: string | null;
  submitterEmail: string | null;
  type: string;
  message: string;
  status: 'unopened' | 'opened' | 'flagged';
  openedByEmail: string | null;
  openedByName: string | null;
  openedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const getAllTickets = () => req<{ tickets: SupportTicket[] }>('/api/support-tickets/list');
export const setTicketStatus = (id: number, status: SupportTicket['status']) =>
  req<{ ticket: SupportTicket }>(`/api/support-tickets/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });

export const logoutStaff = () => req('/portal-admin/logout', { method: 'POST' });
