import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { logoutStaff } from '@/lib/staffApi';
import type { StaffProfile } from '@/lib/staffApi';

function initials(name: string | null, email: string | null) {
  const trimmed = (name || '').trim();
  if (trimmed) return trimmed.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (email || '?').charAt(0).toUpperCase();
}

/**
 * Mirrors the creator/brand UserMenu.tsx — top-right avatar dropdown.
 * Staff has no editable profile fields today (role/permissions are managed
 * via /portal-admin/users, not self-serve), so there's no "Profile" item
 * here — just identity display + log out.
 */
export function UserMenu({ profile }: { profile: StaffProfile }) {
  async function logout() {
    try { await logoutStaff(); } finally { window.location.href = '/portal-admin'; }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Avatar>
          <AvatarFallback>{initials(profile.name, profile.email)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <p className="font-medium">{profile.name || profile.email || 'Team member'}</p>
          {profile.role && <p className="text-xs font-normal capitalize text-muted-foreground">{profile.role}</p>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logout}>Log out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
