import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api.js';
import type { ExpiringData } from '../features/dashboard/expiring.js';

export interface Me {
  userId: string; fullName: string | null; email: string | null;
  kind: 'INTERNAL' | 'CLIENT' | null; roles: string[]; customerId: string | null;
}
export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => apiGet<Me>('/v1/auth/me'), retry: false });
}

export interface Dashboard {
  countsByStatus: Record<string, number>;
  expiring: ExpiringData;
  pendingReminders: number;
}
export function useDashboard() {
  return useQuery({ queryKey: ['dashboard'], queryFn: () => apiGet<Dashboard>('/v1/dashboard') });
}
