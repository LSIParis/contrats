# Journal d'audit §6.9 — intercepteur générique + consultation (increment 1)

**Date** : 2026-07-21
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : peupler le journal d'audit (`audit_logs`, déjà conçu mais vide) via
un **intercepteur global** qui trace toutes les mutations authentifiées réussies,
avec une **chaîne de hash** inviolable (détectable), et un **écran cockpit**
(MSP_ADMIN) pour consulter/filtrer le journal et vérifier son intégrité.

## 1. Objectif et constat

La table `audit_logs` est entièrement conçue — chaîne de hash (`prevHash`/`hash`
Char(64)), **append-only** (REVOKE UPDATE/DELETE sur `lsi_app`, migration 4),
RLS `audit_logs_scope` (tenant + périmètre, **interdit aux CLIENT en lecture**) —
mais **rien n'écrit dedans** et il n'existe ni service ni écran. Cet increment
livre une tranche verticale : écrire **et** consulter.

## 2. Décisions

| Sujet | Décision |
|---|---|
| Écriture | **Intercepteur global** (`APP_INTERCEPTOR`) sur les méthodes mutantes (`POST/PUT/PATCH/DELETE`), **succès (2xx) uniquement**. |
| Périmètre couvert | Routes **authentifiées** (avec `req.session` → tenant) : cockpit interne + portail client. Exclut `/health` et `/v1/auth/*`. |
| Webhooks | `@Public()` (sans session) → **non couverts** par l'intercepteur générique. L'audit des événements de signature = hook sémantique dédié (increment 2). |
| before/after | `after` = **corps de requête redacté** (clés `/password|secret|token/i` masquées) ; `before` = null (un intercepteur générique ne voit pas l'état DB avant — enrichissement sémantique différé). |
| customerId | null (entrée de niveau tenant) — la dérivation par ressource viendra avec l'audit sémantique. |
| Chaîne de hash | Fonction `SECURITY DEFINER` `app_append_audit` : verrou consultatif par tenant + `sha256(prevHash ‖ payload canonique)` via `pgcrypto`. Sérialise les appends → pas de fork. |
| Fiabilité | **Best-effort après succès** : la mutation est déjà commitée quand on audite ; un échec d'écriture d'audit est **logué**, il ne casse pas l'action utilisateur. |
| Lecture | `GET /v1/audit` (filtres + pagination) + `GET /v1/audit/verify`. **MSP_ADMIN seul.** |
| Échecs | On n'audite **pas** les tentatives échouées (403/409/…) dans cet increment. |

## 3. Migration (nouvelle, n°14)

- `CREATE EXTENSION IF NOT EXISTS pgcrypto` (pour `digest`).
- **`app_append_audit(p_id, p_tenant_id, p_customer_id, p_actor_user_id,
  p_actor_kind, p_actor_ip, p_actor_user_agent, p_action, p_resource_type,
  p_resource_id, p_after jsonb, p_request_id, p_occurred_at)` → `text` (hash)** :
  1. `pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 0))` (sérialise par tenant).
  2. `SELECT hash INTO prev FROM audit_logs WHERE tenant_id=p_tenant_id ORDER BY occurred_at DESC, id DESC LIMIT 1;`
  3. `payload := coalesce(prev,'') || E'\n' || p_occurred_at::text || … || coalesce(p_after::text,'')` (concat déterministe de tous les champs sémantiques ; `before` toujours null).
  4. `new_hash := encode(digest(payload,'sha256'),'hex');`
  5. `INSERT INTO audit_logs(...) VALUES (..., before=NULL, after=p_after, prev_hash=prev, hash=new_hash);`
  6. `RETURN new_hash;`
  `SECURITY DEFINER`, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO lsi_app, lsi_webhook, lsi_scheduler`.
- **`app_verify_audit_chain(p_tenant_id) → uuid`** : recalcule la chaîne du
  tenant (même formule que l'append), renvoie l'`id` de la **première** entrée
  dont le hash recalculé diffère du stocké (ou dont `prev_hash` ne chaîne pas),
  `NULL` si intègre. Recompute en base pour garantir une canonicalisation
  identique à l'append. `SECURITY DEFINER`, mêmes GRANTs.

## 4. API (`apps/api/src/audit/`)

- **`AuditService.record(entry)`** — appelle `app_append_audit` via
  `$queryRaw` sur un client **hors** transaction requête, best-effort (try/catch
  + log). Ne lit jamais un champ acteur/tenant depuis l'entrée client : tout
  vient de la session server-résolue.
- **`AuditInterceptor`** (global) — sur méthode mutante + `req.session` présent :
  après émission d'une réponse 2xx (`tap`), construit l'entrée depuis
  `req` (méthode, `req.route.path`, `req.params`, `req.ip`, user-agent,
  `x-request-id`) + `req.session` (userId, `scope.actorKind`, tenantId) et appelle
  `record`. `resourceType` = 1er segment après `/v1/` (singularisé simplement),
  `resourceId` = `req.params.id` si UUID. Ignore `/health`, `/v1/auth/*`.
- **`GET /v1/audit`** *(MSP_ADMIN)* — filtres `resourceType?`, `resourceId?`,
  `actorUserId?`, `action?`, `from?`/`to?` ; pagination (`limit`≤100, `cursor`
  ou `offset`) ; tri `occurredAt desc`. Projection : `id, occurredAt, actorUserId,
  actorKind, action, resourceType, resourceId, requestId, hash, prevHash, after`.
- **`GET /v1/audit/verify`** *(MSP_ADMIN)* — appelle `app_verify_audit_chain`,
  renvoie `{ ok: boolean, brokenAt: string | null }`.

## 5. Frontend (`apps/web/src/features/audit/`)

- Lien nav **« Audit »** (visible si MSP_ADMIN), écran `/audit` (zone interne).
- Tableau : date, acteur, action, ressource (type + id), requestId. Filtres
  simples (resourceType, dates). Pagination.
- Bouton **« Vérifier l'intégrité »** → `GET /verify` → bandeau vert « Chaîne
  intègre » ou rouge « Rupture détectée à l'entrée … ».

## 6. Sécurité et tests

- **RLS/rôle** : `GET /v1/audit*` → 403 hors MSP_ADMIN ; un CLIENT ne lit jamais
  d'audit (RLS + garde) ; scopé au tenant.
- **Chaîne** : deux entrées consécutives chaînent (`prevHash(n)=hash(n-1)`) ;
  `verify` renvoie `ok:true` sur une chaîne saine et pointe la 1ʳᵉ entrée
  altérée sinon (test : corrompre un `hash` en base via un rôle superuser de
  test → `verify` la détecte).
- **Intercepteur** : une mutation réussie (ex. créer un commentaire) produit
  **une** entrée d'audit (acteur, action, resourceType/Id corrects) ; une lecture
  (GET) n'en produit aucune ; `/v1/auth/*` exclu ; redaction d'une clé sensible
  dans `after` ; échec d'écriture d'audit ne casse pas la requête.
- **Append concurrent** : deux appends simultanés sur le même tenant ne forkent
  pas la chaîne (sérialisés par le verrou) — test de non-régression best-effort.

## 7. Non-objectifs (différés)

- Audit **sémantique** (before/after réels, customerId par ressource) et
  couverture des **webhooks/signature** (hook dédié).
- Audit des tentatives **échouées** (403/409).
- Export (CSV/PDF), rétention/archivage, pagination infinie côté UI.
- Signature cryptographique externe / horodatage qualifié de la chaîne.
