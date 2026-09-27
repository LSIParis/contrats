# Restitution — Application « Contrats » v2

> Brief : « Application Contrats — Propositions commerciales et cycle de vie des contrats clients »
> (7 exigences, lots 0 à 9). Dépôt `LSIParis/contrats` (privé), branche `feat/brief-contrats-v2`,
> non poussée sur `main` : fusion par pull request après relecture.
> Date : 2026-09-27.

## 1. Synthèse

Le dépôt existant (NestJS, Prisma, React) a été **étendu** plutôt que réécrit (décision validée) :
passage de l'API sur **Fastify**, puis lots 0 à 9 livrés dans l'ordre du brief, chacun en commits
conventionnels, tests d'abord, migrations **additives** uniquement (17 à 33), lint, typecheck et
tests verts avant chaque commit.

| Lot | Contenu | État |
|---|---|---|
| 0 | Socle : Fastify, rôles et matrice de permissions, drapeaux et paramètres par tenant, RLS, audit chaîné, stockage, worker, `/healthz` `/readyz` | livré |
| 1 | Clients, import des contrats existants (OCR, extraction locale, validation côte à côte), échéancier | livré |
| 2 | Contrats types, bibliothèque de clauses, contenu structuré, variables typées, annexes, avenants, négociation, acceptation, machine à états v2 | livré |
| 3 | Moteur de tarification `@lsi/pricing` (règles, formules, indices, dérogations à double validation, `priceAt`, simulateur) | livré |
| 4 | Signature DocuSeal Pro (PDF figé, ordre, remise e-mail ou intégrée, preuves, réconciliation, disponibilité effective) | livré |
| 5 | Reconduction tacite, renouvellement exprès, résiliation calculée, courrier, retrait ; webhooks sortants signés | livré |
| 6 | IA par tenant (Perplexity par défaut, Claude), pseudonymisation, budget, journal d'usage, extraction assistée | livré |
| 7 | API publique `/api/v1`, OpenAPI 3.1, documentation, client TypeScript généré | livré |
| 8 | Publication GHCR, stack Portainer, sauvegardes, `pnpm seed` | livré — **publication bloquée par deux décisions (§5)** |
| 9 | Propositions commerciales 9.1 à 9.9, seed de l'annexe C | livré |

Interface : tous les écrans des lots 1 à 9 (contrats, contenu structuré, IA, négociation, signature,
cycle de vie, tarification, paramètres, API, webhooks, propositions, pilotage). **Vérifiés par tests
uniquement** : aucun parcours n'a encore été fait dans un navigateur (§6).

## 2. Chiffres

| Paquet | Tests |
|---|---|
| `packages/domain` | 1 074 |
| `packages/pricing` | 172 |
| `packages/persistence` (isolation RLS, seeds) | 179 |
| `packages/contrats-client` | 4 |
| `apps/api` (dont isolation, structurels, bout en bout) | 890 |
| `apps/web` | 319 |
| **Total** | **2 638** |

`pnpm lint` (0 avertissement), `pnpm typecheck`, `pnpm db:check-drift` (schéma = migrations) et
`pnpm openapi:check` (spécification et client à jour) sont verts.

## 3. Écarts au brief et modifications de fichiers fournis

- **Annexe A** : `ci.yml`, `release.yml`, `dependabot.yml` repris **à l'identique**. **`deploy.yml`
  modifié** (décision du 2026-09-27) : Portainer est en **Community Edition**, sans webhook de stack.
  Le redéploiement et le retour arrière passent par `deploy/portainer/redeploy-stack.sh` — webhook si
  `PORTAINER_WEBHOOK_ID` est défini (comportement d'origine, Business Edition), sinon **API Portainer**
  avec un jeton d'un compte dédié (`PORTAINER_API_TOKEN`, `PORTAINER_STACK_ID`). Le reste du workflow
  (tunnel SSH, test de fumée, fermeture) est inchangé. Script testé contre un faux Portainer
  (13 contrôles) et shellcheck ; `09-exploitation.md` §4.8.
- **Annexe B** (`deploy/ssh/create-deploy-key.sh`) : reprise à l'identique.
- **Annexe C** : fichiers placés sous `packages/persistence/prisma/seed/proposal-templates/` (Prisma
  vit dans ce paquet) ; `repository.ts` adapté à Prisma 5 ; tenant `lsi` (`SEED_TENANT_SLUG`) ;
  `userModifiedAt` respecté ; test « même résultat que le moteur » sur les cas de contrôle.
- API : **clé d'API hachée** plutôt qu'OAuth2 *client credentials* (choix laissé par le brief, V2-H33).
- Les hypothèses retenues sont consignées dans `docs/contrats/00-architecture.md` (V2-H1 à V2-H70).

## 4. Production (VPS Docker Legal, 51.178.30.81)

- Stack recréée à votre demande (volumes existants conservés, sauvegarde préalable
  `/home/lsi/sauvegarde-contrats-20260927`), image `2.0.0-rc.1` (lots 0 à 2), puis **intégrée à
  Portainer** (stack 116, endpoint « Docker Legal »). Mode **dégradé** tant que les secrets manquent.
- La production tourne encore sur l'image `rc.1` : **les lots 3 à 9 ne sont pas déployés**. Le
  déploiement passe par la publication GHCR (§5).
- PostgreSQL de production : **16** (volume existant). Procédure de passage à 17 :
  `09-exploitation.md` §10.

## 5. Décisions attendues de votre part

1. ~~Dépôt privé et `release.yml`~~ : **réglé** le 2026-09-27, dépôt rendu **public** (historique
   analysé par gitleaks au préalable : aucun secret ; *secret scanning* et *push protection* activés).
2. ~~Emplacement de Portainer~~ : **réglé** — serveur sur le pair WireGuard `10.99.0.1:9443` (CE
   2.45.1), agent seul sur le VPS ; tunnel par le VPS, redéploiement par l'API (§3). Reste à faire :
   compte `gha-deploy` et son jeton, clé de déploiement (`create-deploy-key.sh all --portainer
   10.99.0.1:9443 --repo LSIParis/contrats --env production`) — `09-exploitation.md` §4.8.
   **Exposition à corriger** : agent Portainer ouvert sur `0.0.0.0:9001` sans `AGENT_SECRET`,
   interface `portainer.lsi-maintenance.fr` publique (§4.1).
3. **Secrets de la stack** à renseigner dans Portainer (DocuSeal, OIDC Entra, Brevo, Wasabi,
   Perplexity/Anthropic, `COMPOSE_PROFILES=backup`), puis « redéployer » sans nouveau tirage d'image.
4. **Révoquer le jeton Portainer** apparu dans la conversation (non conservé localement).
5. **Contrats types des propositions** : la conversion d'une proposition signée exige un contrat
   type **publié** portant le slug `infogerance`, `supervision`, `rssi-externalise` ou
   `sauvegarde-en-ligne`. Aucun n'existe : à rédiger (juriste), publier, puis rattacher (écran
   d'administration des propositions). D'ici là, la conversion échoue explicitement et est retentée.
6. **CGV** à publier avant le premier envoi d'une proposition.
7. **DNS** de `contrats.lsi-maintenance.fr` (A vers `51.91.98.38`, non vers le VPS) : vérifier le
   proxy qui relaie (`09-exploitation.md` §5).

## 6. À faire valider ou tester

- **Juriste** : information Chatel (V2-H11), option `signedProposalIsContract`, libellés de
  l'acceptation par clic et du bandeau de suivi, éléments de bibliothèque marqués « à revoir »,
  durées de conservation (suivi de lecture 90 jours, journaux d'API 12 mois), prompts IA (texte
  intégral dans `05-ia-perplexity.md`).
- **Registre des traitements** : assistance IA (Perplexity, sous-traitant hors UE), suivi de lecture
  des propositions (`08-securite-rgpd.md`).
- **Recette dans un navigateur** en préproduction : parcours contrat (création → signature intégrée →
  activation → reconduction), import, tarification, proposition complète (rédaction IA → envoi →
  page publique → signature → contrat).
- **Signature intégrée** : vérifier que l'instance DocuSeal accepte d'être affichée dans un cadre
  (sinon, le lien « ouvrir dans un nouvel onglet » reste disponible).

## 7. Limites connues

- Limitation de débit de l'API publique tenue en mémoire (une seule instance, V2-H32).
- Référence des contrats issus de propositions `LSI-AAAA-P<n°>` (V2-H57).
- Pas de synchronisation du statut prospect/client avec Client Help (aucun connecteur existant).
- Paiement d'acompte : interface `PaymentProvider` seule (hors périmètre V1, brief §12.10).
- Quelques écrans affichent des identifiants (auteurs des dérogations, clés de sections et
  d'options dans le tableau de bord) faute de libellés renvoyés par l'API.
- Clients d'API et abonnements webhooks non modifiables après création (révoquer et recréer) ;
  pas de liste des liens d'accès par destinataire d'une proposition (l'historique d'envoi en tient lieu).
- Éditeur de texte des propositions en Markdown (pas de conversion HTML ↔ Markdown avec perte).

## 8. Interface

| Domaine | Écrans |
|---|---|
| Contrats | liste, création, import unitaire et par lot, validation côte à côte (dont « Compléter avec l'IA »), fiche en onglets (synthèse, contenu, annexes, tarification, signature, échéances, documents, historique) |
| Contenu | éditeur structuré `/contracts/:id/structure` (clauses, bibliothèque, variables, annexes, écarts au modèle), revue des clauses IA, bibliothèque `/library` |
| Cycle de vie | envoi au client, négociation, acceptation, signature intégrée ou par e-mail, renouvellement décidé, résiliation (date calculée, courrier, retrait), journal des transitions, rappels `/reminders` |
| Tarification | barèmes versionnés, éditeur de lignes, prix à date avec trace, simulateur, dérogations ; `/pricing` (indices, règles, devis) |
| Administration | `/settings` (drapeaux, paramètres, usage IA), `/settings/api` (clients d'API), `/settings/webhooks` |
| Propositions | `/proposals` (liste, création client ou prospect), espace de travail (éditeur par blocs, tableau de prix, destinataires, suivi temps réel, échanges, signature et contrat, réglages, IA), `/proposals/pipeline` (kanban et liste), `/proposals/dashboard`, `/proposal-admin/*` (modèles, bibliothèque, CGV, contrats types, prix à valider), page publique `/p/<jeton>` |
| Portail client | contrats, proposition et acceptation, signature intégrée |

Tous les écrans sont gardés par la matrice de permissions renvoyée par `/v1/auth/me` et testés
(Testing Library) ; la construction de production (`vite build`) est découpée en morceaux
(bibliothèques séparées).

## 9. Documentation

`docs/contrats/` : 00 architecture et hypothèses, 01 domaine, 02 cycle de vie, 03 import, 04
tarification, 05 IA, 06 DocuSeal, 07 API (guide d'intégration), 08 sécurité et RGPD, 09
exploitation, 10 charte graphique, 11 propositions. Racine : `openapi.yaml`, ce fichier.
