import { useQuery } from '@tanstack/react-query';
import { ExternalLink, CircleAlert, CircleCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/features/shared/EmptyState';
import { getPartnerCenterShops } from '@/lib/tiktokShopApi';

/**
 * TikTok Shop Partner Center reconciliation — surfaces every shop actually
 * authorized under Cult Content's Partner Center account (a real TikTok API
 * call, GET /authorization/202309/shops) and flags any that don't have a
 * matching brand record here yet. The backend call already existed but was
 * never used by any frontend before this; brand-to-shop matching is new.
 *
 * The Partner-Center-level connection this depends on (separate from any
 * individual brand's own TikTok Shop OAuth) has never actually been
 * authorized -- so this honestly shows a "Connect" step rather than
 * pretending there's reconciliation data when there isn't any yet.
 */
export function TikTokShopsTab() {
  const query = useQuery({ queryKey: ['staff', 'tiktok-shops'], queryFn: getPartnerCenterShops });

  if (query.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (query.isError) return <EmptyState title="Couldn't load Partner Center shops" description="Try refreshing the page." />;

  const data = query.data!;

  if (!data.configured) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">TikTok Shop Partner Center</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{data.message || 'Not connected yet.'}</p>
          <p className="text-sm text-muted-foreground">
            This is a one-time authorization, separate from any individual brand's own TikTok Shop connection — it lets this app see every shop authorized under Cult Content's Partner Center account, not just the ones with a brand record already set up here.
          </p>
          {data.authUrl && (
            <Button asChild size="sm">
              <a href={data.authUrl}>Connect Partner Center <ExternalLink className="ml-1 size-3.5" /></a>
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const shops = data.shops || [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">TikTok Shop Partner Center</CardTitle>
        <Badge variant={data.unmatchedCount ? 'destructive' : 'default'}>
          {shops.length} authorized · {data.unmatchedCount || 0} unmatched
        </Badge>
      </CardHeader>
      <CardContent>
        {shops.length === 0 ? (
          <EmptyState title="No shops authorized yet" description="Nothing has connected under the Partner Center account." />
        ) : (
          <div className="space-y-2">
            {shops.map((s) => (
              <div key={s.shopId ?? s.name} className="flex items-center justify-between rounded-md border p-3 text-sm">
                <div>
                  <p className="font-medium">{s.name || s.shopId || 'Unnamed shop'}</p>
                  <p className="text-xs text-muted-foreground">{s.shopId}{s.region ? ` · ${s.region}` : ''}</p>
                </div>
                {s.matchedBrandId ? (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-500">
                    <CircleCheck className="size-3.5" /> {s.matchedBrandName}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-xs text-amber-500">
                    <CircleAlert className="size-3.5" /> No matching brand record
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
