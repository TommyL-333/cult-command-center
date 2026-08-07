import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router';
import { useMe } from '@/hooks/useMe';
import { CreatorApp } from '@/features/creator/CreatorApp';
import { BrandApp } from '@/features/brand/BrandApp';
import { StaffApp } from '@/features/staff/StaffApp';

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

  switch (identity.type) {
    case 'creator':
      return <CreatorApp identity={identity} />;
    case 'brand':
      return <BrandApp identity={identity} />;
    case 'staff':
      return <StaffApp identity={identity} />;
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
