import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Wallet, ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { FinancialSummary } from '@/lib/creatorApi';
import { getPayoutAccountStatus, getPayoutHistory, startPayoutOnboarding } from '@/lib/payoutsApi';

const money = (cents: number | null | undefined) => cents == null ? '—' : `$${(cents / 100).toFixed(2)}`;

const statusLabel: Record<string, string> = {
  pending: 'Onboarding in progress',
  complete: 'Payouts enabled',
  restricted: 'Action needed',
};
const statusVariant: Record<string, 'default' | 'secondary' | 'destructive'> = {
  pending: 'secondary',
  complete: 'default',
  restricted: 'destructive',
};
const payoutStatusVariant: Record<string, 'default' | 'secondary' | 'destructive'> = {
  paid: 'default',
  pending: 'secondary',
  failed: 'destructive',
  reversed: 'destructive',
};

/**
 * Stripe Connect payouts (Phase 9). A real transfer moves funds into your
 * connected account balance -- Stripe then pays that out to your bank on
 * its own schedule, which this doesn't directly observe (see
 * db/stripe-connect.js's header comment) -- so "Paid" here means the
 * transfer succeeded on our side, not a guarantee it's already in your
 * bank account.
 */
function PayoutsCard() {
  const statusQuery = useQuery({ queryKey: ['creator', 'payouts', 'status'], queryFn: getPayoutAccountStatus });
  const historyQuery = useQuery({ queryKey: ['creator', 'payouts', 'history'], queryFn: getPayoutHistory });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  async function onboard() {
    setStarting(true);
    setError('');
    try {
      const { url } = await startPayoutOnboarding();
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start payout onboarding');
      setStarting(false);
    }
  }

  const account = statusQuery.data?.account ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base"><Wallet className="size-4 text-primary" />Payouts</CardTitle>
        {account && <Badge variant={statusVariant[account.onboardingStatus]}>{statusLabel[account.onboardingStatus]}</Badge>}
      </CardHeader>
      <CardContent className="space-y-3">
        {statusQuery.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!statusQuery.isPending && (!account || account.onboardingStatus !== 'complete') && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {account ? 'Finish setting up Stripe to receive payouts.' : 'Connect a Stripe account to get paid directly.'}
            </p>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button size="sm" onClick={onboard} disabled={starting}>
              {starting ? 'Redirecting…' : account ? 'Continue Setup' : 'Set Up Payouts'} <ExternalLink />
            </Button>
          </div>
        )}
        {historyQuery.data && historyQuery.data.payouts.length > 0 && (
          <div className="space-y-1.5 pt-1">
            {historyQuery.data.payouts.map((p) => (
              <div key={p.id} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{p.description || 'Payout'} · {new Date(p.created_at).toLocaleDateString()}</span>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{money(p.amount_cents)}</span>
                  <Badge variant={payoutStatusVariant[p.status]}>{p.status}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
        {historyQuery.data && historyQuery.data.payouts.length === 0 && account?.onboardingStatus === 'complete' && (
          <p className="text-sm text-muted-foreground">No payouts yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Ships first against creator_rates + retainer_agreements/offers, per the
 * plan — TikTok Shop commission data is a documented fast-follow once
 * brand-side TikTok Shop tooling + creator-shop linking exists.
 */
export function FinancialTab({ data }: { data: FinancialSummary }) {
  return (
    <div className="space-y-4">
      <PayoutsCard />

      <Card>
        <CardHeader><CardTitle className="text-base">Your rate</CardTitle></CardHeader>
        <CardContent>
          {data.rate ? (
            <div className="grid gap-2 sm:grid-cols-3 text-sm">
              <div><span className="text-muted-foreground">Per video: </span>{money(data.rate.per_video_cents)}</div>
              <div><span className="text-muted-foreground">Monthly retainer: </span>{money(data.rate.retainer_monthly_cents)}</div>
              <div><span className="text-muted-foreground">Package: </span>{data.rate.package_label || '—'}</div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No rate on file yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Retainer agreements</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {data.retainerAgreements.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
          {data.retainerAgreements.map((a) => (
            <div key={a.id} className="flex items-center justify-between rounded-md border p-3 text-sm">
              <span>{money(a.amount_cents)} · {a.videos_delivered}/{a.videos_committed} videos delivered</span>
              <Badge variant={a.status === 'active' ? 'default' : 'secondary'}>{a.status}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Retainer offers</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {data.retainerOffers.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
          {data.retainerOffers.map((o) => (
            <div key={o.id} className="flex items-center justify-between rounded-md border p-3 text-sm">
              <span>{o.brand_name} · {o.offer_type} · {money(o.amount_cents)}</span>
              <Badge variant={o.status === 'pending' ? 'secondary' : 'default'}>{o.status}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
