## Objet

<!-- Quoi et pourquoi, en quelques lignes. Lien vers l'issue : Closes #… -->

## Type de changement

- [ ] `feat` : nouvelle fonctionnalité
- [ ] `fix` : correction
- [ ] `refactor` / `perf` / `test` / `docs` / `build` / `ci` / `chore`
- [ ] **Changement cassant** (API publique, schéma, variables de la stack), décrit ci-dessous

## Liste de contrôle

- [ ] **Tests** : écrits d'abord (TDD) ; `pnpm lint`, `pnpm typecheck` et `pnpm test:ci` au vert en local.
- [ ] **Aucun appel réseau réel** dans les tests (fixtures sous `test/fixtures/…`).
- [ ] **Migrations additives uniquement** : pas de `DROP`, pas de renommage, pas de `NOT NULL` sans valeur par défaut sur une table existante ; backfill scripté et testé si nécessaire. L'image N-1 doit pouvoir tourner sur le schéma N (retour arrière par `CONTRATS_TAG`).
- [ ] **Audit** : chaque transition d'état et chaque action sensible est tracée dans le journal d'audit.
- [ ] **Isolation multi-tenante** : nouvelles tables avec RLS et FK composites ; un test prouve qu'un tenant / client ne peut ni lire ni modifier les données d'un autre.
- [ ] **Secrets** : aucun secret, jeton, clé ou donnée client réelle dans le code, les logs, les fixtures, les réponses d'API ni cette PR ; nouvelles variables ajoutées à `.env.example` **et** `deploy/portainer/stack.env.example` (sans valeur réelle).
- [ ] **Routes** : validées (Zod) et décrites dans l'OpenAPI.
- [ ] **Documentation** `docs/contrats/` à jour.
- [ ] Titre de la PR au format Conventional Commits (il alimente `CHANGELOG.md`).

## Déploiement

<!-- Nouvelles variables de stack, ordre particulier, action manuelle dans Portainer, retour arrière possible ? -->

## Notes pour la revue
