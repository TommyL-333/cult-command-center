import { Card, CardContent } from '@/components/ui/card';
import type { CreatorBrands, FinancialSummary } from '@/lib/creatorApi';

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}

/**
 * Stats front-and-center at the top, per spec — same stat-card treatment as
 * the existing /my-tasks view. Built from what GET /api/creator/brands and
 * GET /api/creator/financial-summary genuinely return today, not fabricated
 * placeholder numbers.
 */
export function StatsRow({ brands, financial }: { brands: CreatorBrands; financial: FinancialSummary }) {
  const videosDelivered = financial.retainerAgreements.reduce((sum, a) => sum + (a.videos_delivered || 0), 0);
  const pendingOffers = financial.retainerOffers.filter((o) => o.status === 'pending').length;

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <Stat label="Active Brands" value={brands.myBrands.length} />
      <Stat label="Videos Delivered" value={videosDelivered} />
      <Stat label="Pending Offers" value={pendingOffers} />
      <Stat label="Past Brands" value={brands.previousBrands.length} />
    </div>
  );
}
