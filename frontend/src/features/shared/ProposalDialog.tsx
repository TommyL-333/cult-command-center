import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { sendProposal } from '@/lib/proposalsApi';

/**
 * Make/Send a Proposal — shared between the creator and brand portals
 * (POST /api/proposals doesn't care which side is calling; req.identity.type
 * determines everything server-side). The spec calls for picking "from
 * criteria" that auto-generates a proposal; the full criteria-builder is a
 * later, dedicated design pass — this ships the real, working backend call
 * (Phase 5) behind a minimal form (commission % + a message) so the button
 * genuinely works end-to-end now rather than being a non-functional stub.
 */
export function ProposalDialog({ counterpartyId, counterpartyName, trigger }: { counterpartyId: string; counterpartyName: string | null; trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [commissionPct, setCommissionPct] = useState('15');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');

  async function submit() {
    setStatus('sending');
    setError('');
    try {
      await sendProposal(counterpartyId, { commissionPct: Number(commissionPct) || 0 }, message.trim() || undefined);
      setStatus('sent');
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Failed to send proposal');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setStatus('idle'); setMessage(''); } }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a proposal to {counterpartyName || counterpartyId}</DialogTitle>
        </DialogHeader>
        {status === 'sent' ? (
          <p className="text-sm text-muted-foreground">Proposal sent. You'll see their response in Messages.</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="commission">Commission %</Label>
              <Input id="commission" type="number" min={0} max={100} value={commissionPct} onChange={(e) => setCommissionPct(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="proposal-message">Message (optional)</Label>
              <Textarea id="proposal-message" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Would love to work together!" />
            </div>
            {status === 'error' && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}
        <DialogFooter>
          {status === 'sent' ? (
            <Button onClick={() => setOpen(false)}>Close</Button>
          ) : (
            <Button onClick={submit} disabled={status === 'sending'}>
              {status === 'sending' ? 'Sending…' : 'Send Proposal'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
