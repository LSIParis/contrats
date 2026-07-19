# Phase E — Mutations, incrément 1 : Clients + création de contrat

**Date** : 2026-07-19
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : premier incrément d'écriture de la Phase E. Gestion des **clients**
(créer, lister, consulter, ajouter des contacts) et **création de contrat**
(métadonnées). Débloque le suivi d'échéance de bout en bout : saisir un client
puis un contrat → les rappels se matérialisent.

## 1. Objectif

Le cockpit est en lecture seule ; la prod n'a aucun client. Or créer un contrat
exige de choisir un client, et il n'existe aucune API clients. Cet incrément
pose donc la saisie fondatrice : un client (+ contacts) puis un contrat en
métadonnées. C'est le prérequis de tout le reste (workflow, signature) et cela
sert directement le critère MVP — un contrat saisi déclenche ses rappels
(§12, EC-01 « reprise d'existant »).

Non-objectifs : l'éditeur de contenu / versions (§6.4), le workflow de
validation (soumettre/approuver), l'envoi en signature, la modification/
archivage de client, l'affectation de portefeuille par un admin, les
renouvellements/avenants. Ils viendront en incréments suivants.

## 2. Décisions d'architecture

| Sujet | Décision |
|---|---|
| Modèle d'accès | AM **et** admins créent des clients. L'AM créateur est **auto-affecté** (`customer_access`) — il voit son client immédiatement. L'admin voit tout (all_customers), pas de ligne d'accès nécessaire. |
| Création client (RLS) | La policy `customers_scope` a `WITH CHECK (app_customer_in_scope(id))` : un AM ne peut pas insérer un client dont l'id neuf n'est pas encore dans son scope (œuf/poule). La création passe donc par une fonction **SECURITY DEFINER bornée** `app_create_customer`, sous `lsi_app`, qui insère le client **et** (si AM) la ligne `customer_access` **atomiquement**. Aucun nouveau rôle bypass. |
| Reste des opérations client | Lister / consulter / ajouter un contact portent sur un client **déjà dans le scope** → `withScope()` normal, RLS active. |
| Création de contrat | L'endpoint `POST /v1/contracts` existe déjà (rôles MSP_ADMIN/ACCOUNT_MANAGER) ; on le réutilise tel quel. |
| Autorisation | Rôle via `assertRole` (→ **403** si rôle insuffisant, distinct du **404** d'existence, RM-30). Scope + RLS pour l'isolation. Le front ne porte aucune autorisation. |

## 3. Structure de code

**API**
- `packages/persistence/prisma/migrations/00000000000012_create_customer/migration.sql` — fonction `app_create_customer`.
- `packages/persistence/src/customer-write.ts` — `createCustomer(...)` (appelle la fonction via `unsafeUnscopedClient`, mappe la violation d'unicité).
- `apps/api/src/customers/customers.service.ts` + `customers.controller.ts` — endpoints clients.
- `apps/api/src/customers/dto/{create-customer.dto.ts, create-contact.dto.ts}`.
- `apps/api/src/app.module.ts` — enregistrement.

**Front (`apps/web`)**
- `apps/web/src/features/customers/{customers-page.tsx, customer-new-page.tsx, customer-detail-page.tsx, add-contact-form.tsx}`
- `apps/web/src/features/contracts/contract-new-page.tsx`
- `apps/web/src/ui/{input.tsx, select.tsx, field.tsx}` (primitives de formulaire, si absentes)
- `apps/web/src/lib/api.ts` — ajouter `apiPost<T>(path, body)` (mêmes règles : same-origin, 401 → login, erreurs).
- routes dans `apps/web/src/app.tsx` ; entrée « Clients » dans la nav.

## 4. Ajouts d'API

Tous scopés par le `ScopeGuard`, testés isolation + IDOR. **404** (jamais 403)
hors scope pour les ressources ; **403** sur rôle insuffisant ; **409** sur
conflit d'unicité.

### 4.1 `POST /v1/customers` *(MSP_ADMIN, ACCOUNT_MANAGER)*
Corps (`CreateCustomerDto`) : `name` (obligatoire), `legalName?`, `siren?`
(9 chiffres), `vatNumber?`, `addressLine1?`, `addressLine2?`, `postalCode?`,
`city?`, `country?` (2 lettres, défaut `FR`), `notes?`.
- Appelle `createCustomer` (persistence) → `app_create_customer(...)`. `grantAccess = !roles.includes('MSP_ADMIN')` (un AM est auto-affecté ; un admin non).
- SIREN dupliqué dans le tenant → **409** (`ConflictException`).
- Renvoie `{ id, name, siren, country }`.

### 4.2 `GET /v1/customers`
Liste scopée. `{ items: [{ id, name, siren, country, status, contractCount }] }`.
Triée par `name`. `contractCount` = nombre de contrats du client (dans le scope).

### 4.3 `GET /v1/customers/:id`
Fiche : `{ customer: {…}, contacts: [{ id, firstName, lastName, email, phone, jobTitle, isPrimary }] }`. **404** hors scope.

### 4.4 `POST /v1/customers/:id/contacts` *(MSP_ADMIN, ACCOUNT_MANAGER)*
Corps (`CreateContactDto`) : `firstName`, `lastName`, `email`, `phone?`,
`jobTitle?`, `isPrimary?`. Scopé (client dans le scope, sinon 404). Email
dupliqué pour ce client (`@@unique([customerId, email])`) → **409**. Renvoie le
contact créé.

### 4.5 `POST /v1/contracts` *(existant)*
Réutilisé tel quel. `CreateContractDto` : `customerId`, `title`, `type?`,
`category?`, `startDate?`, `endDate?`, `noticePeriodDays?`, `amountCents?`,
`billingFrequency?`.

## 5. Écrans

Nav : ajouter **« Clients »**.

### 5.1 `/customers`
Table (nom, SIREN, nb de contrats), triée par nom, ligne → fiche. Bouton
**[Nouveau client]** (visible pour MSP_ADMIN/ACCOUNT_MANAGER).

### 5.2 `/customers/new`
Formulaire client : nom (requis), SIREN, adresse (lignes, CP, ville), pays
(défaut FR). Optionnel : un contact principal en ligne (prénom/nom/email) — si
renseigné, créé juste après le client via `POST /:id/contacts`. Au succès →
redirection vers `/customers/:id`. Erreurs 400/409 affichées inline (SIREN déjà
utilisé).

### 5.3 `/customers/:id`
Infos client + liste des contacts. **[Ajouter un contact]** (formulaire inline
ou modale). **[Nouveau contrat pour ce client]** → `/contracts/new?customerId=…`.

### 5.4 `/contracts/new`
Sélecteur de client (depuis `GET /v1/customers` ; pré-rempli si `?customerId=`),
titre (requis), type (défaut MAIN), catégorie, date de début, date de fin,
préavis (jours), montant en euros (converti en **centimes** entiers), fréquence
de facturation. Au succès → redirection vers `/contracts/:id`. Erreurs API
affichées inline.

Mutations via TanStack Query `useMutation` ; au succès, invalidation des
requêtes de liste concernées (`['customers']`, `['contracts']`, `['dashboard']`).
Boutons de création masqués si le rôle ne les permet pas (`useMe().roles`) —
l'API reste le garde-fou.

## 6. Sécurité

- Création client via **SECURITY DEFINER borné** : n'insère qu'un client (dans
  le tenant server-résolu, jamais fourni par le client) et, si demandé, la
  ligne `customer_access` du créateur — atomiquement. Ne crée aucun rôle
  bypass ; l'invariant « exactement deux rôles hors scope » reste vrai.
- Tous les endpoints scopés + gardés par rôle. **Tests IDOR** : un AM de A ne
  peut ni lister, ni lire, ni ajouter de contact sur le client de B (404) ; sa
  liste n'expose que son portefeuille.
- Le contrôle d'unicité (SIREN, email de contact) est une **contrainte de
  base**, pas un `if` applicatif → mappée en 409.
- Le front ne porte aucune décision d'autorisation.

## 7. Tests

- **API** :
  - `POST /v1/customers` : un AM crée un client et le voit ensuite (auto-accès) ; un admin crée sans ligne d'accès et le voit (all_customers) ; SIREN dupliqué → 409 ; rôle non autorisé → 403.
  - `GET /v1/customers` et `/:id` : scopés (A ne voit pas B), 404 hors scope.
  - `POST /:id/contacts` : scopé, IDOR (contact sur le client de B → 404), email dupliqué → 409.
  - Invariant structurel inchangé (toujours deux rôles hors scope).
- **SPA** : tests composants des formulaires (validation requise, l'envoi appelle le bon endpoint avec le bon corps, navigation au succès, affichage d'une erreur API) + rendu de la liste clients.

## 8. Déploiement

Une nouvelle migration (`app_create_customer`), appliquée par le job `migrate`
one-shot au redéploiement. Aucune autre modification d'infra ; même image, même
stack Portainer. La CI (`lint` + `typecheck` + `test`) couvre API et front.
