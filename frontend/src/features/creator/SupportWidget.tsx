import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { submitSupportTicket } from '@/lib/creatorApi';

/**
 * Support/contact-us at the top of the panel, per spec — reuses the
 * existing support ticket system (routes/support-tickets.js, already
 * multi-audience-aware), not a new ticketing system.
 */
export function SupportWidget() {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState('question');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function submit() {
    setStatus('sending');
    try {
      await submitSupportTicket(type, message);
      setStatus('sent');
    } catch {
      setStatus('error');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setStatus('idle'); setMessage(''); } }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">Contact Cult Content</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Contact the Cult Content team</DialogTitle>
        </DialogHeader>
        {status === 'sent' ? (
          <p className="text-sm text-muted-foreground">Sent — the team will follow up.</p>
        ) : (
          <div className="space-y-4">
            <Select value={type} onValueChange={setType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="question">Question</SelectItem>
                <SelectItem value="concern">Concern</SelectItem>
                <SelectItem value="suggestion">Suggestion</SelectItem>
              </SelectContent>
            </Select>
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What's up?" />
            {status === 'error' && <p className="text-sm text-destructive">Failed to send — try again.</p>}
          </div>
        )}
        <DialogFooter>
          {status === 'sent' ? (
            <Button onClick={() => setOpen(false)}>Close</Button>
          ) : (
            <Button onClick={submit} disabled={status === 'sending' || !message.trim()}>
              {status === 'sending' ? 'Sending…' : 'Send'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
