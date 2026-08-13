import { useQuery } from '@tanstack/react-query';
import { getMe } from '@/lib/api';

/** Current identity across all three portals — see GET /api/me (dashboard-server.js). */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: getMe,
    retry: false,
    staleTime: 60_000,
  });
}
