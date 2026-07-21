# Commentaires client↔LSI (§6.10, portail increment 3)

**Date** : 2026-07-21
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : permettre au client (portail) de **commenter** un contrat (messages
SHARED, incl. « demander un renouvellement/une résiliation » en un clic) et à
LSI (cockpit) de **voir et répondre** — avec la visibilité INTERNAL/SHARED. Le
client ne crée aucun acte (H11) : une demande est un **message**.

## 1. Objectif et constat

Le portail couvre consultation + signature. Manque le canal d'échange
client↔LSI. La matrice des rôles autorise explicitement le client à
**commenter en SHARED** (§6.10, §6.15) : « le client ne rédige jamais un
*contrat* » (H11), mais peut envoyer un message.

Socle complet, **aucune migration** :
- Table `comments` (`visibility` INTERNAL/SHARED, `parentCommentId`, `resolvedAt`,
  `authorUserId`, `body`).
- **RLS `comments_scope`** : `(app_actor_kind() <> 'CLIENT' OR visibility = 'SHARED')`
  en **USING et WITH CHECK** → un CLIENT ne peut **ni lire ni écrire** un
  commentaire INTERNAL. La fuite la plus redoutée du produit est bloquée **en
  base**.
- Table `Notification` (recipientUserId, type, body, relatedContractId).

## 2. Décisions

| Sujet | Décision |
|---|---|
| Nature | Le client **commente** (SHARED). « Demander un renouvellement/résiliation » = boutons qui **pré-remplissent** un message SHARED. Aucun `RenewalRequest`/`Cancellation` créé par le client. |
| Visibilité | Choisie **à la création**. Client → toujours SHARED (serveur + RLS). Interne → INTERNAL (défaut) ou SHARED. Pas de bascule INTERNAL→SHARED ultérieure (différée). |
| Rôles interne | Poster : `MSP_ADMIN`, `ACCOUNT_MANAGER`, `LEGAL_REVIEWER` (SHARED comme INTERNAL). (TECHNICIAN INTERNAL-only → différé.) |
| Rôles client | Toute session CLIENT (CLIENT_SIGNER/CLIENT_VIEWER) peut commenter SHARED (matrice). |
| Notification | À chaque commentaire **client**, créer une `Notification` pour le `ownerUserId` du contrat (signal capté). Affichage (cloche) différé. |
| MVP | Liste **plate** (pas de fils imbriqués/résolution/mentions). |

## 3. API (`apps/api/src/comments/`)

Un `CommentsService` partagé + deux contrôleurs (portail et interne), tous sous
`withScope(session.scope, …)` — la RLS fait le tri INTERNAL/SHARED.

### 3.1 Portail *(session CLIENT, sous `/v1/portal/*`)*
- `GET /v1/portal/contracts/:id/comments` → les commentaires **visibles** (RLS →
  SHARED) : `{ id, body, author: { fullName, kind }, createdAt }` (ordre
  chronologique). 404 si le contrat est hors scope/non partagé.
- `POST /v1/portal/contracts/:id/comments` `{ body }` → crée un commentaire
  **SHARED** (`visibility='SHARED'` forcé serveur ; le WITH CHECK RLS le
  garantit aussi), `authorUserId = session.userId`. Puis crée une `Notification`
  (`type='CLIENT_COMMENT'`, `recipientUserId = contract.ownerUserId`,
  `relatedContractId = id`, body court). Réponse `{ id }`.

### 3.2 Interne *(session INTERNAL)*
- `GET /v1/contracts/:id/comments` *(rôles internes)* → commentaires visibles
  (RLS → INTERNAL + SHARED) : `{ id, body, visibility, author: { fullName }, createdAt }`.
- `POST /v1/contracts/:id/comments` `{ body, visibility: 'INTERNAL' | 'SHARED' }`
  *(assertRole MSP_ADMIN/ACCOUNT_MANAGER/LEGAL_REVIEWER)* → crée le commentaire,
  `authorUserId = session.userId`. Réponse `{ id }`.

## 4. Frontend

### 4.1 Portail (`portal-contract-page.tsx`)
Bloc **Commentaires** : liste (SHARED) — auteur (nom + « LSI » ou « Vous » selon
`kind`), date, corps. Zone de saisie + bouton **Envoyer** (`POST`). Deux boutons
rapides **« Demander un renouvellement »** / **« Demander une résiliation »** qui
**pré-remplissent** la zone (« Bonjour, je souhaite renouveler ce contrat… »).
Invalide `['portal-comments', id]`.

### 4.2 Cockpit (`contract-detail-page.tsx`)
Section **Commentaires** (rôles MSP_ADMIN/ACCOUNT_MANAGER/LEGAL_REVIEWER) :
liste (INTERNAL/SHARED distingués — badge « Interne » / « Partagé client ») +
saisie avec choix de visibilité (radio INTERNAL/SHARED). Choisir **SHARED**
affiche un avertissement « visible du client » (confirmation). Invalide
`['comments', id]`.

## 5. Sécurité et tests

- **API** : la visibilité est **DB-enforced** — test explicite : un commentaire
  INTERNAL est **invisible** au portail (une session CLIENT ne le voit pas et
  ne peut pas en créer un) ; un commentaire SHARED est visible des deux côtés ;
  IDOR (contrat d'un autre client → 404) ; le portail POST force SHARED même si
  le corps tente autre chose ; un `Notification` est créé au commentaire client.
- **Interne** : rôle insuffisant → 403 ; INTERNAL/SHARED créés selon le DTO.
- **Front** : portail n'affiche que du SHARED ; boutons rapides pré-remplissent ;
  cockpit distingue les visibilités + confirme SHARED.

## 6. Non-objectifs (différés)

- Fils imbriqués (réponses), résolution d'un fil, mentions (@collègue).
- Bascule INTERNAL→SHARED d'un commentaire existant (irréversible, §6.10).
- Cloche/centre de notifications (l'enregistrement est créé ; l'UI viendra).
- Commentaire INTERNAL par un TECHNICIAN.
- Édition/suppression d'un commentaire.
