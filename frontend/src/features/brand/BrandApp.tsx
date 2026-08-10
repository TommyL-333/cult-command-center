import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { getBrandCreators, getBrandProfile, getBilling } from '@/lib/brandApi';
import type { Identity } from '@/lib/api';
import { StatsRow } from './StatsRow';
import { SupportWidget } from './SupportWidget';
import { UserMenu } from './UserMenu';
import { CreatorCard } from './CreatorCard';
import { EmptyState } from '@/features/shared/EmptyState';
import { ContentGenerationTab } from './ContentGenerationTab';
import { BillingTab } from './BillingTab';
import { ProfileCard } from './ProfileCard';

function AppHeader({ children }: { children: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-10 border-b border-border/60 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Sparkles className="size-4 text-primary" />
          <span>Cult Content</span>
          <span className="text-muted-foreground font-normal">/ Brand</span>
        </div>
        {children}
      </div>
    </header>
  );
}

function DashboardSkeleton() {
  return (
    <div>
      <AppHeader><Skeleton className="h-9 w-9 rounded-full" /></AppHeader>
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
        <Skeleton className="h-10 w-80" />
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
        </div>
      </div>
    </div>
  );
}

/**
 * Mirrors features/creator/CreatorApp.tsx from the brand side: same shell
 * shape (sticky header, controlled Tabs, stats up top, avatar-dropdown for
 * Profile/Billing instead of separate tabs), built on Phase 7's
 * routes/brand-portal.js + the pre-existing content-studio/billing/buffer
 * routes it wraps.
 */
export function BrandApp({ identity }: { identity: Extract<Identity, { type: 'brand' }> }) {
  const queryClient = useQueryClient();
  const creatorsQuery = useQuery({ queryKey: ['brand', 'creators'], queryFn: getBrandCreators });
  const billingQuery = useQuery({ queryKey: ['brand', 'billing'], queryFn: getBilling });
  const profileQuery = useQuery({ queryKey: ['brand', 'profile'], queryFn: getBrandProfile });

  const [tab, setTab] = useState('current-affiliates');

  if (creatorsQuery.isPending || billingQuery.isPending || profileQuery.isPending) {
    return <DashboardSkeleton />;
  }
  if (creatorsQuery.isError || billingQuery.isError || profileQuery.isError) {
    return (
      <div className="p-8">
        <EmptyState title="Couldn't load your dashboard" description="Something went wrong — try refreshing the page." />
      </div>
    );
  }

  const creators = creatorsQuery.data!;
  const billing = billingQuery.data!;
  const profile = profileQuery.data!.profile;
  const brandId = String(identity.id ?? profile.id);

  return (
    <div className="min-h-screen">
      <AppHeader>
        <div className="flex items-center gap-3">
          <SupportWidget />
          <UserMenu profile={profile} onSelect={setTab} />
        </div>
      </AppHeader>

      <main className="mx-auto max-w-6xl space-y-8 p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back, {profile.name || 'there'}</h1>
          {profile.handle && <p className="text-sm text-muted-foreground">{profile.handle}</p>}
        </div>

        <StatsRow creators={creators} billing={billing} />

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="current-affiliates">Current Affiliates</TabsTrigger>
            <TabsTrigger value="explore">Explore Creators</TabsTrigger>
            <TabsTrigger value="previous">Previous Creators</TabsTrigger>
            <TabsTrigger value="content">Content Generation</TabsTrigger>
          </TabsList>

          <TabsContent value="current-affiliates" className="grid gap-4 pt-2 sm:grid-cols-2">
            {creators.currentAffiliates.length === 0 ? (
              <EmptyState title="No active affiliates yet" description="Send a proposal from Explore Creators to get started." className="sm:col-span-2" />
            ) : creators.currentAffiliates.map(({ creator, contract }) => (
              <CreatorCard key={creator.id} variant="current" creator={creator} contract={contract} brandId={brandId} />
            ))}
          </TabsContent>

          <TabsContent value="explore" className="grid gap-4 pt-2 sm:grid-cols-2">
            {creators.exploreCreators.length === 0 ? (
              <EmptyState title="No creators to discover right now" className="sm:col-span-2" />
            ) : creators.exploreCreators.map(({ creator }) => (
              <CreatorCard key={creator.id} variant="explore" creator={creator} brandId={brandId} />
            ))}
          </TabsContent>

          <TabsContent value="previous" className="grid gap-4 pt-2 sm:grid-cols-2">
            {creators.previousCreators.length === 0 ? (
              <EmptyState title="No past affiliates yet" className="sm:col-span-2" />
            ) : creators.previousCreators.map(({ creator, contractCount }) => (
              <CreatorCard key={creator.id} variant="previous" creator={creator} contractCount={contractCount} brandId={brandId} />
            ))}
          </TabsContent>

          <TabsContent value="content" className="pt-2">
            <ContentGenerationTab />
          </TabsContent>

          <TabsContent value="billing" className="pt-2">
            <BillingTab data={billing} />
          </TabsContent>

          <TabsContent value="profile" className="pt-2">
            <ProfileCard profile={profile} onUpdated={() => queryClient.invalidateQueries({ queryKey: ['brand', 'profile'] })} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
