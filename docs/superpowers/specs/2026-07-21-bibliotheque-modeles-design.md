# Bibliothèque de modèles de contrats (sous-projet A / increment 1)

**Date** : 2026-07-21
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : câbler le stockage des **modèles de contrat** (déjà entièrement
modélisé mais inutilisé) — catalogue par tenant, versions éditables, publication
figée (revue juridique), dépréciation — avec une API et un écran cockpit. L'aide
IA à la rédaction est un **increment 2 séparé** qui déposera son brouillon dans
l'éditeur de version de modèle défini ici.

## 1. Objectif et constat

`ContractTemplate` (catalogue : `name`, `category`, `status` DRAFT/PUBLISHED/
DEPRECATED, `currentVersionId`) et `ContractTemplateVersion` (`bodyHtml`,
`variablesSchema` Json, `isImmutable`, `publishedAt`, `publishedByUserId`,
`versionNumber`) existent, RLS en place (`… tenant AND app_actor_kind()<>'CLIENT'`),
mais **aucune API/UI ne les câble**. Le contrat référence déjà une version de
modèle figée (`Contract.templateVersionId`). On réutilise le sanitizer HTML
existant (`sanitizeContractHtml`) et le motif de versionnage de `content.service`.

Aucune migration.

## 2. Décisions

| Sujet | Décision |
|---|---|
| Rôles | `MSP_ADMIN`, `LEGAL_REVIEWER` (les modèles sont des artefacts juridiques). Les CLIENT n'y accèdent jamais (RLS + garde). |
| Cycle de version | Édition **en place** d'une version DRAFT (`isImmutable=false`). La **publication** fige la version (`isImmutable=true`, `publishedAt`, `publishedByUserId`) et passe le modèle en PUBLISHED. Éditer après publication **forke** une nouvelle version DRAFT (v+1). |
| Création | `POST` crée le modèle en DRAFT **avec une première version DRAFT vide** (l'éditeur a toujours une version courante à éditer). |
| Variables | À l'enregistrement, on **extrait** les placeholders `{{ nom }}` du `bodyHtml` et on stocke un schéma minimal dans `variablesSchema` (`{ type:'object', properties:{<nom>:{type:'string'}}, required:[…] }`). |
| Sanitisation | `bodyHtml` passe par `sanitizeContractHtml` (même défense que le contenu de contrat). |
| Publication | Refuse (400) une publication au `bodyHtml` vide. C'est la **porte de revue** : publier = valider le modèle. |
| Instanciation | « Créer un contrat depuis un modèle » n'est PAS dans cet increment (flux de création existant, à relier ensuite). |

## 3. API (`apps/api/src/templates/`)

`TemplatesController` (`@Controller('v1/templates')`) + `TemplatesService`, sous
`withScope`. `assertRole(session, ['MSP_ADMIN','LEGAL_REVIEWER'])` sur tout.

- `GET /v1/templates` → liste `{ id, name, category, status, versionCount, updatedAt }` (tri : nom).
- `GET /v1/templates/:id` → `{ id, name, category, status, currentVersion: { id, versionNumber, bodyHtml, variablesSchema, isImmutable, publishedAt } | null, versions: [{ id, versionNumber, isImmutable, publishedAt, createdAt }] }` (404 hors scope).
- `POST /v1/templates` `{ name, category }` → crée le modèle (DRAFT) + version 1 DRAFT vide ; `{ id }`.
- `PUT /v1/templates/:id/content` `{ bodyHtml }` → sanitize + extrait variables ; si la version courante est un DRAFT mutable → **maj en place**, sinon → **nouvelle version DRAFT** (v+1) ; met à jour `currentVersionId` ; `{ versionId, versionNumber }`.
- `POST /v1/templates/:id/publish` → fige la version courante + `status=PUBLISHED` ; **400** si corps vide ; `{ ok:true }`.
- `POST /v1/templates/:id/deprecate` → `status=DEPRECATED` ; `{ ok:true }`.

## 4. Frontend (`apps/web/src/features/templates/`)

- Lien nav **« Modèles »** (visible si `MSP_ADMIN` ou `LEGAL_REVIEWER`).
- **`/templates`** : tableau (nom, catégorie, statut badge, n° version courante). Bouton **Nouveau modèle** (nom + catégorie).
- **`/templates/:id`** : éditeur du corps (zone HTML, réutilise le motif d'édition existant), badge statut, liste des versions. Actions : **Enregistrer** (`PUT content`), **Publier** (figé/désactivé si déjà publié ou corps vide), **Déprécier**. Après publication, un ré-enregistrement crée visiblement une nouvelle version.

## 5. Sécurité et tests

- **API** : tout endpoint → **403** hors MSP_ADMIN/LEGAL_REVIEWER ; scopé au tenant (RLS) ; un CLIENT n'accède jamais (garde + RLS). Création → DRAFT + v1 vide ; save met à jour la variablesSchema depuis les placeholders ; publish fige (isImmutable + publishedAt) et refuse un corps vide (400) ; ré-édition après publish crée une v+1 DRAFT ; hors scope → 404.
- **Front** : lien Modèles masqué hors rôle ; liste + création ; éditeur enregistre/publie ; statut reflété.

## 6. Non-objectifs (différés)

- **Aide IA** à la rédaction (increment 2, dépose un brouillon dans cet éditeur).
- Instanciation d'un contrat **depuis** un modèle (relier le flux de création).
- Éditeur riche WYSIWYG (zone HTML suffit au MVP) ; prévisualisation PDF du modèle.
- Schéma de variables typé/avancé (au-delà de l'extraction de placeholders).
- Publication vers un **template DocuSeal** (`docusealTemplateId`).
