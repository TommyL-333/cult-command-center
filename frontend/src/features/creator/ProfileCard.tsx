import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import type { Profile } from '@/lib/creatorApi';
import { updateProfile } from '@/lib/creatorApi';

/**
 * Email + social handle are required at signup already (routes/inner-circle-
 * sqlite.js's signup validation) — shown here read-only, not re-editable.
 * Discord username and SMS opt-in are the two OPTIONAL fields from the spec.
 */
export function ProfileCard({ profile, onUpdated }: { profile: Profile; onUpdated: (p: Profile) => void }) {
  const [discordUsername, setDiscordUsername] = useState(profile.discordUsername || '');
  const [smsOptIn, setSmsOptIn] = useState(profile.smsOptIn);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      await updateProfile({ discordUsername, smsOptIn });
      onUpdated({ ...profile, discordUsername: discordUsername || null, smsOptIn });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-1.5 sm:grid-cols-2">
          <div>
            <Label className="text-xs text-muted-foreground">Email</Label>
            <p className="text-sm">{profile.email}</p>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Social handle</Label>
            <p className="text-sm">{profile.handle}</p>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="discord">Discord username (optional)</Label>
          <Input id="discord" value={discordUsername} onChange={(e) => setDiscordUsername(e.target.value)}
            placeholder="@yourhandle — invites you to our community servers" />
        </div>
        <div className="flex items-center gap-2">
          <Switch id="sms-opt-in" checked={smsOptIn} onCheckedChange={setSmsOptIn} />
          <Label htmlFor="sms-opt-in">Text me when I receive a proposal (optional)</Label>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          {saved && <span className="text-sm text-muted-foreground">Saved.</span>}
        </div>
      </CardContent>
    </Card>
  );
}
