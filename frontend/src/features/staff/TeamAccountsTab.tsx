import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/features/shared/EmptyState';
import {
  getTeamAccounts, createTeamAccount, updateTeamAccount, deleteTeamAccount, type TeamAccount,
} from '@/lib/staffApi';

const PERMISSION_LABELS: Record<string, string> = {
  admin_portal: 'Admin portal',
  client_portal: 'Client portal (impersonate/view)',
  inner_circle: 'Inner Circle admin',
  billing: 'Billing / financials',
  user_admin: 'Manage other accounts',
};

function AccountRow({ account, allPermissions, isSelf }: { account: TeamAccount; allPermissions: string[]; isSelf: boolean }) {
  const [resetting, setResetting] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['staff', 'team-accounts'] });
  }

  async function togglePermission(perm: string) {
    setError(null);
    const has = account.permissions.includes(perm);
    const next = has ? account.permissions.filter((p) => p !== perm) : [...account.permissions, perm];
    try {
      await updateTeamAccount(account.id, { permissions: next });
      invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update permissions');
    }
  }

  async function toggleActive() {
    setError(null);
    try {
      await updateTeamAccount(account.id, { active: !account.active });
      invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update account');
    }
  }

  async function submitReset() {
    if (newPassword.trim().length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    try {
      await updateTeamAccount(account.id, { password: newPassword.trim() });
      setNewPassword('');
      setResetting(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reset password');
    }
  }

  async function remove() {
    if (!confirm(`Permanently remove "${account.username}"? This can't be undone.`)) return;
    try {
      await deleteTeamAccount(account.id);
      invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove account');
    }
  }

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">{account.name}</span>
          <span className="text-xs text-muted-foreground">@{account.username}</span>
          {account.email && <span className="text-xs text-muted-foreground">({account.email})</span>}
          <Badge variant="outline" className="capitalize">{account.role}</Badge>
          {isSelf && <Badge variant="secondary">You</Badge>}
          {!account.active && <Badge variant="destructive">Disabled</Badge>}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-4">
        {allPermissions.map((perm) => (
          <label key={perm} className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              size="sm"
              checked={account.permissions.includes(perm)}
              onCheckedChange={() => togglePermission(perm)}
              disabled={isSelf && perm === 'user_admin'}
            />
            {PERMISSION_LABELS[perm] || perm}
          </label>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setResetting((v) => !v)}>
          {resetting ? 'Cancel' : 'Reset password'}
        </Button>
        <Button size="sm" variant="outline" onClick={toggleActive}>
          {account.active ? 'Disable' : 'Enable'}
        </Button>
        {!isSelf && (
          <Button size="sm" variant="destructive" onClick={remove}>Remove</Button>
        )}
      </div>

      {resetting && (
        <div className="mt-2 flex gap-2">
          <Input
            type="password"
            placeholder="New password (min 6 chars)"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="h-8 max-w-xs"
          />
          <Button size="sm" onClick={submitReset}>Save</Button>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function CreateAccountForm({ allPermissions, onCreated }: { allPermissions: string[]; onCreated: () => void }) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function togglePermission(perm: string) {
    setPermissions((prev) => (prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm]));
  }

  async function submit() {
    setError(null);
    if (!username.trim()) return setError('Username is required');
    if (password.trim().length < 6) return setError('Password must be at least 6 characters');
    setSaving(true);
    try {
      await createTeamAccount({
        username: username.trim(),
        email: email.trim() || undefined,
        name: name.trim() || undefined,
        password: password.trim(),
        permissions: permissions.length ? permissions : [],
      });
      setUsername(''); setEmail(''); setName(''); setPassword(''); setPermissions([]);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create account');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Add a teammate account</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="ta-username">Username</Label>
            <Input id="ta-username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="danny" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ta-name">Display name</Label>
            <Input id="ta-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Danny" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ta-email">Email (optional)</Label>
            <Input id="ta-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="danny@cultcontent.cc" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ta-password">Temporary password</Label>
            <Input id="ta-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="min 6 characters" />
          </div>
        </div>
        <div className="space-y-1">
          <Label>Permissions</Label>
          <div className="flex flex-wrap gap-4">
            {allPermissions.map((perm) => (
              <label key={perm} className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch size="sm" checked={permissions.includes(perm)} onCheckedChange={() => togglePermission(perm)} />
                {PERMISSION_LABELS[perm] || perm}
              </label>
            ))}
          </div>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button size="sm" onClick={submit} disabled={saving}>{saving ? 'Creating…' : 'Create account'}</Button>
        <p className="text-xs text-muted-foreground">Share the password with them directly — it isn't emailed automatically.</p>
      </CardContent>
    </Card>
  );
}

/**
 * Owner/user_admin: create, permission-edit, reset-password, disable, and
 * remove teammate login accounts. Parallel to the legacy dashboard/
 * portal-admin-team.html page (same underlying storage via routes/staff-
 * portal.js's /api/staff/team-accounts, which reuses portal-team-auth.js's
 * createUser/updateUser/deleteUser as-is) — this just makes the capability
 * reachable from the new portal, where "Team Assignments" (a different
 * feature: assigning brands to staff) already lives.
 */
export function TeamAccountsTab({ selfId }: { selfId: string | null }) {
  const accountsQuery = useQuery({ queryKey: ['staff', 'team-accounts'], queryFn: getTeamAccounts });
  const queryClient = useQueryClient();

  if (accountsQuery.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (accountsQuery.isError) return <EmptyState title="Couldn't load accounts" description="Try refreshing the page." />;

  const { users, allPermissions } = accountsQuery.data!;

  return (
    <div className="space-y-4">
      <CreateAccountForm
        allPermissions={allPermissions}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['staff', 'team-accounts'] })}
      />
      <div className="space-y-3">
        {users.map((u) => (
          <AccountRow key={u.id} account={u} allPermissions={allPermissions} isSelf={u.id === selfId} />
        ))}
      </div>
    </div>
  );
}
