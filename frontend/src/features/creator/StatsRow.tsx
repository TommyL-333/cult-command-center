import { Handshake, Video, Inbox, Archive } from 'lucide-react';
import { GlowingBorderCard } from './GlowingBorderCard';
import type { CreatorBrands, FinancialSummary } from '@/lib/creatorApi';

function StatIcon({ icon: Icon, colorClass }: { icon: typeof Handshake; colorClass: string }) {
  return (
    <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-lg border border-border/50 bg-background shadow-sm">
      <Icon className={`h-4.5 w-4.5 ${colorClass}`} />
    </div>
  );
}

function Stat({ icon, colorClass, glowColor, repeatingGradient, value, label }: {
  icon: typeof Handshake; colorClass: string; glowColor: string; repeatingGradient: string;
  value: string | number; label: string;
}) {
  return (
    <GlowingBorderCard glowColor={glowColor} repeatingGradient={repeatingGradient}>
      <StatIcon icon={icon} colorClass={colorClass} />
      <div className="text-3xl font-bold tracking-tight text-foreground">{value}</div>
      <p className="mt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
    </GlowingBorderCard>
  );
}

/**
 * Stats front-and-center at the top, per spec. Built from what
 * GET /api/creator/brands and GET /api/creator/financial-summary
 * genuinely return today, not fabricated numbers — same real data as
 * before, presented with the GlowingBorderCard treatment (adapted from
 * Watermelon UI's stats-4 block) instead of flat gray cards.
 */
export function StatsRow({ brands, financial }: { brands: CreatorBrands; financial: FinancialSummary }) {
  const videosDelivered = financial.retainerAgreements.reduce((sum, a) => sum + (a.videos_delivered || 0), 0);
  const pendingOffers = financial.retainerOffers.filter((o) => o.status === 'pending').length;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat
        icon={Handshake} colorClass="text-primary" value={brands.myBrands.length} label="Active Brands"
        glowColor="rgba(0, 242, 234, 0.7)"
        repeatingGradient="repeating-linear-gradient(45deg, rgba(0,242,234,0.12), rgba(0,242,234,0.12) 15px, transparent 15px, transparent 30px)"
      />
      <Stat
        icon={Video} colorClass="text-accent" value={videosDelivered} label="Videos Delivered"
        glowColor="rgba(168, 85, 247, 0.7)"
        repeatingGradient="repeating-linear-gradient(-45deg, rgba(168,85,247,0.12), rgba(168,85,247,0.12) 15px, transparent 15px, transparent 30px)"
      />
      <Stat
        icon={Inbox} colorClass="text-amber-500" value={pendingOffers} label="Pending Offers"
        glowColor="rgba(245, 158, 11, 0.7)"
        repeatingGradient="repeating-linear-gradient(45deg, rgba(245,158,11,0.12), rgba(245,158,11,0.12) 15px, transparent 15px, transparent 30px)"
      />
      <Stat
        icon={Archive} colorClass="text-muted-foreground" value={brands.previousBrands.length} label="Past Brands"
        glowColor="rgba(148, 163, 184, 0.6)"
        repeatingGradient="repeating-linear-gradient(-45deg, rgba(148,163,184,0.10), rgba(148,163,184,0.10) 15px, transparent 15px, transparent 30px)"
      />
    </div>
  );
}
