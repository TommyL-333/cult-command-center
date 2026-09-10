import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/features/shared/EmptyState';
import {
  getAllTickets, setTicketStatus, getTicketReplies, replyToTicket, type SupportTicket,
} from '@/lib/staffApi';

const statusVariant: Record<SupportTicket['status'], 'default' | 'secondary' | 'destructive'> = {
  unopened: 'secondary',
  opened: 'default',
  flagged: 'destructive',
};

// Discord tickets lead with the channel they came from, not who sent them —
// that's the whole point of this source: staff see what it's about at a
// glance instead of digging through which of many channels it landed in.
function submitterLabel(t: SupportTicket) {
  if (t.submitterType === 'client') return t.brandName || t.brandId || 'Unknown brand';
  if (t.submitterType === 'discord') return `#${t.discordChannelName || 'unknown-channel'}`;
  return t.creatorName || t.creatorHandle || (t.creatorId != null ? `Creator #${t.creatorId}` : 'Unknown creator');
}

function ReplyPanel({ ticket }: { ticket: SupportTicket }) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const repliesQuery = useQuery({
    queryKey: ['staff', 'ticket-replies', ticket.id],
    queryFn: () => getTicketReplies(ticket.id),
  });

  async function send() {
    const text = body.trim();
    if (!text) return;
    setError(null);
    try {
      const res = await replyToTicket(ticket.id, text);
      if (res.deliveryError) setError(res.deliveryError);
      setBody('');
      queryClient.invalidateQueries({ queryKey: ['staff', 'ticket-replies', ticket.id] });
    } catch {
      setError('Could not send reply — please try again.');
    }
  }

  return (
    <div className="mt-3 space-y-2 border-l-2 pl-3">
      {repliesQuery.data?.replies.map((r) => (
        <p key={r.id} className="text-sm">
          <span className="font-medium">{r.authorName}:</span> {r.body}
          {!r.delivered && <span className="ml-2 text-xs text-destructive">(not delivered to Discord)</span>}
        </p>
      ))}
      <div className="flex gap-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={`Reply — posts into the Discord thread and pings ${ticket.discordAuthorTag ? '@' + ticket.discordAuthorTag : 'the asker'}`}
          className="min-h-[2.25rem] text-sm"
        />
        <Button size="sm" onClick={send}>Send</Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function TicketRow({ ticket }: { ticket: SupportTicket }) {
  const [replying, setReplying] = useState(false);
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
          {ticket.submitterType === 'discord' && ticket.discordAuthorTag && (
            <span className="text-xs text-muted-foreground">— @{ticket.discordAuthorTag}</span>
          )}
          <span className="text-xs text-muted-foreground">({ticket.submitterType})</span>
        </div>
        <span className="text-xs text-muted-foreground">{new Date(ticket.createdAt).toLocaleString()}</span>
      </div>
      <p className="mt-2 text-muted-foreground">
        {ticket.message}
        {ticket.discordMessageUrl && (
          <a
            href={ticket.discordMessageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-2 inline-flex items-center gap-1 text-xs text-primary underline"
          >
            open in Discord <ExternalLink className="size-3" />
          </a>
        )}
      </p>
      {ticket.openedByName && (
        <p className="mt-1 text-xs text-muted-foreground">Opened by {ticket.openedByName} · {ticket.openedAt ? new Date(ticket.openedAt).toLocaleString() : ''}</p>
      )}
      <div className="mt-2 flex gap-2">
        {ticket.status !== 'opened' && <Button size="sm" variant="outline" onClick={() => setStatus('opened')}>Mark Opened</Button>}
        {ticket.status !== 'flagged' && <Button size="sm" variant="outline" onClick={() => setStatus('flagged')}>Flag</Button>}
        {ticket.status !== 'unopened' && <Button size="sm" variant="outline" onClick={() => setStatus('unopened')}>Reset</Button>}
        {ticket.submitterType === 'discord' && (
          <Button size="sm" variant="outline" onClick={() => setReplying((v) => !v)}>
            {replying ? 'Hide reply' : 'Reply'}
          </Button>
        )}
      </div>
      {replying && <ReplyPanel ticket={ticket} />}
    </div>
  );
}

/**
 * Staff support ticket inbox — reuses routes/support-tickets.js's existing,
 * already-correct employee endpoints (GET /api/support-tickets/list,
 * POST /api/support-tickets/:id/status) as-is; every ticket across client,
 * creator, AND discord submitters, per its own doc comment. Discord tickets
 * additionally get a Reply action (routes/support-tickets.js's :id/reply)
 * that posts back into the originating thread.
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
