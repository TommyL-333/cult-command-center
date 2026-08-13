import { useQuery } from '@tanstack/react-query';
import { Trophy } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/features/shared/EmptyState';
import { getLeaderboard, getMyPoints } from '@/lib/staffApi';

/**
 * Point-based task management, per spec. Points are earned by completing
 * real tasks in the existing Lark-backed system (routes/ops-my-tasks.js's
 * POST /api/my-tasks/complete, extended in Phase 8 to accept an optional
 * points value on an already-verified completion) — this tab is the
 * read/display side of that: your own total + the team leaderboard.
 */
export function PointsTab() {
  const mineQuery = useQuery({ queryKey: ['staff', 'points', 'mine'], queryFn: getMyPoints });
  const leaderboardQuery = useQuery({ queryKey: ['staff', 'points', 'leaderboard'], queryFn: getLeaderboard });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Your points</CardTitle></CardHeader>
        <CardContent>
          {mineQuery.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {mineQuery.isError && <p className="text-sm text-muted-foreground">Couldn't load your points.</p>}
          {mineQuery.data && (
            <div className="space-y-3">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold tracking-tight">{mineQuery.data.total}</span>
                <span className="text-sm text-muted-foreground">from {mineQuery.data.taskCount} task{mineQuery.data.taskCount === 1 ? '' : 's'}</span>
              </div>
              {mineQuery.data.recent.length > 0 && (
                <div className="space-y-1.5">
                  {mineQuery.data.recent.slice(0, 8).map((r) => (
                    <div key={r.id} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{r.task_title || 'Untitled task'}</span>
                      <Badge variant="secondary">+{r.points}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center gap-2">
          <Trophy className="size-4 text-amber-500" />
          <CardTitle className="text-base">Team leaderboard</CardTitle>
        </CardHeader>
        <CardContent>
          {leaderboardQuery.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {leaderboardQuery.isError && <p className="text-sm text-muted-foreground">Couldn't load the leaderboard.</p>}
          {leaderboardQuery.data && leaderboardQuery.data.leaderboard.length === 0 && (
            <EmptyState title="No points awarded yet" description="Points show up here once tasks get completed with a point value." />
          )}
          {leaderboardQuery.data && leaderboardQuery.data.leaderboard.length > 0 && (
            <div className="space-y-2">
              {leaderboardQuery.data.leaderboard.map((row, i) => (
                <div key={row.email} className="flex items-center justify-between rounded-md border p-3 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="w-5 text-center font-mono text-xs text-muted-foreground">#{i + 1}</span>
                    <span className="font-medium">{row.name}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{row.task_count} task{row.task_count === 1 ? '' : 's'}</span>
                    <Badge>{row.total} pts</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
