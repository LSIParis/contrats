import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Crée un client Prisma sur l'URL donnée, donc sur le rôle PostgreSQL qu'elle
 * désigne. Prisma 7 passe par le pilote `pg` : sans délai explicite, une base
 * injoignable ferait attendre indéfiniment, alors que Prisma 6 abandonnait à 5 s.
 */
export function createPrismaClient(connectionString: string | undefined): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
  });
}
