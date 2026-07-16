// Frontières d'accès aux données, appliquées par la machine. (§16.4-D)
//
// Ces règles ne sont pas du confort de style : ce sont des contrôles de
// sécurité. Elles transforment « sécurisé si personne n'oublie » en
// « sécurisé sauf si quelqu'un désactive une règle » — ce qui est visible
// en revue, cherchable dans le dépôt, et refusable.
//
// Elles sont BLOQUANTES en CI.

const MSG_PRISMA =
  'Accès direct à Prisma interdit ici. Toute lecture/écriture passe par withScope() ' +
  'depuis @lsi/persistence — sinon la requête s’exécute sans scope et RLS la rejette. ' +
  'Voir dossier de conception §10.3.';

const MSG_UNSAFE_CLIENT =
  'unsafeUnscopedClient contourne le scope et n’est destiné qu’aux migrations et ' +
  'aux tests du module persistence. Utiliser withScope(). Voir §10.3.';

const MSG_RAW =
  'Risque d’injection SQL : $queryRawUnsafe / $executeRawUnsafe interpolent la chaîne ' +
  'telle quelle. Utiliser les template tags paramétrés ($queryRaw / $executeRaw). Voir §13.3.';

import tseslint from 'typescript-eslint';

const noRawUnsafe = [
  {
    selector:
      "MemberExpression[property.name=/^\\$(query|execute)RawUnsafe$/]",
    message: MSG_RAW,
  },
];

export default [
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/*.d.ts'],
  },

  // ---------------------------------------------------------------------
  // Défaut : tout le dépôt. Prisma est hors limites.
  // ---------------------------------------------------------------------
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: {
      // Sans le parseur TS, les règles ci-dessous ne s'appliqueraient à AUCUN
      // fichier .ts — donc à rien. Une règle de sécurité qui ne parse pas le
      // code qu'elle protège est pire qu'absente : elle rassure à tort.
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@prisma/client', message: MSG_PRISMA },
            {
              name: '@lsi/persistence',
              importNames: ['unsafeUnscopedClient'],
              message: MSG_UNSAFE_CLIENT,
            },
          ],
          patterns: [
            {
              group: ['**/persistence/src/scoped-client*', '**/.prisma/**'],
              message: MSG_PRISMA,
            },
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...noRawUnsafe],
    },
  },

  // ---------------------------------------------------------------------
  // Exception 1 : le module persistence lui-même.
  //
  // C'est LE point d'entrée légitime vers Prisma — celui qui implémente
  // withScope(). L'exception est nommée, étroite, et justifiée.
  // ---------------------------------------------------------------------
  {
    files: ['packages/persistence/src/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // ---------------------------------------------------------------------
  // Exception 2 : les tests et fixtures de persistence.
  //
  // Les tests d'isolation DOIVENT pouvoir émettre des requêtes non scopées :
  // c'est précisément ce qu'ils vérifient. Les fixtures préparent l'état avec
  // le rôle propriétaire, hors réseau, sans entrée utilisateur.
  // ---------------------------------------------------------------------
  {
    files: ['packages/persistence/tests/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  // ---------------------------------------------------------------------
  // Le seed de démonstration : même raisonnement que les fixtures.
  // ---------------------------------------------------------------------
  {
    files: ['packages/persistence/prisma/seed.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
];
