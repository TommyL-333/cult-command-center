import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Identity } from '@/lib/api';

// Placeholder — Phase 7 builds this out (task point-scoring, My Clients,
// support inbox, CRM/sales tooling rebuilt here, staff Financial Dashboard).
export function StaffApp({ identity }: { identity: Extract<Identity, { type: 'staff' }> }) {
  return (
    <div className="p-8">
      <Card>
        <CardHeader>
          <CardTitle>Employee / Ops Portal</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Signed in as {identity.name || identity.email || `staff #${identity.id}`}. Full portal build is Phase 7.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
