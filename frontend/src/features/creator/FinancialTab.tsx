import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { FinancialSummary } from '@/lib/creatorApi';

const money = (cents: number | null | undefined) => cents == null ? '—' : `$${(cents / 100).toFixed(2)}`;

/**
 * Ships first against creator_rates + retainer_agreements/offers, per the
 * plan — TikTok Shop commission data is a documented fast-follow once
 * brand-side TikTok Shop tooling + creator-shop linking exists.
 */
export function FinancialTab({ data }: { data: FinancialSummary }) {
  return (
    <div className="space-y-4">
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
