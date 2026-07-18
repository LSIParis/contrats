# Phase E — Cockpit interne (frontend, incrément 1)

**Date** : 2026-07-18
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : premier incrément de la Phase E. Cockpit interne **en lecture
seule** : tableau de bord des échéances, liste des contrats, fiche contrat.
Les mutations (créer / éditer / envoyer en signature) et le portail client
sont des incréments ultérieurs.

## 1. Objectif

Rendre le back-end enfin utilisable par l'équipe interne. Jusqu'ici
l'application ne renvoie que du JSON ; personne ne peut « voir ce qui va
expirer ». C'est l'écran d'adoption de Sylvie (§6.1 du dossier) et la moitié
manquante du critère MVP : *pour tout contrat actif on peut produire en une
minute la version signée qui fait foi*.

Non-objectifs de cet incrément : toute mutation d'état, l'éditeur de contrat,
les modèles, le portail client, la recherche plein-texte avancée, l'export.

## 2. Décisions d'architecture

| Sujet | Décision |
|---|---|
| Rendu | SPA **React + Vite**, servie en **même origine** par NestJS |
| Service statique | `@nestjs/serve-static` : bundle sur toutes les routes hors `/v1/*`, repli `index.html` |
| Routage | React Router (client) |
| Données | TanStack Query + `fetch('/v1/…', { credentials: 'same-origin' })` |
| Auth | Cookie de session `__Host-` envoyé automatiquement (même origine). **401 → redirection `/v1/auth/login`** (OIDC M365). Aucun token côté client. |
| Style | Tailwind CSS + primitives **Radix** (composants copiés dans `apps/web/src/ui/`, façon shadcn/ui), thème LSI par variables CSS |
| Déploiement | Dockerfile multi-stage unique : build `apps/web` → `dist` servi par l'API. Un conteneur, une image ghcr. Rien à changer côté nginx-pm / WireGuard. |

**Invariant de sécurité conservé** : le front ne porte **aucune décision
d'autorisation** et ne détient aucun secret. Il n'affiche que ce que l'API
scopée lui renvoie. Toute la sécurité reste dans le `ScopeGuard` et RLS.

## 3. Structure de code

Nouveau workspace pnpm `apps/web` :

```
apps/web/
  index.html
  vite.config.ts            # proxy /v1 → http://localhost:3001 en dev
  tailwind.config.ts
  src/
    main.tsx                # bootstrap React + Router + QueryClient
    app.tsx                 # routes + coquille
    lib/
      api.ts                # fetch wrapper : credentials, 401 → login, erreurs
      queries.ts            # hooks TanStack Query (useMe, useDashboard, …)
    ui/                     # Button, Table, Badge, Dialog, Card… (Radix+Tailwind)
    shell/
      app-shell.tsx         # nav latérale + en-tête user
      require-auth.tsx      # garde : 401 → écran login
      login.tsx             # « Se connecter avec Microsoft 365 »
    features/
      dashboard/            # page + widgets
      contracts/            # liste + fiche + sous-blocs (signature, rappels, timeline)
    test/                   # tests composants (Vitest + Testing Library)
```

Côté API, un module `apps/api/src/read/` (ou extension des modules existants)
porte les nouveaux endpoints de lecture.

## 4. Ajouts d'API (lecture seule)

Tous scopés par le `ScopeGuard`, tous testés en isolation + IDOR. Réponses
en JSON. 404 (jamais 403) hors scope — RM-30.

### 4.1 `GET /v1/auth/me` *(nouveau)*
Identité de la session courante, pour la coquille.
```
{ userId, fullName, email, kind: 'INTERNAL'|'CLIENT', roles: RoleCode[],
  tenantId, customerId?: string }
```
Résout l'utilisateur dans le scope (nom/email depuis `users`). 401 si pas de
session.

### 4.2 `GET /v1/dashboard` *(nouveau)*
Agrégats **scopés au portefeuille** (jamais de total global — §6.1).
```
{
  countsByStatus: { DRAFT: n, PENDING_SIGNATURE: n, ACTIVE: n, EXPIRED: n, … },
  expiring: {                      // contrats ACTIVE par fenêtre d'échéance
    j90: Contract[], j60: Contract[], j30: Contract[], thisQuarter: Contract[]
  },
  pendingReminders: number,        // reminders PENDING dus/à venir dans le scope
  needsAction: Contract[]          // ex. en attente de validation, refusés
}
```
Chaque `Contract` de liste est une projection légère
(`id, reference, title, customerName, status, endDate`).

### 4.3 `GET /v1/contracts` *(existant, enrichi)*
Filtres : `status`, `search` (référence/titre), `expiringBefore` (date),
`page`, `pageSize`. Renvoie `{ items: Contract[], total, page, pageSize }`.
Le tri par défaut : échéance croissante puis mise à jour décroissante.

### 4.4 `GET /v1/contracts/:id` *(enrichi)*
La fiche complète, en une requête :
```
{ contract: {…}, customer: { id, name },
  signatureRequest?: { status, signers: [{ party, fullName, status, signedAt }] },
  reminders: [{ kind, offsetDays, dueAt, status, sentAt, late }],
  timeline: [{ at, type, label }] }     // fusion audit_logs + signature_events
}
```
404 hors scope.

### 4.5 `GET /v1/reminders` *(nouveau)*
Liste scopée des rappels, filtrable par `status`. Pour le widget et un futur
écran `/reminders`. `{ items: [{ id, contractId, contractReference, kind,
offsetDays, dueAt, status, late }], total }`.

### 4.6 `GET /v1/contracts/:id/signed-document` *(nouveau)*
Renvoie une **URL présignée** vers le PDF signé stocké en S3, via
`DocumentStorage.presignedGetUrl` après `assertKeyMatchesScope`. 404 si le
contrat est hors scope ou n'a pas de preuve capturée. Ne diffuse jamais le
binaire à travers l'API — un lien présigné à durée courte.

## 5. Écrans

### 5.1 Coquille
Nav latérale (Tableau de bord, Contrats, Rappels) + en-tête utilisateur (nom,
rôle, déconnexion → `POST` de logout puis redirection). `require-auth`
intercepte le 401 et affiche l'écran de login (bouton unique « Se connecter
avec Microsoft 365 » → `/v1/auth/login`).

### 5.2 `/dashboard`
- **Échéances** : trois colonnes/cartes J-90 / J-60 / J-30 (+ « ce trimestre »),
  chaque contrat cliquable vers sa fiche. C'est le cœur de l'écran.
- **Compteurs par statut** : cartes cliquables → `/contracts?status=…`.
- **Rappels en attente** : compteur + lien.
- Tout est strictement scopé : un account manager voit son portefeuille.

### 5.3 `/contracts`
Table filtrable (statut, recherche, « expire avant »), paginée. Colonnes :
référence, titre, client, statut (badge), échéance. Ligne → fiche.

### 5.4 `/contracts/:id`
- En-tête : référence, client, badge statut, dates (début/fin/préavis).
- **Bloc signature** : progression par signataire (envoyé / ouvert / signé /
  refusé, horodaté).
- **Rappels** : liste (J-90/60/30, statut, retard).
- **Timeline** : historique lisible (fusion audit + événements de signature).
- Bouton **« Télécharger le signé »** (visible si preuve capturée) →
  URL présignée.
- **Lecture seule** : aucune action mutante dans cet incrément.

## 6. Tests

- **API (surface de sécurité réelle)** : chaque nouvel endpoint reçoit des
  tests d'isolation et IDOR au même niveau que l'existant — deux clients aux
  portefeuilles disjoints, vérification qu'un scope ne voit jamais l'autre,
  404 hors scope. Les agrégats du dashboard sont testés pour ne compter que le
  portefeuille.
- **SPA** : tests composants (Vitest + Testing Library) sur la logique
  d'affichage — calcul/rendu des buckets d'échéance, mapping des statuts de
  signataire, état vide, état 401 → login. Pas d'e2e Playwright dans cet
  incrément.

## 7. Déploiement

Dockerfile multi-stage :
1. build `@lsi/web` (Vite) → `apps/web/dist`
2. l'étape finale copie `dist` là où `ServeStaticModule` le sert
3. l'API démarre inchangée (mêmes ports, même liaison WireGuard)

Aucune modification de la stack Portainer, de nginx-pm ni du tunnel : même
origine, même port `3001`. La CI (`lint` + `typecheck` + `test`) couvre le
nouveau workspace ; le build d'image inclut l'étape front.

## 8. Risques et parades

- **Fuite de portefeuille via un agrégat** : le dashboard calcule tout sous
  `withScope` — jamais de requête globale. Testé.
- **Cache TanStack Query traversant une déconnexion** : le `QueryClient` est
  vidé au logout et sur 401.
- **Repli SPA capturant `/v1/*`** : la config `ServeStaticModule` exclut
  explicitement `/v1` (et `/health`) du repli `index.html`.
- **Écart aperçu/rendu** : sans objet ici (pas d'éditeur PDF dans cet
  incrément).
