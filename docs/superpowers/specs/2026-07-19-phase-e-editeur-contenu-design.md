# Phase E — Éditeur de contenu (§6.4, incrément minimal)

**Date** : 2026-07-19
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : donner à un contrat un **corps rédigé** (WYSIWYG), enregistré comme
**versions immuables**, avec **aperçu PDF** via la vraie chaîne de rendu. C'est
le prérequis du workflow de validation (incrément suivant) : on ne peut relire
et approuver que du contenu réel (RM-11).

## 1. Objectif

Aujourd'hui un contrat n'a que des métadonnées. Le workflow de validation exige
une **version** (RM-11 : la validation est liée à une version), et une version
exige un `bodyHtml`. Cet incrément fournit donc l'édition de contenu : rédiger
le corps du contrat, l'enregistrer en versions numérotées et immuables, et en
obtenir un aperçu PDF fidèle (§6.4 : « un aperçu qui ment est pire que pas
d'aperçu » — même chaîne de rendu que la génération finale).

Non-objectifs : modèles/templates (§6.3), variables de template, comparaison et
restauration de versions (§6.5), et le workflow de validation lui-même
(soumettre/approuver — incrément suivant, qui s'appuiera sur ces versions).

## 2. Décisions d'architecture

| Sujet | Décision |
|---|---|
| Éditeur | **WYSIWYG TipTap** (`@tiptap/react` + `@tiptap/starter-kit`) — gras/italique/titres/listes, adapté à une utilisatrice non technique, produit du HTML propre. |
| Versions | Chaque enregistrement crée une `ContractVersion` (numéro incrémenté, `bodyHtml`, `variables = {}`), immuable ; `contract.currentVersionId` pointe la dernière. |
| Édition autorisée | Uniquement si le contrat est **éditable** (DRAFT / CHANGES_REQUESTED — RM-04). Le domaine `isEditable(status)` tranche. |
| Assainissement | `bodyHtml` est **assaini côté serveur** à l'enregistrement (allowlist alignée sur les capacités de l'éditeur) avant persistance. |
| Aperçu PDF | `GET …/preview.pdf` rend la version courante via `DocumentRenderer` (Gotenberg, la même chaîne que l'envoi en signature), streamé en `application/pdf`, sans stockage. |

## 3. Structure de code

**API**
- `apps/api/src/contracts/content.service.ts` — `saveContent`, `listVersions`, `getVersion`, `previewPdf`.
- `apps/api/src/contracts/content.controller.ts` — les 4 routes (`@Controller('v1/contracts')`).
- `apps/api/src/contracts/dto/save-content.dto.ts`.
- `apps/api/src/documents/html-sanitizer.ts` — assainissement allowlist (via `sanitize-html`).
- `apps/api/src/app.module.ts` — enregistrement.
- Dépendance : `sanitize-html` (+ `@types/sanitize-html`).

**Front (`apps/web`)**
- `apps/web/src/features/contracts/{contract-edit-page.tsx, content-editor.tsx, versions-page.tsx}`
- `apps/web/src/features/contracts/contract-detail-page.tsx` (modif : bloc « Contenu »)
- `apps/web/src/app.tsx` (routes `/contracts/:id/edit`, `/contracts/:id/versions`)
- Dépendances : `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/pm`.

## 4. Ajouts d'API

Tous scopés par le `ScopeGuard`, testés isolation + IDOR. **404** (jamais 403)
hors scope ; **403** rôle insuffisant ; **409/422** transition/édition invalide.

### 4.1 `PUT /v1/contracts/:id/content` *(MSP_ADMIN, ACCOUNT_MANAGER)*
Corps (`SaveContentDto`) : `bodyHtml` (obligatoire), `changeSummary?`.
- Charge le contrat dans le scope (404 hors scope). Refuse si le statut n'est
  pas éditable (DRAFT/CHANGES_REQUESTED) → **409** (code métier).
- **Assainit** `bodyHtml` (allowlist).
- Crée une `ContractVersion` : `versionNumber = (max existant) + 1`,
  `bodyHtml` assaini, `variables = {}`, `changeSummary`, `createdByUserId = scope.userId`.
- Met à jour `contract.currentVersionId`.
- Renvoie `{ id, versionNumber }`.

### 4.2 `GET /v1/contracts/:id/versions`
`{ items: [{ id, versionNumber, changeSummary, createdAt }] }`, plus récent
d'abord. Scopé.

### 4.3 `GET /v1/contracts/:id/versions/:versionId`
`{ id, versionNumber, bodyHtml, createdAt }`. **404** si le contrat ou la
version est hors scope.

### 4.4 `GET /v1/contracts/:id/preview.pdf` *(scopé)*
Rend la **version courante** (`contract.currentVersionId`) via
`DocumentRenderer.render({ html: version.bodyHtml, documentTitle: contract.title })`
et renvoie le PDF (`Content-Type: application/pdf`). **422** si le contrat n'a
pas de version courante. Aucun stockage (aperçu éphémère).

## 5. Écrans

### 5.1 `/contracts/:id` (fiche, modifiée)
Nouveau bloc **« Contenu »** : aperçu HTML en lecture seule de la version
courante (ou « Aucun contenu rédigé »), nombre de versions, boutons
**[Éditer le contenu]** (si éditable + rôle), **[Aperçu PDF]** (si version
présente), lien **[Historique]**.

### 5.2 `/contracts/:id/edit`
Éditeur **WYSIWYG TipTap** chargé avec le `bodyHtml` de la version courante
(vide si aucune). Barre d'outils : gras, italique, titre, liste. Champ
**« Résumé des modifications »** (optionnel). **[Enregistrer]** → PUT content
(nouvelle version) → retour fiche. **[Aperçu PDF]**. Accessible seulement si
statut éditable + rôle ; sinon message et retour.

### 5.3 `/contracts/:id/versions`
Historique : table (numéro, résumé, date), clic → contenu d'une version en
**lecture seule** (le HTML rendu). Pas de restauration ni de comparaison dans
cet incrément.

Mutations via TanStack Query `useMutation` ; au succès, invalidation de
`['contract', id]` et `['versions', id]`. Français, erreurs API inline.

## 6. Sécurité

- Édition **scopée + gardée par rôle + limitée au statut éditable** (RM-04) ;
  tests IDOR (l'AM de A ne peut pas éditer/lire les versions du contrat de B).
- **Assainissement HTML à la source** : `bodyHtml` est une entrée utilisateur
  rendue par un Chromium (Gotenberg). Le rendu est déjà sandboxé (allow-list
  `file:///tmp` uniquement, aucun accès réseau), mais on assainit aussi à
  l'enregistrement — allowlist de balises/attributs alignée sur l'éditeur
  (titres, gras, italique, listes, paragraphes, liens), scripts et handlers
  retirés.
- **Versions immuables** : jamais `UPDATE` ni `DELETE` (§6.5) — chaque
  enregistrement est une nouvelle ligne.
- L'aperçu streame le PDF sans le stocker ; scopé (404 hors scope, 422 sans
  version).

## 7. Tests

- **API** :
  - `saveContent` crée une version (numéro 1 puis 2), pose `currentVersionId`,
    et un `<script>` injecté est **retiré** par l'assainissement.
  - édition refusée si le statut n'est pas éditable → 409.
  - `versions` liste + `versions/:id` lecture : scopés, IDOR (contrat de B → 404).
  - `preview.pdf` : via un **`FakeRenderer`** (override `DOCUMENT_RENDERER`,
    comme `send-for-signature.test.ts`), renvoie un PDF et `renderer.lastHtml`
    contient le `bodyHtml` de la version ; 422 sans version.
  - rôle insuffisant sur `PUT content` → 403.
- **SPA** : test composant de l'éditeur (charge le `bodyHtml`, [Enregistrer]
  appelle `PUT …/content` avec le HTML courant, navigation au succès) + rendu
  de l'historique. TipTap est monté en jsdom ; si le rendu ProseMirror complet
  est instable en jsdom, tester le conteneur `ContentEditor` autour d'un éditeur
  simulé (le composant expose `onChange(html)` et le bouton d'enregistrement),
  et couvrir la logique de sauvegarde/navigation sans dépendre du moteur TipTap.

## 8. Déploiement

**Aucune migration** (`contract_versions` existe déjà). Gotenberg est déjà dans
la stack (l'aperçu l'utilise). Dépendances ajoutées : `sanitize-html` (API),
`@tiptap/*` (front). Même image, même stack Portainer. La CI (`lint` +
`typecheck` + `test`) couvre API et front.
