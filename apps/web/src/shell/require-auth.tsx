import type { ReactNode } from 'react';
import { useMe } from '../lib/queries.js';
import { Unauthorized } from '../lib/api.js';
import { Login } from './login.js';
import { Spinner } from '../ui/spinner.js';

export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isLoading) return <Spinner />;
  if (me.error instanceof Unauthorized || !me.data) return <Login />;
  return <>{children}</>;
}
