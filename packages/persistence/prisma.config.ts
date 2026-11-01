import { defineConfig } from 'prisma/config';

// Prisma 7 ne lit plus .env tout seul ; absent en image et en CI, où l'environnement suffit.
try {
  process.loadEnvFile('.env');
} catch {
  // Pas de fichier .env.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  datasource: {
    // `prisma generate` et `prisma validate` n'ont pas besoin de base : l'image se
    // construit sans DATABASE_URL. Aucune connexion n'est tentée avec cette valeur.
    url: process.env.DATABASE_URL ?? 'postgresql://sans-base:sans-base@localhost:5432/sans-base',
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
