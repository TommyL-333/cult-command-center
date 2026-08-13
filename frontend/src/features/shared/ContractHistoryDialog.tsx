import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { getContractHistory, type Contract } from '@/lib/proposalsApi';

function formatTerms(termsJson: string) {
  try {
    const terms = JSON.parse(termsJson);
    return Object.entries(terms).map(([k, v]) => `${k}: ${v}`).join(', ') || '(no terms recorded)';
  } catch {
    return termsJson;
  }
}

/**
 * Shared by "View Contract" (My Brands — single active contract) and
 * "Previous Contracts" (Previous Contracts tab — drill into a brand's full
 * history, since a pair can have more than one past contract over time).
 * Both cases are the same underlying data (GET /api/contracts/pair), just
 * different entry points.
 */
export function ContractHistoryDialog({
  creatorId, brandId, counterpartyName, trigger, title,
}: {
  // creatorId/brandId match GET /api/contracts/pair's params exactly — a
  // contract pair is always (creator, brand), not two symmetric parties.
  // counterpartyName is display-only: pass the creator's name when calling
  // from the brand portal, the brand's name when calling from the creator
  // portal — whichever side ISN'T the viewer.
  creatorId: string | number; brandId: string; counterpartyName: string | null; trigger: React.ReactNode; title: string;
}) {
  const [open, setOpen] = useState(false);
  const [contracts, setContracts] = useState<Contract[] | null>(null);
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      const { contracts } = await getContractHistory(creatorId, brandId);
      setContracts(contracts);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load contract history');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v) load(); }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title} — {counterpartyName || brandId}</DialogTitle>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!contracts && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
        {contracts && contracts.length === 0 && <p className="text-sm text-muted-foreground">No contracts found.</p>}
        <div className="space-y-3">
          {contracts?.map((c) => (
            <div key={c.id} className="rounded-md border p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">Contract #{c.id}</span>
                <Badge variant={c.ended_at ? 'secondary' : 'default'}>{c.ended_at ? 'Ended' : 'Active'}</Badge>
              </div>
              <p className="mt-1 text-muted-foreground">{formatTerms(c.terms_json)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Started {new Date(c.started_at).toLocaleDateString()}
                {c.ended_at ? ` · Ended ${new Date(c.ended_at).toLocaleDateString()}` : ''}
              </p>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
