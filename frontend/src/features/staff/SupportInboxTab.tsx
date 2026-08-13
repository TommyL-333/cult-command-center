import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/features/shared/EmptyState';
import { getAllTickets, setTicketStatus, type SupportTicket } from '@/lib/staffApi';

const statusVariant: Record<SupportTicket['status'], 'default' | 'secondary' | 'destructive'> = {
  unopened: 'secondary',
  opened: 'default',
  flagged: 'destructive',
};

function submitterLabel(t: SupportTicket) {
  if (t.submitterType === 'client') return t.brandName || t.brandId || 'Unknown brand';
  return t.creatorName || t.creatorHandle || (t.creatorId != null ? `Creator #${t.creatorId}` : 'Unknown creator');
}

function TicketRow({ ticket }: { ticket: SupportTicket }) {
  const queryClient = useQueryClient();

  async function setStatus(status: SupportTicket['status']) {
    await setTicketStatus(ticket.id, status);
    queryClient.invalidateQueries({ queryKey: ['staff', 'tickets'] });
  }

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant={statusVariant[ticket.status]} className="capitalize">{ticket.status}</Badge>
          <Badge variant="outline" className="capitalize">{ticket.type}</Badge>
          <span className="font-medium">{submitterLabel(ticket)}</span>
          <span className="text-xs text-muted-foreground">({ticket.submitterType})</span>
        </div>
        <span className="text-xs text-muted-foreground">{new Date(ticket.createdAt).toLocaleString()}</span>
      </div>
      <p className="mt-2 text-muted-foreground">{ticket.message}</p>
      {ticket.openedByName && (
        <p className="mt-1 text-xs text-muted-foreground">Opened by {ticket.openedByName} · {ticket.openedAt ? new Date(ticket.openedAt).toLocaleString() : ''}</p>
      )}
      <div className="mt-2 flex gap-2">
        {ticket.status !== 'opened' && <Button size="sm" variant="outline" onClick={() => setStatus('opened')}>Mark Opened</Button>}
        {ticket.status !== 'flagged' && <Button size="sm" variant="outline" onClick={() => setStatus('flagged')}>Flag</Button>}
        {ticket.status !== 'unopened' && <Button size="sm" variant="outline" onClick={() => setStatus('unopened')}>Reset</Button>}
      </div>
    </div>
  );
}

/**
 * Staff support ticket inbox — reuses routes/support-tickets.js's existing,
 * already-correct employee endpoints (GET /api/support-tickets/list,
 * POST /api/support-tickets/:id/status) as-is; every ticket across both
 * client and creator submitters, per its own doc comment.
 */
export function SupportInboxTab() {
  const ticketsQuery = useQuery({ queryKey: ['staff', 'tickets'], queryFn: getAllTickets });

  if (ticketsQuery.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (ticketsQuery.isError) return <EmptyState title="Couldn't load tickets" description="Try refreshing the page." />;

  const tickets = ticketsQuery.data!.tickets;
  if (tickets.length === 0) return <EmptyState title="No support tickets" description="Nothing submitted yet." />;

  const sorted = [...tickets].sort((a, b) => {
    const order = { unopened: 0, flagged: 1, opened: 2 };
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        {sorted.map((t) => <TicketRow key={t.id} ticket={t} />)}
      </CardContent>
    </Card>
  );
}
