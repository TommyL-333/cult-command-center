import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { logoutCreator } from '@/lib/creatorApi';
import type { Profile } from '@/lib/creatorApi';

function initials(name: string) {
  return name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';
}

/**
 * Top-right avatar + dropdown, replacing Profile/Financials as separate
 * tabs per your feedback. "Settings" isn't a separate menu item — Profile
 * already covers the only creator-editable settings that exist
 * (Discord username, SMS opt-in), so a distinct Settings screen would just
 * duplicate it. No "Billing" item either: creator earnings/payouts are the
 * Financials screen, and there's no separate creator-side billing concept
 * (that's a brand-side thing) — happy to add one if you mean something
 * specific by it.
 */
export function UserMenu({ profile, onSelect }: { profile: Profile; onSelect: (view: 'profile' | 'financials') => void }) {
  async function logout() {
    try { await logoutCreator(); } finally { window.location.href = '/inner-circle'; }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Avatar>
          <AvatarFallback>{initials(profile.name)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <p className="font-medium">{profile.name}</p>
          <p className="text-xs font-normal text-muted-foreground">{profile.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onSelect('profile')}>Profile</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSelect('financials')}>Financials</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logout}>Log out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
