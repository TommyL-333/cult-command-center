import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Identity } from '@/lib/api';

// Placeholder — Phase 5 builds this out (stats header, support widget, the
// three-tab brands section, profile, Discord/SMS opt-ins, financial tab).
export function CreatorApp({ identity }: { identity: Extract<Identity, { type: 'creator' }> }) {
  return (
    <div className="p-8">
      <Card>
        <CardHeader>
          <CardTitle>Creator Portal</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Signed in as {identity.name || identity.email || `creator #${identity.id}`}. Full portal build is Phase 5.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
