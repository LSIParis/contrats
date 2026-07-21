# Archivage des contrats + recherche par client (§6.14)

**Date** : 2026-07-21
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : câbler l'archivage (le champ `archivedAt` existe mais n'est ni posé
ni filtré) — archiver/désarchiver un contrat **terminé**, l'exclure de la liste
par défaut, une vue « archivés » — et étendre la recherche `?q=` au **nom du
client**.

## 1. Objectif et constat

- **Recherche** : `GET /v1/contracts?q=` filtre déjà sur `reference` + `title`
  (sous-chaîne, insensible à la casse). On y ajoute le **nom du client**.
- **Archivage** : `Contract.archivedAt` est **conçu mais inutilisé** (RM-03 :
  « attribut orthogonal, pas un statut ») — aucun endpoint ne le pose, la liste
  ne l'exclut pas. C'est le vrai manque : désencombrer les contrats terminés
  sans toucher à leur statut.

Aucune migration (`archivedAt` existe déjà).

## 2. Décisions

| Sujet | Décision |
|---|---|
| Périmètre archive | **Statuts terminaux uniquement** : `TERMINATED, EXPIRED, CANCELLED, DECLINED, RENEWED`. Archiver un contrat vivant (409 sinon) risquerait de le masquer et de rater un renouvellement. |
| Endpoints | `POST /v1/contracts/:id/archive` (pose `archivedAt=now`) + `POST /v1/contracts/:id/unarchive` (efface). Rôles `MSP_ADMIN, ACCOUNT_MANAGER`. |
| Attribut, pas transition | L'archive est **orthogonale au statut** (le statut est inchangé) : méthode de service dédiée, pas un événement du domaine. |
| Liste par défaut | **Exclut les archivés** (`archivedAt IS NULL`). Filtre `?archived=true` → **uniquement** les archivés (`archivedAt IS NOT NULL`). |
| Idempotence | Archiver un déjà-archivé → no-op 200 ; désarchiver un non-archivé → no-op 200. |
| Recherche | `?q=` matche désormais `reference` OU `title` OU **`customer.name`** (contains, insensible). |
| Portail | Inchangé : l'archivage est une vue **interne** (le portail liste par statut client-visible, indépendamment de `archivedAt`). |
| Audit | Les POST archive/unarchive sont audités automatiquement (intercepteur §6.9 déjà en place). |

## 3. API (`apps/api/src/contracts/`)

### 3.1 `POST /v1/contracts/:id/archive` / `:id/unarchive` *(MSP_ADMIN, ACCOUNT_MANAGER)*
Méthodes `ContractsService.archive(scope, id, now)` / `unarchive(scope, id, now)`,
sous `withScope` :
- Charge le contrat (404 hors scope via RLS).
- **archive** : si `status ∉ TERMINAL` → **409** (`NOT_TERMINAL`, « seuls les
  contrats terminés peuvent être archivés »). Si déjà archivé → no-op. Sinon
  `archivedAt = now`.
- **unarchive** : `archivedAt = null` (no-op si déjà nul).
- Réponse `{ ok: true }`.

### 3.2 `GET /v1/contracts` — exclusion + filtre `archived`
- `ListContractsDto` : ajouter `archived?` (`@IsOptional`, transformé en booléen).
- Service `list` : si `archived === true` → `where.archivedAt = { not: null }` ;
  sinon → `where.archivedAt = null` (défaut, exclut les archivés).

### 3.3 `GET /v1/contracts?q=` — nom du client
Ajouter à la clause `OR` : `{ customer: { name: { contains: term, mode: 'insensitive' } } }`.

*(Le détail `GET /v1/contracts/:id` renvoie déjà la ligne complète, donc
`contract.archivedAt` est déjà exposé — aucun changement côté API.)*

## 4. Frontend

### 4.1 Fiche contrat (`contract-detail-page.tsx`)
- Typage : `Detail.contract` gagne `archivedAt: string | null`.
- Si `archivedAt` → bandeau « Archivé le … » + bouton **Désarchiver**.
- Sinon, si `status ∈ TERMINAL` → bouton **Archiver** (gâté rôle MSP_ADMIN/
  ACCOUNT_MANAGER via `useMe`). `POST` puis invalide `['contract', id]`.

### 4.2 Liste (`contracts-page.tsx`)
- Bascule **« Archivés »** (case ou onglet Actifs/Archivés) → ajoute
  `?archived=true` à la requête (clé de query incluant l'état). Par défaut,
  vue active (archivés masqués). La recherche `q` fonctionne dans les deux vues.

## 5. Sécurité et tests

- **API** : archive/unarchive → 403 hors MSP_ADMIN/ACCOUNT_MANAGER ; archiver un
  contrat non-terminal (ex. ACTIVE) → 409 ; archiver un terminal → 200 +
  `archivedAt` posé ; liste par défaut **n'inclut pas** l'archivé ;
  `?archived=true` le montre et masque les actifs ; hors scope → 404 ;
  `?q=<nomClient>` remonte les contrats du client.
- **Front** : bouton Archiver visible seulement si terminal + rôle ; bascule
  Archivés recharge la liste ; fiche montre l'état archivé.

## 6. Non-objectifs (différés)

- Recherche plein-texte (tsvector), pertinence, recherche dans le contenu des versions.
- Purge / suppression définitive d'un contrat archivé.
- Archivage en masse ; archivage automatique des contrats terminés depuis longtemps.
- Vue archivés côté portail client.
