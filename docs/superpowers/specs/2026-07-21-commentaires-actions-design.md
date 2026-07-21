# Commentaires — actions & états (§6.10, différée B)

**Date** : 2026-07-21
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : enrichir la brique commentaires existante avec : commentaire interne
par un **TECHNICIEN**, **résolution** d'un commentaire, **bascule
INTERNAL→SHARED** (irréversible), et **édition / suppression douce tracées**.

## 1. Objectif et constat

Les commentaires (increment §6.10) sont créés/lus mais **figés** : pas de
résolution, pas de promotion d'une note interne vers le client, pas de
correction. Cet increment ajoute les actions d'état, en gardant la cloison
INTERNAL/SHARED DB-enforced par `comments_scope`.

**Migration n°13 requise** : la table `comments` a déjà `resolvedAt`,
`resolvedByUserId`, mais pas de traçage d'édition/suppression. On ajoute :
`edited_at`, `deleted_at`, `deleted_by_user_id` (tous nullables). Aucune policy
RLS à changer (`comments_scope` est au niveau ligne, indépendant des colonnes).

## 2. Décisions

| Sujet | Décision |
|---|---|
| Technicien | Peut poster un commentaire **INTERNAL uniquement** (jamais SHARED). GET interne élargi au TECHNICIAN. |
| Rôles POST | INTERNAL : `MSP_ADMIN, ACCOUNT_MANAGER, LEGAL_REVIEWER, TECHNICIAN`. SHARED : `MSP_ADMIN, ACCOUNT_MANAGER, LEGAL_REVIEWER` (TECHNICIAN → 403). |
| Résolution | `resolve`/`unresolve` (pose/efface `resolvedAt` + `resolvedByUserId`). Autorisé aux 4 rôles internes. |
| Bascule SHARED | `PATCH …/share` : INTERNAL→SHARED, **irréversible** (pas de dé-partage). 409 si déjà SHARED. Rôles SHARED-capables. |
| Édition | `PATCH …/:commentId {body}` : **auteur** (interne) **ou** MSP_ADMIN. Pose `edited_at`. Impossible sur un commentaire supprimé (409). |
| Suppression | **Douce** : `DELETE …/:commentId` pose `deleted_at` + `deleted_by_user_id` (ligne conservée). Auteur ou MSP_ADMIN. Le corps est **masqué** dans toutes les projections (« message supprimé »). |
| Périmètre | Ces actions sont **cockpit interne uniquement**. L'édition/suppression par le client de son propre message portail est différée. |

## 3. API interne (`apps/api/src/comments/`)

Sous `withScope`. 404 (RLS) si le commentaire/contrat est hors scope ; 403 si
visible mais rôle/auteur insuffisant ; 409 sur transition invalide.

- `POST /v1/contracts/:id/comments` — **rôle selon `visibility`** (voir tableau).
- `GET /v1/contracts/:id/comments` — élargi TECHNICIAN. Projection ajoute
  `resolvedAt`, `editedAt`, `deletedAt` ; `body` = `null` si `deletedAt` (masqué).
- `POST /v1/contracts/:id/comments/:commentId/resolve` — pose `resolvedAt`/`resolvedByUserId`. (4 rôles.)
- `POST /v1/contracts/:id/comments/:commentId/unresolve` — les efface.
- `PATCH /v1/contracts/:id/comments/:commentId/share` — INTERNAL→SHARED. 409 si déjà SHARED. (Trio SHARED.)
- `PATCH /v1/contracts/:id/comments/:commentId` `{ body }` — édition. Auteur/MSP_ADMIN. 403 sinon. 409 si supprimé. Pose `editedAt`.
- `DELETE /v1/contracts/:id/comments/:commentId` — suppression douce. Auteur/MSP_ADMIN. 403 sinon.

## 4. API portail (`apps/api/src/portal/`)

`listComments` (SHARED) : projection ajoute `editedAt` ; si `deletedAt`, `body`
= `null` (le portail affiche « message supprimé »). La résolution reste
**interne** (non exposée au client).

## 5. Frontend

### 5.1 Cockpit (`comments-block.tsx`)
Chaque commentaire affiche son état : « (modifié) » si `editedAt`, grisé
« Résolu » si `resolvedAt`, « message supprimé » si `deletedAt`. Actions
(gâtées via `useMe` — auteur/rôle) : **Résoudre/Rouvrir**, **Partager avec le
client** (si INTERNAL, confirmation), **Modifier** (auteur/admin, édition en
ligne), **Supprimer** (auteur/admin, confirmation). Un commentaire supprimé ne
montre plus d'actions.

### 5.2 Portail (`portal-contract-page.tsx`)
Un commentaire SHARED supprimé s'affiche « message supprimé » (grisé) ; marqueur
« (modifié) » si `editedAt`. Pas de nouvelles actions client.

## 6. Sécurité et tests

- **Rôles** : TECHNICIAN peut INTERNAL, **pas** SHARED (403) ; resolve/share/edit/delete refusés hors rôle/auteur (403) ; hors scope → 404.
- **Bascule** : INTERNAL→SHARED rend le commentaire visible du portail ; 409 si déjà SHARED ; pas de chemin SHARED→INTERNAL.
- **Suppression douce** : la ligne reste en base, mais `body` n'apparaît dans **aucune** projection (interne ni portail) ; édition d'un supprimé → 409.
- **Portail** : un commentaire SHARED supprimé → placeholder, jamais le corps ; résolution non exposée.

## 7. Non-objectifs (différés)

- Édition/suppression par le **client** de son propre message portail.
- Historique des versions d'un commentaire édité (on garde seulement `editedAt`).
- Suppression **dure** / purge.
- Fils imbriqués, mentions (abandonnés).
