import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { logoutBrand } from '@/lib/brandApi';
import type { Profile } from '@/lib/brandApi';

function initials(name: string | null) {
  const trimmed = (name || '').trim();
  if (!trimmed) return '?';
  return trimmed.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';
}

/**
 * Mirrors features/creator/UserMenu.tsx — top-right avatar dropdown per the
 * feedback (Profile/Financials aren't tabs). Brand-side equivalent of
 * "Financials" is Billing (Stripe payment method + invoices), since that's
 * the brand-facing money screen — there's no brand payout ledger.
 */
export function UserMenu({ profile, onSelect }: { profile: Profile; onSelect: (view: 'profile' | 'billing') => void }) {
  async function logout() {
    try { await logoutBrand(); } finally { window.location.href = '/client'; }
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
          <p className="font-medium">{profile.name || 'Your brand'}</p>
          <p className="text-xs font-normal text-muted-foreground">{profile.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onSelect('profile')}>Profile</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSelect('billing')}>Billing</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logout}>Log out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
