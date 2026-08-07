/**
 * lib/api.ts — thin fetch wrapper for the existing Express backend.
 * Same-origin, cookie-based auth (see middleware/auth.js) — no token
 * management needed here, `credentials: 'include'` is enough.
 */

// A proper discriminated union (one variant per literal `type`, not one
// variant with a union'd `type` field) so `Extract<Identity, { type: 'x' }>`
// narrows correctly in the portal components.
export type Identity =
  | { type: 'creator'; id: string | number | null; email: string | null; name: string | null }
  | { type: 'brand'; id: string | number | null; email: string | null; name: string | null }
  | { type: 'staff'; id: string | number | null; email: string | null; name: string | null }
  | { type: null };

export async function getMe(): Promise<Identity> {
  const res = await fetch('/api/me', { credentials: 'include' });
  if (res.status === 401) return { type: null };
  if (!res.ok) throw new Error(`GET /api/me failed: ${res.status}`);
  return res.json();
}
