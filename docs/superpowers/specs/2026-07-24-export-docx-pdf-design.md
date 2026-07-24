# Export DOCX + PDF des modèles et des contrats (increment)

**Date** : 2026-07-24
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : permettre de **télécharger** le corps d'un **modèle** de contrat et
d'un **contrat** réel aux formats **PDF** et **DOCX**. Le PDF réutilise le
rendu Gotenberg existant ; le DOCX ajoute un unique mécanisme (lib
HTML→DOCX). Frontend : boutons de téléchargement sur l'éditeur de modèle et la
fiche contrat.

## 1. Objectif et constat

- **PDF contrat** existe déjà : `GET /v1/contracts/:id/preview.pdf` (inline) →
  `ContentService.previewPdf` → port `DocumentRenderer` (Gotenberg, HTML→PDF/A-2b).
- **Modèles** : aucun export.
- **DOCX** : inexistant (Gotenberg ne fait que HTML→PDF).

On ajoute : l'export PDF **et** DOCX pour **modèle** et **contrat**, en
téléchargement (`Content-Disposition: attachment`). Le modèle s'exporte avec
ses `{{variables}}` littérales (contrat-type vierge) ; le contrat avec son
contenu réel.

Aucune migration.

## 2. Décisions

| Sujet | Décision |
|---|---|
| PDF | Réutilise le port `DocumentRenderer` (Gotenberg) — aucun nouveau moteur. |
| DOCX | Nouveau port `DocxRenderer` (`renderDocx(html: string, title: string): Promise<Buffer>`) + adaptateur `HtmlToDocxRenderer` basé sur **`@turbodocx/html-to-docx`** (HTML→DOCX, pur JS, maintenue). **Unique nouvelle dépendance** (`apps/api`). |
| Source HTML | Partagée entre PDF et DOCX. `ContentService` (contrat : `currentVersion.bodyHtml` + `title`) et `TemplatesService` (modèle : `currentVersion.bodyHtml` + `name`). Le HTML est déjà sanitisé en base. |
| Contenu exporté | La **version courante** uniquement (pas de sélection de version historique). Le modèle conserve ses `{{variables}}`. |
| Rôles | Modèle : `assertRole(['MSP_ADMIN','LEGAL_REVIEWER'])` (comme toutes les routes modèle). Contrat : scope/RLS seulement (comme `preview.pdf` — hors scope → 404). |
| Nom de fichier | Slugifié depuis le nom du modèle / titre du contrat (ASCII, sans caractères spéciaux ni retour à la ligne → pas d'injection d'en-tête). Extension `.pdf` / `.docx`. |
| Aperçu vs export | `preview.pdf` (inline) reste pour l'aperçu ; les nouvelles routes `export.pdf` / `export.docx` forcent le **téléchargement** (`attachment`). |
| Fidélité | PDF fidèle (Chromium). DOCX : titres/gras/italique/barré/listes/citations couverts ; mise en page fine moins fidèle (attendu pour un format éditable). |

## 3. Backend

### 3.1 Port + adaptateur DOCX (`apps/api/src/documents/`)
- `docx-renderer.port.ts` : `export const DOCX_RENDERER = Symbol('DOCX_RENDERER')` + `interface DocxRenderer { renderDocx(html: string, title: string): Promise<Buffer> }`.
- `html-to-docx.renderer.ts` : `HtmlToDocxRenderer implements DocxRenderer` — enveloppe le HTML (même style de base que `GotenbergRenderer.wrap` : titre, police serif) et appelle `@turbodocx/html-to-docx`. L'import exact et le type de retour (Buffer/ArrayBuffer) sont **vérifiés par l'implémenteur** contre la lib installée (compile-run-fix) ; convertir en `Buffer` si nécessaire.
- Câblage `app.module.ts` : `{ provide: DOCX_RENDERER, useClass: HtmlToDocxRenderer }`.

### 3.2 Services (source HTML + rendu)
- `ContentService` : injecter `DOCX_RENDERER` (a déjà `DOCUMENT_RENDERER`). Factoriser l'accès `{ html, title }` de la version courante (méthode privée) réutilisée par `previewPdf` (inchangé), `exportPdf` (identique à preview) et `exportDocx` (nouveau, via `DOCX_RENDERER`).
- `TemplatesService` : injecter `DOCUMENT_RENDERER` + `DOCX_RENDERER`. Ajouter `exportPdf(scope, id): Buffer` et `exportDocx(scope, id): Buffer` qui chargent `{ html: currentVersion.bodyHtml, title: name }` (404 hors scope ; 422 si aucune version / corps vide) et appellent le port correspondant.

### 3.3 Endpoints (téléchargement)
- `ContentController` (`v1/contracts`) : `GET :id/export.pdf`, `GET :id/export.docx` → `res` avec `Content-Type` adapté + `Content-Disposition: attachment; filename="<slug>.<ext>"`. Scope/RLS (pas d'`assertRole`, comme `preview.pdf`).
- `TemplatesController` (`v1/templates`) : `GET :id/export.pdf`, `GET :id/export.docx` → idem, avec `assertRole(['MSP_ADMIN','LEGAL_REVIEWER'])`.
- Content-Type : `application/pdf` ; `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (DOCX).
- La méthode de service lève AVANT d'écrire dans `res` (404/422) → le filtre d'exception répond normalement (motif identique à `preview.pdf`).

## 4. Frontend

Liens ancre (la session cookie passe automatiquement, comme l'« Aperçu PDF » existant — cf. `contract-edit-page.tsx` `window.open('/v1/contracts/:id/preview.pdf')` et `contract-detail-page.tsx` `<a href=… preview.pdf>`).

- **Éditeur de modèle** (`template-detail-page.tsx`) : dans la carte « Contenu », **Télécharger PDF** (`/v1/templates/:id/export.pdf`) + **Télécharger DOCX** (`/v1/templates/:id/export.docx`), visibles si `currentVersion` existe.
- **Fiche contrat** (`contract-detail-page.tsx`) : à côté de l'« Aperçu PDF », **Télécharger PDF** + **Télécharger DOCX** (`/v1/contracts/:id/export.pdf|docx`), visibles si `currentVersionId`.

Boutons/`<a>` avec `download` (ou `target="_blank" rel="noopener"`).

## 5. Sécurité et tests

- **Sécurité** : rôles ci-dessus ; HTML déjà sanitisé (PDF & DOCX partent de contenu assaini) ; Gotenberg sandboxé (inchangé) ; nom de fichier slugifié (ASCII, pas de `"`/`\r`/`\n` → pas d'injection dans l'en-tête `Content-Disposition`).
- **Tests API** (isolation ; `DOCX_RENDERER` overridé par un faux renderer déterministe renvoyant un petit Buffer reconnaissable, comme le `FakeRenderer` PDF existant — pas de dépendance à la vraie lib dans les tests d'isolation) :
  - Modèle : `export.pdf` / `export.docx` → **200**, `Content-Type` correct, `Content-Disposition: attachment` avec un nom de fichier slugifié ; **403** hors MSP_ADMIN/LEGAL_REVIEWER ; **404** hors scope ; **422** si aucune version / corps vide.
  - Contrat : `export.pdf` / `export.docx` → **200** + en-têtes ; **404** hors scope.
  - Le corps renvoyé provient bien du renderer (faux) → prouve le câblage.
- **Test unitaire** (optionnel mais recommandé) : `HtmlToDocxRenderer.renderDocx('<h1>x</h1>', 'T')` renvoie un Buffer **non vide commençant par la signature ZIP `PK\x03\x04`** (un .docx est un zip) — exerce la vraie lib une fois, prouve un DOCX valide.
- **Front** : boutons présents (modèle & contrat) pointant vers les bonnes URLs ; suite web verte ; typecheck + build verts.
- **Gates CI** : `pnpm lint && pnpm typecheck` (repo-wide) avant merge.

## 6. Non-objectifs (différés)

- Styles avancés / images / tableaux riches dans le DOCX ; en-tête & pied de page.
- Export d'une **version historique** précise (on exporte la version courante).
- Instanciation d'un contrat **depuis** un modèle.
- Test d'intégration contre le vrai conteneur Gotenberg (dette existante W-07, hors périmètre).
