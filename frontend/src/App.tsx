import { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router';
import { useMe } from '@/hooks/useMe';

// Lazy-loaded per portal (Phase 4's stated intent, actually wired up now
// that CreatorApp is a real screen, not a stub — a brand or staff user
// should never download the creator bundle and vice versa).
const CreatorApp = lazy(() => import('@/features/creator/CreatorApp').then((m) => ({ default: m.CreatorApp })));
const BrandApp = lazy(() => import('@/features/brand/BrandApp').then((m) => ({ default: m.BrandApp })));
const StaffApp = lazy(() => import('@/features/staff/StaffApp').then((m) => ({ default: m.StaffApp })));

/**
 * Root shell — single Vite-built React app serving all three portals under
 * one deploy, route-gated by GET /api/me rather than three separate apps
 * (see the plan's frontend architecture decision). `/app/*` is the base
 * path (see vite.config.ts + the Express static mount in dashboard-server.js).
 */
function Gate() {
  const { data: identity, isPending, isError } = useMe();
  const location = useLocation();

  if (isPending) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  if (isError || !identity || identity.type === null) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        Not signed in. (Portal-specific login pages are unchanged for now — see
        /client, /portal-admin, /inner-circle — this shell only takes over once
        a session already exists.)
      </div>
    );
  }

  const targetPrefix = `/${identity.type}`;
  if (!location.pathname.startsWith(targetPrefix)) {
    return <Navigate to={targetPrefix} replace />;
  }

  const fallback = <div className="p-8 text-sm text-muted-foreground">Loading…</div>;

  switch (identity.type) {
    case 'creator':
      return <Suspense fallback={fallback}><CreatorApp identity={identity} /></Suspense>;
    case 'brand':
      return <Suspense fallback={fallback}><BrandApp identity={identity} /></Suspense>;
    case 'staff':
      return <Suspense fallback={fallback}><StaffApp identity={identity} /></Suspense>;
  }
}

export default function App() {
  return (
    <BrowserRouter basename="/app">
      <Routes>
        <Route path="/*" element={<Gate />} />
      </Routes>
    </BrowserRouter>
  );
}
