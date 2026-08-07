import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Identity } from '@/lib/api';

// Placeholder — Phase 6 builds this out (creator marketplace tabs, Content
// Generation tab, billing profile).
export function BrandApp({ identity }: { identity: Extract<Identity, { type: 'brand' }> }) {
  return (
    <div className="p-8">
      <Card>
        <CardHeader>
          <CardTitle>Brand Portal</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Signed in as {identity.name || identity.email || `brand #${identity.id}`}. Full portal build is Phase 6.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
