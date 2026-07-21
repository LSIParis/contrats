# Centre de notifications — cloche cockpit (§6.10 / §12.4, différée A)

**Date** : 2026-07-21
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : rendre **visibles** les notifications internes déjà créées en base
(message client `CLIENT_COMMENT`, rappels `REMINDER_*`) via une cloche dans
l'en-tête du cockpit, avec compteur de non-lues, panneau déroulant, marquage lu
et navigation vers le contrat lié.

## 1. Objectif et constat

Les notifications sont **déjà écrites** en base : chaque message client crée une
`Notification` pour le propriétaire du contrat (increment §6.10), et les rappels
en créent aussi (`reminder-send.service.ts`). Mais **rien ne les affiche** —
personne chez LSI ne voit qu'un client a écrit ou qu'un rappel est tombé. Cet
increment ferme la boucle côté lecture.

Socle complet, **aucune migration** :
- Table `Notification` : `recipientUserId, type (String), subject, body,
  relatedContractId, status (QUEUED/SENT/FAILED/READ), readAt, createdAt`.
- **RLS `notifications_scope`** : lecture restreinte au destinataire
  (`app_actor_kind()='SYSTEM' OR recipient_user_id = app_current_user()`) — un
  utilisateur ne lit **que sa propre boîte**, un collègue/admin non. La cloison
  est DB-enforced.

## 2. Décisions

| Sujet | Décision |
|---|---|
| Portée | **Interne (cockpit) uniquement.** Les notifications actuelles ciblent des utilisateurs internes. Pas de cloche portail dans cet increment. |
| Rôle | Tout utilisateur interne authentifié a une boîte (pas de `assertRole` spécifique — chacun lit **la sienne**, la RLS le garantit). |
| « Non-lue » | `readAt IS NULL`. Le marquage lu pose `readAt` + `status='READ'`. |
| Marquage | `PATCH /:id/read` (une) + `POST /read-all` (toutes les miennes). Idempotent. |
| Navigation | Clic sur une notif avec `relatedContractId` → marque lue puis va sur `/contracts/:id`. |
| Rafraîchissement | `refetchOnWindowFocus` + `refetchInterval` ~60 s. Pas de websocket (YAGNI). |
| Volume | Liste limitée aux ~50 dernières ; compteur non-lues exact séparé. |

## 3. API (`apps/api/src/notifications/`)

Nouveau module `NotificationsController` (`@Controller('v1/notifications')`) +
`NotificationsService`, sous `withScope(session.scope, …)`. Aucune requête ne lit
`recipientUserId` depuis l'entrée : la RLS fait le tri (destinataire courant).

### 3.1 `GET /v1/notifications`
Renvoie `{ items: Notification[], unreadCount: number }` où chaque item =
`{ id, type, subject, body, relatedContractId, status, readAt, createdAt }`,
triés `createdAt desc`, **limite 50**. `unreadCount` = nombre total de mes
notifications avec `readAt IS NULL` (compté séparément, non tronqué par la limite).

### 3.2 `PATCH /v1/notifications/:id/read`
Marque **ma** notification lue : `status='READ'`, `readAt=now`. La RLS restreint
à mes lignes → une notification qui n'est pas la mienne renvoie **404** (0 ligne
mise à jour, jamais 403). Réponse `{ ok: true }`. Idempotent (déjà lue → ok).

### 3.3 `POST /v1/notifications/read-all`
Marque toutes **mes** non-lues comme lues (`updateMany` sous scope, `readAt IS
NULL` → `status='READ'`, `readAt=now`). Réponse `{ count }`.

## 4. Frontend (`apps/web/src/features/notifications/`)

- **`NotificationBell`** monté dans `AppShell` (en-tête, à gauche du nom
  utilisateur) : icône cloche + pastille rouge avec `unreadCount` (masquée si 0).
  `useQuery(['notifications'])` avec `refetchInterval: 60000` et
  `refetchOnWindowFocus: true`.
- **Panneau déroulant** (au clic sur la cloche) : liste des notifications
  (sujet, corps court, date relative, point « non-lue »). Bouton **« Tout
  marquer lu »** (`POST /read-all` → invalide `['notifications']`).
- **Clic sur une notification** : `PATCH /:id/read` puis, si `relatedContractId`,
  navigation `/contracts/:relatedContractId` ; invalide `['notifications']`.
- Libellés FR des types dans `labels.ts` (`notificationTypeLabel` :
  `CLIENT_COMMENT` → « Message client », `REMINDER_J*` → « Rappel »,
  défaut → le `type` brut).

## 5. Sécurité et tests

- **API** : un utilisateur ne voit **que** ses notifications (RLS) — test : deux
  utilisateurs internes, chacun ne récupère que les siennes ; `unreadCount`
  correct ; `PATCH …/read` sur la notif d'un autre → 404 (pas 403) et sans effet ;
  `read-all` ne touche que les miennes ; après lecture, `unreadCount` diminue.
- **Front** : pastille masquée à 0 ; clic marque lu + navigue ; « Tout marquer
  lu » vide le compteur.

## 6. Non-objectifs (différés)

- Cloche/notifications **côté portail client**.
- Notifications temps réel (websocket/SSE) — le polling suffit.
- Préférences de notification, regroupement, pagination au-delà de 50.
- Canal e-mail des notifications `IN_APP` (les rappels e-mail existent déjà).
