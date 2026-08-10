import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { getCreatorBrands, getFinancialSummary, getProfile } from '@/lib/creatorApi';
import type { Identity } from '@/lib/api';
import { StatsRow } from './StatsRow';
import { SupportWidget } from './SupportWidget';
import { UserMenu } from './UserMenu';
import { BrandCard } from './BrandCard';
import { EmptyState } from './EmptyState';
import { FinancialTab } from './FinancialTab';
import { ProfileCard } from './ProfileCard';

function AppHeader({ children }: { children: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-10 border-b border-border/60 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Sparkles className="size-4 text-primary" />
          <span>Cult Content</span>
          <span className="text-muted-foreground font-normal">/ Creator</span>
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

export function CreatorApp({ identity }: { identity: Extract<Identity, { type: 'creator' }> }) {
  const queryClient = useQueryClient();
  const brandsQuery = useQuery({ queryKey: ['creator', 'brands'], queryFn: getCreatorBrands });
  const financialQuery = useQuery({ queryKey: ['creator', 'financial'], queryFn: getFinancialSummary });
  const profileQuery = useQuery({ queryKey: ['creator', 'profile'], queryFn: getProfile });

  const [tab, setTab] = useState('my-brands');

  if (brandsQuery.isPending || financialQuery.isPending || profileQuery.isPending) {
    return <DashboardSkeleton />;
  }
  if (brandsQuery.isError || financialQuery.isError || profileQuery.isError) {
    return (
      <div className="p-8">
        <EmptyState title="Couldn't load your dashboard" description="Something went wrong — try refreshing the page." />
      </div>
    );
  }

  const brands = brandsQuery.data!;
  const financial = financialQuery.data!;
  const profile = profileQuery.data!.profile;

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
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back, {profile.name.split(' ')[0]}</h1>
          <p className="text-sm text-muted-foreground">{profile.handle}</p>
        </div>

        <StatsRow brands={brands} financial={financial} />

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="my-brands">My Brands</TabsTrigger>
            <TabsTrigger value="new-brands">New Brands</TabsTrigger>
            <TabsTrigger value="previous">Previous Contracts</TabsTrigger>
          </TabsList>

          <TabsContent value="my-brands" className="grid gap-4 pt-2 sm:grid-cols-2">
            {brands.myBrands.length === 0 ? (
              <EmptyState title="No active brands yet" description="Send a proposal from New Brands to get started." className="sm:col-span-2" />
            ) : brands.myBrands.map(({ brand, contract }) => (
              <BrandCard key={brand.id} variant="my" brand={brand} contract={contract} creatorId={identity.id!} />
            ))}
          </TabsContent>

          <TabsContent value="new-brands" className="grid gap-4 pt-2 sm:grid-cols-2">
            {brands.newBrands.length === 0 ? (
              <EmptyState title="No brands to discover right now" className="sm:col-span-2" />
            ) : brands.newBrands.map(({ brand }) => (
              <BrandCard key={brand.id} variant="new" brand={brand} creatorId={identity.id!} />
            ))}
          </TabsContent>

          <TabsContent value="previous" className="grid gap-4 pt-2 sm:grid-cols-2">
            {brands.previousBrands.length === 0 ? (
              <EmptyState title="No past contracts yet" className="sm:col-span-2" />
            ) : brands.previousBrands.map(({ brand, contractCount }) => (
              <BrandCard key={brand.id} variant="previous" brand={brand} contractCount={contractCount} creatorId={identity.id!} />
            ))}
          </TabsContent>

          <TabsContent value="financials" className="pt-2">
            <FinancialTab data={financial} />
          </TabsContent>

          <TabsContent value="profile" className="pt-2">
            <ProfileCard profile={profile} onUpdated={() => queryClient.invalidateQueries({ queryKey: ['creator', 'profile'] })} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
