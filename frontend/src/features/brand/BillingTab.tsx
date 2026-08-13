import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getBillingPortalUrl, type BillingInfo } from '@/lib/brandApi';

const money = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/**
 * Payment-method management via the real Stripe Customer Portal
 * (GET /api/client/billing/portal — already implemented, not a stub).
 * Tier browsing/change is a fast-follow; this ships the confirmed
 * "update payment method" scope first.
 */
export function BillingTab({ data }: { data: BillingInfo }) {
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState('');

  async function openPortal() {
    setRedirecting(true);
    setError('');
    try {
      const { url } = await getBillingPortalUrl();
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to open the billing portal');
      setRedirecting(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Current plan</CardTitle>
          <Badge variant={data.hasPaymentMethod ? 'default' : 'secondary'}>
            {data.hasPaymentMethod ? 'Payment method on file' : 'No payment method'}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 text-sm sm:grid-cols-3">
            <div><span className="text-muted-foreground">Retainer: </span>{money(data.currentTier.retainer)}/mo</div>
            <div><span className="text-muted-foreground">Commission: </span>{Math.round(data.currentTier.commRate * 100)}% GMV</div>
            <div><span className="text-muted-foreground">Rev share this cycle: </span>{money(data.revShare)}</div>
          </div>
          <p className="text-xs text-muted-foreground">
            {data.cycle.nextBillingLabel} · {data.cycle.daysUntilBilling} day{data.cycle.daysUntilBilling === 1 ? '' : 's'} until next billing
          </p>
          {data.pendingTier && (
            <p className="text-xs text-muted-foreground">
              Pending change to {money(data.pendingTier.retainer)}/mo + {Math.round(data.pendingTier.commRate * 100)}% GMV, effective {data.pendingTier.effectiveLabel}.
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button size="sm" onClick={openPortal} disabled={redirecting}>
            {redirecting ? 'Opening…' : data.hasPaymentMethod ? 'Manage payment method' : 'Add payment method'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Recent invoices</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {data.invoices.length === 0 && <p className="text-sm text-muted-foreground">No invoices yet.</p>}
          {data.invoices.map((inv) => (
            <div key={inv.id} className="flex items-center justify-between rounded-md border p-3 text-sm">
              <span>{inv.date} · {money(inv.amount)}</span>
              <div className="flex items-center gap-2">
                <Badge variant={inv.status === 'paid' ? 'default' : 'secondary'}>{inv.status}</Badge>
                {inv.url && <a href={inv.url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">View</a>}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
