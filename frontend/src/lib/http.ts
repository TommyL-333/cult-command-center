/**
 * lib/http.ts — the one fetch wrapper every portal-specific API client
 * builds on. Same-origin, cookie-based auth (see middleware/auth.js) —
 * credentials: 'include' is all that's needed, no token management.
 */
export async function req<T>(path: string, init?: RequestInit): Promise<T> {
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
