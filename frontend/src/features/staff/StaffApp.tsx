import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { getStaffProfile } from '@/lib/staffApi';
import type { Identity } from '@/lib/api';
import { UserMenu } from './UserMenu';
import { MyClientsTab } from './MyClientsTab';
import { SupportInboxTab } from './SupportInboxTab';
import { PointsTab } from './PointsTab';
import { TeamAssignmentsTab } from './TeamAssignmentsTab';
import { CRMTab } from './crm/CRMTab';
import { EmptyState } from '@/features/shared/EmptyState';

function AppHeader({ children }: { children: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-10 border-b border-border/60 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Sparkles className="size-4 text-primary" />
          <span>Cult Content</span>
          <span className="text-muted-foreground font-normal">/ Ops</span>
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
        <Skeleton className="h-10 w-96" />
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
        </div>
      </div>
    </div>
  );
}

/**
 * Employee/Ops portal. Phase 8 first pass covered My Clients, Support
 * Inbox, and Points. CRM/Sales (Growth Partners pipeline + Signal Engine)
 * is the first increment of the segments.html React port — the AI
 * proposal/contract/invoice wizard is a separate, larger follow-up not
 * included yet; segments.html itself stays up (now auth-gated) as the
 * fallback for that workflow until it lands. Task management itself still
 * lives on its existing page for now. Team Assignments only renders for
 * staff with the 'user_admin' permission (server-side enforcement is the
 * real gate — see routes/staff-portal.js).
 */
export function StaffApp({ identity }: { identity: Extract<Identity, { type: 'staff' }> }) {
  const profileQuery = useQuery({ queryKey: ['staff', 'profile'], queryFn: getStaffProfile });
  const [tab, setTab] = useState('my-clients');

  if (profileQuery.isPending) return <DashboardSkeleton />;
  if (profileQuery.isError) {
    return (
      <div className="p-8">
        <EmptyState title="Couldn't load your dashboard" description="Something went wrong — try refreshing the page." />
      </div>
    );
  }

  const profile = profileQuery.data!.profile;
  const isAdmin = profile.permissions.includes('user_admin');
  const displayName = profile.name || identity.name || profile.email || identity.email || 'there';

  return (
    <div className="min-h-screen">
      <AppHeader>
        <UserMenu profile={profile} />
      </AppHeader>

      <main className="mx-auto max-w-6xl space-y-8 p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back, {displayName.split(' ')[0]}</h1>
          {profile.role && <p className="text-sm capitalize text-muted-foreground">{profile.role}</p>}
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="my-clients">My Clients</TabsTrigger>
            <TabsTrigger value="support">Support Inbox</TabsTrigger>
            <TabsTrigger value="points">Points</TabsTrigger>
            <TabsTrigger value="crm">CRM / Sales</TabsTrigger>
            {isAdmin && <TabsTrigger value="team">Team Assignments</TabsTrigger>}
          </TabsList>

          <TabsContent value="my-clients" className="pt-2">
            <MyClientsTab />
          </TabsContent>

          <TabsContent value="support" className="pt-2">
            <SupportInboxTab />
          </TabsContent>

          <TabsContent value="points" className="pt-2">
            <PointsTab />
          </TabsContent>

          <TabsContent value="crm" className="pt-2">
            <CRMTab />
          </TabsContent>

          {isAdmin && (
            <TabsContent value="team" className="pt-2">
              <TeamAssignmentsTab />
            </TabsContent>
          )}
        </Tabs>
      </main>
    </div>
  );
}
