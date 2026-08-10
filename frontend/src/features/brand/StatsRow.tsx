import { Users, DollarSign, Search, Archive } from 'lucide-react';
import { GlowingBorderCard } from '@/features/shared/GlowingBorderCard';
import type { BrandCreators, BillingInfo } from '@/lib/brandApi';

function StatIcon({ icon: Icon, colorClass }: { icon: typeof Users; colorClass: string }) {
  return (
    <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-lg border border-border/50 bg-background shadow-sm">
      <Icon className={`h-4.5 w-4.5 ${colorClass}`} />
    </div>
  );
}

function Stat({ icon, colorClass, glowColor, repeatingGradient, value, label }: {
  icon: typeof Users; colorClass: string; glowColor: string; repeatingGradient: string;
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
 * Mirrors features/creator/StatsRow.tsx from the brand side — built from
 * what GET /api/brand/creators and GET /api/client/billing genuinely
 * return today.
 */
export function StatsRow({ creators, billing }: { creators: BrandCreators; billing: BillingInfo }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat
        icon={Users} colorClass="text-primary" value={creators.currentAffiliates.length} label="Active Affiliates"
        glowColor="rgba(0, 242, 234, 0.7)"
        repeatingGradient="repeating-linear-gradient(45deg, rgba(0,242,234,0.12), rgba(0,242,234,0.12) 15px, transparent 15px, transparent 30px)"
      />
      <Stat
        icon={DollarSign} colorClass="text-accent" value={`$${billing.revShare.toFixed(2)}`} label="Rev Share (GMV)"
        glowColor="rgba(168, 85, 247, 0.7)"
        repeatingGradient="repeating-linear-gradient(-45deg, rgba(168,85,247,0.12), rgba(168,85,247,0.12) 15px, transparent 15px, transparent 30px)"
      />
      <Stat
        icon={Search} colorClass="text-amber-500" value={creators.exploreCreators.length} label="Creators to Explore"
        glowColor="rgba(245, 158, 11, 0.7)"
        repeatingGradient="repeating-linear-gradient(45deg, rgba(245,158,11,0.12), rgba(245,158,11,0.12) 15px, transparent 15px, transparent 30px)"
      />
      <Stat
        icon={Archive} colorClass="text-muted-foreground" value={creators.previousCreators.length} label="Past Affiliates"
        glowColor="rgba(148, 163, 184, 0.6)"
        repeatingGradient="repeating-linear-gradient(-45deg, rgba(148,163,184,0.10), rgba(148,163,184,0.10) 15px, transparent 15px, transparent 30px)"
      />
    </div>
  );
}
