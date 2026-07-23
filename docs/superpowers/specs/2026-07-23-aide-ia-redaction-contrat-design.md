# Aide IA à la rédaction de contrat (sous-projet B / increment 2)

**Date** : 2026-07-23
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : un bouton « Rédiger avec l'IA » dans l'éditeur de modèle. L'admin
saisit un prompt décrivant le contrat voulu ; Claude (Opus 4.8) génère un
**brouillon HTML** avec placeholders `{{variable}}` ; le brouillon **remplit
l'éditeur de version** (défini au sous-projet A) pour relecture humaine.
**Rien n'est écrit en base tant que l'utilisateur ne clique pas Enregistrer.**
Le brouillon n'est jamais publié ni envoyé automatiquement — la publication
reste la porte de revue `LEGAL_REVIEWER` existante.

## 1. Objectif et constat

Le sous-projet A a câblé la bibliothèque de modèles : `ContractTemplate` /
`ContractTemplateVersion`, l'endpoint `PUT /v1/templates/:id/content`
(sanitise via `sanitizeContractHtml`, extrait les variables `{{ nom }}` via
`extractVariables`, met à jour la version DRAFT en place), et l'éditeur
cockpit (`template-detail-page.tsx`, zone `<textarea>` du `bodyHtml`).

Ce sous-projet ajoute l'assistance IA **en amont** de cet éditeur : générer un
premier jet à partir d'un prompt en langage naturel. La sortie atterrit dans
la zone d'édition existante ; le flux d'enregistrement/publication est
inchangé.

Aucune migration (aucun nouveau champ persisté).

## 2. Décisions

| Sujet | Décision |
|---|---|
| Modèle | `claude-opus-4-8`, adaptive thinking (`{ type: 'adaptive' }`), **non-stream**, `max_tokens ≈ 16000`, `output_config.effort: 'medium'`. |
| SDK | `@anthropic-ai/sdk` (nouvelle dépendance `apps/api`). Jamais de HTTP brut / shim OpenAI. |
| Clé | `process.env.ANTHROPIC_API_KEY`, **uniquement** dans l'env de la stack Portainer. L'utilisateur la génère et la place ; sa valeur n'est jamais manipulée ici, jamais commitée (repo public). |
| Sortie structurée | `output_config.format` (json_schema) → `{ bodyHtml: string, suggestedVariables: string[] }`. Garantit la forme sans parsing fragile. |
| Source de vérité | Le serveur **re-sanitise** le `bodyHtml` (`sanitizeContractHtml`) et **ré-extrait** les variables du HTML nettoyé (`extractVariables`) — les `suggestedVariables` renvoyées au front sont celles extraites du HTML sanitisé, pas la liste brute du modèle. |
| Rôles | `MSP_ADMIN`, `LEGAL_REVIEWER` (identiques aux modèles ; les CLIENT n'y accèdent jamais). |
| Absence de clé | Endpoint → **503 « IA non configurée »** (dégradation gracieuse, calquée sur `S3Storage` vs `InMemoryStorage`). Pas de crash au démarrage. |
| Persistance | **Aucune.** L'endpoint ne crée ni ne modifie aucun `ContractTemplate(Version)`. Le brouillon existe seulement côté client jusqu'à un `PUT content` explicite. |
| Cadre juridique | System prompt : produire un **brouillon à faire valider par un juriste**, du HTML de corps de contrat uniquement. Bannière UI « Brouillon généré par IA — à valider avant publication ». Aucune auto-publication/envoi. |
| Prompt injection | Le prompt est une saisie de l'admin interne (confiance modérée). Défense : la sortie est **systématiquement sanitisée** avant d'atteindre le front ; rien n'est exécuté ; le modèle ne dispose d'aucun outil. |

## 3. Architecture — port / adaptateur (seam testable)

Calque exact du motif existant (`StoragePort` → `S3Storage` / `InMemoryStorage`,
`JobQueue` → `BullMqJobQueue` / `NoOpJobQueue`).

- **Port** `ContractDrafter` (interface) : `draft(input: { prompt: string; category?: string; context?: string }): Promise<{ bodyHtml: string; suggestedVariables: string[] }>`.
- **Adaptateur prod** `ClaudeContractDrafter` : instancie `new Anthropic()` (lit `ANTHROPIC_API_KEY` de l'env), appelle `messages.create` (Opus 4.8, adaptive thinking, `output_config.format` json_schema), retourne le HTML **brut** du modèle (la sanitisation/extraction est faite dans le service, pas l'adaptateur).
- **Adaptateur test/CI** `StubContractDrafter` : retourne un HTML fixe déterministe contenant un `<script>` (preuve de sanitisation) et des placeholders `{{ ... }}` (preuve d'extraction). Aucun appel réseau.
- **DI** (`app.module.ts`) : `useClass`/`useFactory` qui choisit l'adaptateur — `ClaudeContractDrafter` si `process.env.ANTHROPIC_API_KEY` est présent, sinon un adaptateur « non configuré » dont l'appel lève une `ServiceUnavailableException` (503). En test, le `StubContractDrafter` est fourni via un override de provider (comme les tests d'isolation existants), pour que la CI (sans clé) exerce quand même la route.

`AiDraftingService` orchestre : appelle le port, `sanitizeContractHtml`,
`extractVariables`, renvoie `{ bodyHtml: clean, suggestedVariables }`. Pas de
`withScope` (aucun accès base).

## 4. API (`apps/api/src/ai-drafting/`)

`AiDraftingController` + `AiDraftingService`. `assertRole(session, ['MSP_ADMIN','LEGAL_REVIEWER'])`.

- `POST /v1/templates/ai-draft` `{ prompt (requis, non vide, borné p.ex. 1..8000 chars), category? (enum ContractCategory ou string libre), context? (borné) }`
  → **200** `{ bodyHtml: string, suggestedVariables: string[] }`.
  - **403** hors `MSP_ADMIN`/`LEGAL_REVIEWER`.
  - **400** prompt vide/invalide (ValidationPipe + DTO `class-validator`).
  - **503** si `ANTHROPIC_API_KEY` absente (« Assistance IA non configurée »).
  - **Aucune** écriture en base.

DTO : `AiDraftDto { @IsString @IsNotEmpty @MaxLength(8000) prompt; @IsOptional @IsString category?; @IsOptional @IsString @MaxLength(4000) context? }`.

## 5. System prompt (esquisse, à figer dans le code)

Français, cadre juridique explicite. Idées directrices (le texte exact vit dans
le code) :

- Rôle : assistant de rédaction pour une PME de maintenance (LSI). Produit un
  **corps de contrat** en HTML simple (titres, paragraphes, listes) —
  **pas** de `<script>`, `<style>`, ni attributs `on*`.
- Utilise des **placeholders** `{{ nom_en_snake_case }}` pour toute donnée
  variable (nom du client, dates, montants, durée…), jamais de valeurs en dur.
- Le résultat est un **brouillon à faire valider par un juriste** : ne pas
  prétendre à une validité juridique, ne pas inventer de clauses légales
  spécifiques non demandées.
- Répond **uniquement** via le format structuré demandé.

## 6. Frontend (`apps/web/src/features/templates/template-detail-page.tsx`)

- Bouton **« Rédiger avec l'IA »** (visible dans l'éditeur, tant que la version
  courante est un DRAFT mutable).
- Ouvre un panneau : `<textarea>` prompt (+ champ contexte optionnel), bouton
  **Générer**. Pendant l'appel : état de chargement (spinner ~10–30 s).
- Au retour : **remplit la zone d'édition** (`bodyHtml`) avec le brouillon,
  affiche les `suggestedVariables`, et une **bannière disclaimer** « Brouillon
  généré par IA — à faire valider par un juriste avant publication ».
- L'utilisateur relit/édite puis clique **Enregistrer** (flux `PUT content`
  existant, inchangé) pour matérialiser la version. **La génération seule ne
  persiste rien.**
- **503** → message « Assistance IA non configurée » (clé manquante).

## 7. Sécurité et tests

- **API** (test d'isolation, `StubContractDrafter` injecté) :
  - `POST /ai-draft` par un rôle non autorisé (ACCOUNT_MANAGER) → **403**.
  - Prompt vide → **400**.
  - Réponse **200** `{ bodyHtml, suggestedVariables }` ; `bodyHtml` **ne contient plus** `<script>` (sanitisation) ; `suggestedVariables` = placeholders extraits du HTML nettoyé (triés).
  - **Non-persistance** : le nombre de `ContractTemplateVersion` du tenant est **inchangé** après un appel `ai-draft` (aucune version créée).
  - (Optionnel) un test d'unité sur `AiDraftingService` prouvant que la sanitisation/extraction s'appliquent au HTML du port.
- **Front** : bouton visible en DRAFT ; panneau prompt ; génération remplit
  l'éditeur ; bannière disclaimer présente ; Enregistrer reste requis.

## 8. Non-objectifs (différés)

- **Streaming SSE** (affichage au fil de l'eau) — increment ultérieur.
- Génération de **plusieurs variantes** / choix multi-directions.
- **Audit** de l'usage IA (qui a généré quoi, tokens consommés).
- Prompt **spécialisé avancé** par catégorie (au-delà du contexte libre).
- Instanciation d'un **contrat depuis** un modèle (déjà hors périmètre A).
- Éditeur riche WYSIWYG / prévisualisation PDF.
