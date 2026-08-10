import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getCreatorBrands, getFinancialSummary, getProfile } from '@/lib/creatorApi';
import type { Identity } from '@/lib/api';
import { StatsRow } from './StatsRow';
import { SupportWidget } from './SupportWidget';
import { UserMenu } from './UserMenu';
import { BrandCard } from './BrandCard';
import { FinancialTab } from './FinancialTab';
import { ProfileCard } from './ProfileCard';

export function CreatorApp({ identity }: { identity: Extract<Identity, { type: 'creator' }> }) {
  const queryClient = useQueryClient();
  const brandsQuery = useQuery({ queryKey: ['creator', 'brands'], queryFn: getCreatorBrands });
  const financialQuery = useQuery({ queryKey: ['creator', 'financial'], queryFn: getFinancialSummary });
  const profileQuery = useQuery({ queryKey: ['creator', 'profile'], queryFn: getProfile });

  // Controlled so the UserMenu dropdown can jump straight to "profile" or
  // "financials" even though neither has a visible tab trigger anymore —
  // Radix Tabs only needs a matching `value`, not a rendered Trigger, to
  // activate a Content panel.
  const [tab, setTab] = useState('my-brands');

  if (brandsQuery.isPending || financialQuery.isPending || profileQuery.isPending) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }
  if (brandsQuery.isError || financialQuery.isError || profileQuery.isError) {
    return <div className="p-8 text-sm text-destructive">Failed to load your dashboard. Try refreshing.</div>;
  }

  const brands = brandsQuery.data!;
  const financial = financialQuery.data!;
  const profile = profileQuery.data!.profile;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Welcome back, {profile.name}</h1>
          <p className="text-sm text-muted-foreground">{profile.handle}</p>
        </div>
        <div className="flex items-center gap-3">
          <SupportWidget />
          <UserMenu profile={profile} onSelect={setTab} />
        </div>
      </div>

      <StatsRow brands={brands} financial={financial} />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="my-brands">My Brands</TabsTrigger>
          <TabsTrigger value="new-brands">New Brands</TabsTrigger>
          <TabsTrigger value="previous">Previous Contracts</TabsTrigger>
        </TabsList>

        <TabsContent value="my-brands" className="grid gap-4 sm:grid-cols-2">
          {brands.myBrands.length === 0 && <p className="text-sm text-muted-foreground">No active brand contracts yet — check New Brands.</p>}
          {brands.myBrands.map(({ brand, contract }) => (
            <BrandCard key={brand.id} variant="my" brand={brand} contract={contract} creatorId={identity.id!} />
          ))}
        </TabsContent>

        <TabsContent value="new-brands" className="grid gap-4 sm:grid-cols-2">
          {brands.newBrands.length === 0 && <p className="text-sm text-muted-foreground">No brands to discover right now.</p>}
          {brands.newBrands.map(({ brand }) => (
            <BrandCard key={brand.id} variant="new" brand={brand} creatorId={identity.id!} />
          ))}
        </TabsContent>

        <TabsContent value="previous" className="grid gap-4 sm:grid-cols-2">
          {brands.previousBrands.length === 0 && <p className="text-sm text-muted-foreground">No past contracts yet.</p>}
          {brands.previousBrands.map(({ brand, contractCount }) => (
            <BrandCard key={brand.id} variant="previous" brand={brand} contractCount={contractCount} creatorId={identity.id!} />
          ))}
        </TabsContent>

        <TabsContent value="financials">
          <FinancialTab data={financial} />
        </TabsContent>

        <TabsContent value="profile">
          <ProfileCard profile={profile} onUpdated={() => queryClient.invalidateQueries({ queryKey: ['creator', 'profile'] })} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
