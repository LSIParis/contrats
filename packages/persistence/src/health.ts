import { unsafeUnscopedClient } from './scoped-client.js';

/** Vérifie que la base répond (readiness). N'échoue jamais : renvoie false. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await unsafeUnscopedClient.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
