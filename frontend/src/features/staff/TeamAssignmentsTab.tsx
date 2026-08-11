import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/features/shared/EmptyState';
import { getAssignmentBoard, getRoster, assignBrand, unassignBrand } from '@/lib/staffApi';

function AssignRow({ brandId, staffOptions, onAssigned }: {
  brandId: string;
  staffOptions: { id: string; name: string }[];
  onAssigned: () => void;
}) {
  const [staffId, setStaffId] = useState('');
  const [role, setRole] = useState<'primary' | 'support'>('primary');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!staffId) return;
    setSaving(true);
    setError('');
    try {
      await assignBrand(brandId, staffId, role);
      setStaffId('');
      onAssigned();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to assign');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <Select value={staffId} onValueChange={setStaffId}>
        <SelectTrigger className="h-8 w-48"><SelectValue placeholder="Assign to…" /></SelectTrigger>
        <SelectContent>
          {staffOptions.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={role} onValueChange={(v) => setRole(v as 'primary' | 'support')}>
        <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="primary">Primary</SelectItem>
          <SelectItem value="support">Support</SelectItem>
        </SelectContent>
      </Select>
      <Button size="sm" onClick={submit} disabled={!staffId || saving}>{saving ? 'Adding…' : 'Add'}</Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

/**
 * Team Assignments — the admin-facing side of "My Clients": staff/team-
 * admins assign brands to teammates here; each teammate then sees their own
 * assignments on the My Clients tab. Gated client-side on the 'user_admin'
 * permission (StaffApp.tsx only renders this tab for admins) — the real
 * enforcement is server-side (POST /api/staff/clients/assign|unassign both
 * require it), this is just about not showing controls a non-admin can't use.
 */
export function TeamAssignmentsTab() {
  const queryClient = useQueryClient();
  const boardQuery = useQuery({ queryKey: ['staff', 'assignments'], queryFn: getAssignmentBoard });
  const rosterQuery = useQuery({ queryKey: ['staff', 'roster'], queryFn: getRoster });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['staff', 'assignments'] });
    queryClient.invalidateQueries({ queryKey: ['staff', 'my-clients'] });
  }

  async function remove(brandId: string, staffId: string) {
    await unassignBrand(brandId, staffId);
    refresh();
  }

  if (boardQuery.isPending || rosterQuery.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (boardQuery.isError || rosterQuery.isError) return <EmptyState title="Couldn't load team assignments" description="Try refreshing the page." />;

  const roster = rosterQuery.data!.roster;
  const rosterById = new Map(roster.map((r) => [r.id, r.name]));

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {boardQuery.data!.brands.map(({ brand, staff }) => (
        <Card key={brand.id}>
          <CardHeader><CardTitle className="text-base">{brand.name || brand.id}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {staff.length === 0 ? (
              <p className="text-sm text-muted-foreground">No one assigned yet.</p>
            ) : (
              <div className="space-y-1.5">
                {staff.map((s) => (
                  <div key={s.staff_id} className="flex items-center justify-between text-sm">
                    <span>{rosterById.get(s.staff_id) || s.staff_id}</span>
                    <div className="flex items-center gap-2">
                      <Badge variant={s.role === 'primary' ? 'default' : 'secondary'} className="capitalize">{s.role}</Badge>
                      <button
                        type="button"
                        onClick={() => remove(brand.id, s.staff_id)}
                        className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                        aria-label={`Remove ${rosterById.get(s.staff_id) || s.staff_id}`}
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <AssignRow brandId={brand.id} staffOptions={roster} onAssigned={refresh} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
