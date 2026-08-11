import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Building2 } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/features/shared/EmptyState';
import { getMyClients } from '@/lib/staffApi';

/**
 * "My Clients" — brands assigned to the logged-in staff member, per spec.
 * db/brand-assignments.js existed with zero routes/UI using it before this
 * (Phase 8) — this is the first real consumer of that table.
 */
export function MyClientsTab() {
  const clientsQuery = useQuery({ queryKey: ['staff', 'my-clients'], queryFn: getMyClients });

  if (clientsQuery.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (clientsQuery.isError) return <EmptyState title="Couldn't load your clients" description="Try refreshing the page." />;

  const clients = clientsQuery.data!.clients;
  if (clients.length === 0) {
    return <EmptyState title="No clients assigned to you yet" description="Ask a team admin to assign one from Team Assignments." />;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {clients.map(({ brand, role, assignedAt }) => (
        <Card key={brand.id}>
          <CardHeader className="flex flex-row items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/20 to-accent/20">
              <Building2 className="size-4 text-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold leading-tight">{brand.name || brand.id}</p>
              <p className="text-xs text-muted-foreground">Assigned {new Date(assignedAt).toLocaleDateString()}</p>
            </div>
            <Badge variant={role === 'primary' ? 'default' : 'secondary'} className="capitalize shrink-0">{role}</Badge>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {brand.website ? (
              <a href={brand.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                <ExternalLink className="size-3" />Visit Website
              </a>
            ) : (
              <span className="text-xs text-muted-foreground">No website on file</span>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
