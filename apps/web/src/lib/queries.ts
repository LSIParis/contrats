import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api.js';

export interface Me {
  userId: string; fullName: string | null; email: string | null;
  kind: 'INTERNAL' | 'CLIENT' | null; roles: string[]; customerId: string | null;
}
export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => apiGet<Me>('/v1/auth/me'), retry: false });
}
