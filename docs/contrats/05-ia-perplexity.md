# 05 — Rédaction IA (Perplexity Agent API), pseudonymisation, extraction locale

> Spécification de la passe « brief v2 », brief §3 (étape 4), §6 et §10.
> Code : `apps/api/src/ai-drafting/*`, `packages/domain/src/pseudonymization/*`,
> `packages/domain/src/import-extraction/*`. Fixtures : `test/fixtures/{perplexity,ocr}/`.

## 1. Vue d'ensemble

```
besoin + services + clauses du contrat type (texte réel, serveur)
        │  pseudonymizeDraftInput()  ── table des jetons (reste sur le serveur)
        ▼
texte pseudonymisé ── assertNoLeak() ── refus si une donnée sensible subsiste
        │
        ▼  POST https://api.perplexity.ai/v1/agent  (web_search + fetch_url, json_schema)
réponse ── validation Zod ── rejet total si non conforme (pas de brouillon partiel)
        │  sources = search_results / fetch_url_results / annotations UNIQUEMENT
        │  URL écrites dans le texte → retirées + signalées
        ▼
reidentifyDeep() ── contrat DRAFT, origin = AI, chaque clause « générée par IA »
        ▼
validation humaine clause par clause ── puis seulement IN_REVIEW
```

Deux ports coexistent :

| Port | Rôle | Implémentations |
|---|---|---|
| `ContractDrafter.draft()` (historique) | brouillon HTML d'un **modèle** avec variables `{{…}}` | Claude, Unavailable |
| `ContractDraftingProvider` (nouveau) | rédaction **structurée** d'un contrat client : `draftStructured`, `rephraseClause`, `explainClause`, `compareClause`, `detectMissingClauses` | **Perplexity** (défaut), Claude, Unavailable |

`DraftingProviderRegistry` rend le fournisseur selon les clés présentes et la préférence du
tenant. Depuis le lot 6 il est câblé (`DRAFTING_REGISTRY`, une instance par processus) et n'est
appelé qu'à travers `AiGateway` (§16).

## 2. Contrat de l'API Perplexity — vérifié le 2026-09-26

Pages lues (versions Markdown servies par la documentation, 2026-09-26) :

- Référence OpenAPI `POST /v1/agent` : <https://docs.perplexity.ai/api-reference/agent-post>
- Quickstart Agent API : <https://docs.perplexity.ai/docs/agent-api/quickstart>
- Output Control (structured outputs, erreurs, exemple de réponse complète) : <https://docs.perplexity.ai/docs/agent-api/output-control>
- Structure the output : <https://docs.perplexity.ai/docs/agent-api/building-agents/shape-output>
- Web Search (filtres, champs de réponse) : <https://docs.perplexity.ai/docs/agent-api/tools/web-search>
- Fetch URL Content : <https://docs.perplexity.ai/docs/agent-api/tools/fetch-url-content>
- Presets : <https://docs.perplexity.ai/docs/agent-api/presets>
- FAQ (401, 429, 5xx) et Error Handling SDK : <https://docs.perplexity.ai/docs/resources/faq>, <https://docs.perplexity.ai/docs/sdk/error-handling>

**Ce qui a été vérifié :**

| Élément | Constat | Usage dans l'adaptateur |
|---|---|---|
| Point d'accès | `POST https://api.perplexity.ai/v1/agent` ; `/v1/responses` est l'alias compatible OpenAI (même comportement structuré, cf. Output Control) | `/v1/agent`, base configurable `PERPLEXITY_BASE_URL` |
| Authentification | `Authorization: Bearer <clé>` (schéma `HTTPBearer`) | `PERPLEXITY_API_KEY` |
| Corps requis | `input` (chaîne ou tableau) ; `model` requis si ni `models` ni `preset` ; `preset` requis si pas de `model` ; les deux combinables (le champ explicite surcharge le preset) | `model`/`preset` passés **à chaque appel** depuis les paramètres du tenant, aucun nom codé en dur ; refus avant réseau si aucun |
| Presets documentés | `fast`, `low`, `medium`, `high`, `xhigh`, `wide-research` | valeur de configuration tenant |
| `instructions` | « System instructions for the model » | prompt système (§4) |
| `tools` | union discriminée par `type` : `web_search` (`filters.search_domain_filter` ≤ 20 domaines, `max_results` 1–50, `search_context_size`…), `fetch_url` (`max_urls` 1–10), `function`, `mcp`… | `[{type:'web_search', filters:{search_domain_filter:[…]}}, {type:'fetch_url'}]` |
| Sortie structurée | `response_format: {type:'json_schema', json_schema:{name (1–64 alphanumériques), schema, strict?, description?}}` ; les propriétés hors `required` peuvent revenir à `null` ; la sortie respecte le schéma « sauf si la génération est coupée » | toutes les propriétés sont `required` ; `strict: true` |
| Premier appel d'un schéma | « 10 à 30 s de préparation, peut provoquer des timeouts » (Output Control) | délai 120 s au premier appel d'un schéma (empreinte SHA-256 du schéma), 60 s ensuite ; configurable |
| Autres champs utilisés | `language_preference` (ISO 639-1), `max_output_tokens` (**obligatoire** pour les modèles `anthropic/*`, sinon 400), `store` (false = non récupérable ensuite), `stream` | `fr`, 8192, `false`, `false` |
| Réponse | `ResponsesResponse` : `id`, `object:"response"`, `created_at`, `status` (`completed`, `failed`, `incomplete`, `in_progress`, `queued`, `cancelled`), `model`, `output[]`, `error`, `usage` | seul `completed` est accepté |
| Texte généré | item `output[].type = "message"`, `content[].type = "output_text"`, `text`, `annotations[]` (`url_citation` : `url`, `title`, `start_index`, `end_index`) | JSON parsé depuis le dernier message |
| Sources | item `output[].type = "search_results"` → `results[]` : `id`, `url`, `title`, `snippet`, `date`, `last_updated`, `source` ; item `fetch_url_results` → `contents[]` : `url`, `title`, `snippet` | seules sources retenues (+ annotations) |
| Consigne de la doc | « Avoid asking for links inside the JSON… Pull links from the `citations` or `search_results` items » | aucune URL dans le schéma ; URL du texte retirées |
| `usage` | `input_tokens`, `output_tokens`, `total_tokens` (requis) ; `cost` : `currency`, `input_cost`, `output_cost`, `total_cost` (requis), `cache_*_cost`, `tool_calls_cost` ; `tool_calls_details` : `{outil: {invocation}}` | `inputTokens`, `outputTokens`, `costUsd = cost.total_cost`, `toolInvocations` |
| Erreurs | corps `{error: {message, type?, code?}}` ; 400 documenté pour requête invalide ; FAQ : 401 = clé invalide/supprimée **ou crédit épuisé**, 429 = débit (seau percé, par palier), 5xx/réseau = transitoire, journaliser `X-Request-ID` | cf. §9 |

**Non documenté / hypothèses :** 422 n'apparaît pas dans la référence (seul 400) ; il est traité comme 400
par précaution. L'en-tête `Retry-After` du 429 n'est pas documenté ; il est lu s'il est présent. Le
comportement exact de `strict` n'est pas décrit ; la validation Zod locale reste la seule garantie.

L'ancienne API Sonar Chat Completions (`/chat/completions`, fin de support annoncée au 2026-09-27)
n'est **pas** utilisée. Le SDK `@perplexity-ai/perplexity_ai` non plus (hypothèse V2-H7 : `fetch`
natif, fixtures rejouables).

## 3. Ce qui est envoyé, ce qui ne l'est jamais

**Envoyé** (texte pseudonymisé uniquement) : type de contrat, description du besoin, liste des
services, clauses du contrat type de départ, clause à reformuler/expliquer/comparer, extraits de la
bibliothèque de clauses, instructions système (§4), schéma JSON (§5), liste des domaines autorisés.

**Jamais envoyé** : nom ou raison sociale du client, SIREN/SIRET, n° de TVA, adresses, e-mails,
téléphones, IBAN, noms de personnes, montants réels, la table des jetons, l'identifiant du tenant ou
de l'utilisateur, le PDF ou le texte OCR d'un contrat signé (l'extraction à l'import est **locale**,
§11), la clé Perplexity dans les archives.

Le garde-fou `assertNoLeak` est appliqué par l'adaptateur au texte **exact** qui partirait
(instructions + entrée), **avant** tout appel réseau, que l'appelant ait fourni `knownEntities` ou
non (les motifs génériques sont toujours vérifiés). Un refus lève `PseudonymizationLeakError`, dont le
message ne contient jamais la valeur fuitée.

L'envoi est désactivable par tenant (`contrats.ai.enabled = false` → fournisseur `unavailable`).

## 4. Prompts système (texte intégral)

Chaque appel envoie `instructions = BASE + "\n\n" + TÂCHE`. Source :
`apps/api/src/ai-drafting/drafting-prompts.ts` (ce texte en est extrait).

**BASE_INSTRUCTIONS (tous les appels)**

```text
Tu es un assistant de rédaction juridique pour un prestataire de services informatiques français (infogérance, maintenance, support, supervision, sauvegarde externalisée, licences, RSSI/DPO externalisé).
Tu produis des PROJETS destinés à être relus et validés par un juriste. Tu n'affirmes jamais qu'une clause est valide, suffisante ou conforme ; tu signales les points à vérifier.

Droit applicable : droit français. Appuie-toi en priorité sur des sources officielles et à jour, que tu consultes avec tes outils de recherche :
- Légifrance : Code civil (notamment formation, force obligatoire et interprétation des contrats, clauses abusives dans les contrats d'adhésion, inexécution et clause pénale), Code de commerce (notamment délais et pénalités de paiement, déséquilibre significatif, rupture brutale), Code de la consommation (notamment information sur la reconduction tacite et clauses abusives, uniquement si le client est un consommateur ou un non-professionnel) ;
- CNIL : RGPD, en particulier l'article 28 (sous-traitance de données personnelles) ;
- ANSSI : recommandations de sécurité des systèmes d'information.
Si tu n'as pas pu vérifier un point sur une source officielle, écris-le dans la justification.

Données : le texte fourni contient des jetons entre crochets ([CLIENT], [PERSONNE_1], [MONTANT_1], [SIREN_1], [ADRESSE_1], [EMAIL_1], [TEL_1]…) qui remplacent des données réelles confidentielles. Recopie-les EXACTEMENT, caractère pour caractère, là où la donnée doit apparaître. N'invente jamais de valeur réelle (nom, montant, date, numéro, adresse) et n'essaie pas de deviner ce que représente un jeton.

Forme : réponds UNIQUEMENT par un objet JSON conforme au schéma fourni, en français. N'écris AUCUNE URL, aucun lien et aucun marqueur de citation ([1], [web:1]) dans les champs texte : les sources sont collectées automatiquement à partir de tes recherches. Cite les textes par leur référence (par exemple « article 1231-5 du Code civil »).
```

**DRAFT_TASK — draftStructured**

```text
Tâche : rédige un projet de contrat complet sous forme d'une liste ORDONNÉE de clauses.
Couvre au minimum, lorsque c'est pertinent pour le type de contrat : objet, définitions, durée et renouvellement, prix et révision, conditions de paiement, niveaux de service, obligations de chaque partie, responsabilité et plafond d'indemnisation, assurance, confidentialité, données personnelles (clauses de l'article 28 du RGPD si le prestataire traite des données pour le compte du client), sécurité, sous-traitance, résiliation, réversibilité, force majeure, droit applicable et litiges.
Si des clauses de contrat type sont fournies, pars d'elles : conserve leur ordre et leur esprit, adapte-les au besoin, et indique dans la justification ce que tu as modifié et pourquoi.
riskLevel mesure le risque pour le PRESTATAIRE si la clause est acceptée telle quelle (LOW, MEDIUM, HIGH).
Dans suggestedAnnexes, propose les annexes utiles (description des services, niveaux de service, barème, plan d'assurance sécurité, accord de traitement des données…), sans les rédiger.
```

**REPHRASE_TASK.reformuler — rephraseClause(mode 'reformuler')**

```text
Tâche : reformule la clause fournie pour la rendre plus claire et plus lisible, SANS en changer la portée juridique ni l'équilibre entre les parties. Liste dans changes chaque modification apportée.
```

**REPHRASE_TASK.durcir — rephraseClause(mode 'durcir')**

```text
Tâche : renforce la clause fournie au bénéfice du PRESTATAIRE (limitation de responsabilité, délais, conditions, exclusions), en restant dans les limites de l'ordre public et des règles sur les clauses abusives et le déséquilibre significatif. Évalue dans riskLevel le risque que la clause durcie soit réputée non écrite ou contestée. Liste dans changes chaque modification apportée.
```

**EXPLAIN_TASK — explainClause**

```text
Tâche : explique la clause fournie en langage clair, pour un dirigeant de PME sans formation juridique : ce qu'elle prévoit, ce qu'elle change concrètement pour chaque partie, et les points auxquels faire attention. N'emploie pas de jargon sans l'expliquer. N'utilise pas de recherche si la clause se comprend seule.
```

**COMPARE_TASK — compareClause**

```text
Tâche : compare la clause fournie aux clauses de la bibliothèque interne fournies (chacune identifiée par un id). Désigne dans closestItemId l'id de la plus proche (chaîne vide si aucune n'est comparable), qualifie la proximité, liste les écarts de fond (pas de forme) avec leur niveau de risque pour le PRESTATAIRE, et recommande laquelle retenir ou comment les rapprocher.
```

**MISSING_TASK — detectMissingClauses**

```text
Tâche : compare les clauses du projet avec celles du contrat type fourni et avec ce que contient habituellement un contrat de ce type en droit français. Liste uniquement les clauses ABSENTES du projet (ou vidées de leur substance), avec la raison et le risque pour le PRESTATAIRE. Ne liste pas une clause présente sous un autre titre.
```

L'entrée (`input`) est un texte structuré par titres : `Type de contrat : …`, `Besoin exprimé : …`,
`Services couverts :` (liste), `Clauses du contrat type de départ :` (`### Titre (CATÉGORIE)` + texte).

Domaines autorisés pour `web_search` (`FRENCH_LEGAL_DOMAINS`, liste blanche, désactivable) :
`legifrance.gouv.fr`, `cnil.fr`, `cyber.gouv.fr`, `ssi.gouv.fr`, `service-public.fr`,
`entreprendre.service-public.fr`, `economie.gouv.fr`, `courdecassation.fr`, `conseil-etat.fr`,
`eur-lex.europa.eu`, `edpb.europa.eu`. `explainClause`, `compareClause` et `rephraseClause`
(mode `reformuler`) n'activent aucun outil : le texte fourni suffit.

## 5. Schémas JSON (texte intégral)

Source unique : les schémas Zod de `apps/api/src/ai-drafting/drafting-schemas.ts`, convertis par
`z.toJSONSchema()` (clé `$schema` retirée). Le **même** objet Zod valide la réponse.

**draftStructured** — `json_schema.name = "contract_draft_v1"`

```json
{
  "type": "object",
  "properties": {
    "clauses": {
      "minItems": 1,
      "maxItems": 60,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "description": "Intitulé court de la clause, sans numéro d’article."
          },
          "text": {
            "type": "string",
            "minLength": 1,
            "maxLength": 12000,
            "description": "Texte intégral de la clause, en français juridique, sans URL ni référence entre crochets autre que les jetons [CLIENT], [MONTANT_n]…"
          },
          "category": {
            "type": "string",
            "enum": [
              "OBJET",
              "DEFINITIONS",
              "DUREE",
              "PRIX",
              "PAIEMENT",
              "REVISION",
              "NIVEAUX_DE_SERVICE",
              "OBLIGATIONS_PRESTATAIRE",
              "OBLIGATIONS_CLIENT",
              "RESPONSABILITE",
              "ASSURANCE",
              "CONFIDENTIALITE",
              "DONNEES_PERSONNELLES",
              "SECURITE",
              "PROPRIETE_INTELLECTUELLE",
              "SOUS_TRAITANCE",
              "RESILIATION",
              "REVERSIBILITE",
              "FORCE_MAJEURE",
              "LITIGES",
              "AUTRE"
            ]
          },
          "riskLevel": {
            "type": "string",
            "enum": [
              "LOW",
              "MEDIUM",
              "HIGH"
            ],
            "description": "Risque pour le PRESTATAIRE si la clause est acceptée telle quelle."
          },
          "justification": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2000,
            "description": "Pourquoi cette clause, et sur quel texte de droit français elle s’appuie (citer l’article, jamais une URL)."
          }
        },
        "required": [
          "title",
          "text",
          "category",
          "riskLevel",
          "justification"
        ],
        "additionalProperties": false
      }
    },
    "suggestedAnnexes": {
      "maxItems": 20,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "description": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1000
          }
        },
        "required": [
          "title",
          "description"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "clauses",
    "suggestedAnnexes"
  ],
  "additionalProperties": false
}
```

**rephraseClause** — `json_schema.name = "clause_rephrase_v1"`

```json
{
  "type": "object",
  "properties": {
    "clause": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Intitulé court de la clause, sans numéro d’article."
        },
        "text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000,
          "description": "Texte intégral de la clause, en français juridique, sans URL ni référence entre crochets autre que les jetons [CLIENT], [MONTANT_n]…"
        },
        "category": {
          "type": "string",
          "enum": [
            "OBJET",
            "DEFINITIONS",
            "DUREE",
            "PRIX",
            "PAIEMENT",
            "REVISION",
            "NIVEAUX_DE_SERVICE",
            "OBLIGATIONS_PRESTATAIRE",
            "OBLIGATIONS_CLIENT",
            "RESPONSABILITE",
            "ASSURANCE",
            "CONFIDENTIALITE",
            "DONNEES_PERSONNELLES",
            "SECURITE",
            "PROPRIETE_INTELLECTUELLE",
            "SOUS_TRAITANCE",
            "RESILIATION",
            "REVERSIBILITE",
            "FORCE_MAJEURE",
            "LITIGES",
            "AUTRE"
          ]
        },
        "riskLevel": {
          "type": "string",
          "enum": [
            "LOW",
            "MEDIUM",
            "HIGH"
          ],
          "description": "Risque pour le PRESTATAIRE si la clause est acceptée telle quelle."
        },
        "justification": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2000,
          "description": "Pourquoi cette clause, et sur quel texte de droit français elle s’appuie (citer l’article, jamais une URL)."
        }
      },
      "required": [
        "title",
        "text",
        "category",
        "riskLevel",
        "justification"
      ],
      "additionalProperties": false
    },
    "changes": {
      "maxItems": 20,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 500
      },
      "description": "Liste des modifications apportées, une par élément."
    }
  },
  "required": [
    "clause",
    "changes"
  ],
  "additionalProperties": false
}
```

**explainClause** — `json_schema.name = "clause_explain_v1"`

```json
{
  "type": "object",
  "properties": {
    "summary": {
      "type": "string",
      "minLength": 1,
      "maxLength": 3000,
      "description": "Explication en langage clair, sans jargon, pour un non-juriste."
    },
    "keyPoints": {
      "maxItems": 10,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 500
      }
    },
    "pointsOfAttention": {
      "maxItems": 10,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 500
      }
    }
  },
  "required": [
    "summary",
    "keyPoints",
    "pointsOfAttention"
  ],
  "additionalProperties": false
}
```

**compareClause** — `json_schema.name = "clause_compare_v1"`

```json
{
  "type": "object",
  "properties": {
    "closestItemId": {
      "type": "string",
      "description": "Identifiant de l’élément de bibliothèque le plus proche, ou chaîne vide si aucun."
    },
    "similarity": {
      "type": "string",
      "enum": [
        "IDENTICAL",
        "EQUIVALENT",
        "DIVERGENT",
        "UNRELATED"
      ]
    },
    "differences": {
      "maxItems": 20,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "aspect": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "clause": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1000
          },
          "library": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1000
          },
          "riskLevel": {
            "type": "string",
            "enum": [
              "LOW",
              "MEDIUM",
              "HIGH"
            ]
          }
        },
        "required": [
          "aspect",
          "clause",
          "library",
          "riskLevel"
        ],
        "additionalProperties": false
      }
    },
    "recommendation": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    }
  },
  "required": [
    "closestItemId",
    "similarity",
    "differences",
    "recommendation"
  ],
  "additionalProperties": false
}
```

**detectMissingClauses** — `json_schema.name = "missing_clauses_v1"`

```json
{
  "type": "object",
  "properties": {
    "missing": {
      "maxItems": 40,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "category": {
            "type": "string",
            "enum": [
              "OBJET",
              "DEFINITIONS",
              "DUREE",
              "PRIX",
              "PAIEMENT",
              "REVISION",
              "NIVEAUX_DE_SERVICE",
              "OBLIGATIONS_PRESTATAIRE",
              "OBLIGATIONS_CLIENT",
              "RESPONSABILITE",
              "ASSURANCE",
              "CONFIDENTIALITE",
              "DONNEES_PERSONNELLES",
              "SECURITE",
              "PROPRIETE_INTELLECTUELLE",
              "SOUS_TRAITANCE",
              "RESILIATION",
              "REVERSIBILITE",
              "FORCE_MAJEURE",
              "LITIGES",
              "AUTRE"
            ]
          },
          "reason": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1000
          },
          "riskLevel": {
            "type": "string",
            "enum": [
              "LOW",
              "MEDIUM",
              "HIGH"
            ]
          }
        },
        "required": [
          "title",
          "category",
          "reason",
          "riskLevel"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "missing"
  ],
  "additionalProperties": false
}
```

`riskLevel` = risque pour le **prestataire** si la clause est acceptée telle quelle.

## 6. Pseudonymisation

`pseudonymize(text, knownEntities, {map?}) → {text, map}`, `reidentify(text, map, {escapeHtml?})`,
`findLeaks` / `assertNoLeak(text, knownEntities, {detectPatterns = true})` — fonctions pures de
`@lsi/domain`.

### 6.1 Jetons

| Jeton | Remplace | Détection |
|---|---|---|
| `[CLIENT]`, `[CLIENT_2]`… | raison sociale / nom commercial / sigle ; le 1ᵉʳ de `clientNames` rencontré devient `[CLIENT]` | entités connues |
| `[PERSONNE_n]` | noms de personnes | connues + motif « civilité + Nom » (M., Mme, Monsieur, Maître, Dr…) et « représentée par Prénom Nom » |
| `[SIREN_n]`, `[SIRET_n]` | identifiants | connus (le SIREN d'un SIRET ou d'une TVA connus est dérivé) + tout groupe isolé de 9 / 14 chiffres (espaces ou points tolérés) |
| `[TVA_n]` | TVA intracommunautaire FR | connue + motif `FR` + clé + SIREN |
| `[IBAN_n]` | IBAN | connu + motif (lettres pays + clé + groupes de 4) |
| `[EMAIL_n]` | e-mails | connus + motif |
| `[TEL_n]` | téléphones | connus (forme nationale et +33/0033) + motif français |
| `[ADRESSE_n]` | adresses | connues + motif « n° + type de voie + nom (+ CP + ville + CEDEX) » |
| `[MONTANT_n]` | montants en euros | connus (ex. en lettres) + motif : `1 250,00 €`, `1.250 EUR`, `1250 euros`, `15 k€`, `€ 1 250`, espaces insécables ; **HT/TTC restent hors du jeton** |

### 6.2 Règles et garanties

- **Ordre des passes** : e-mails → IBAN/TVA → montants → téléphones → SIRET/SIREN → adresses → noms
  connus (le plus long d'abord) → noms par civilité. L'ordre évite qu'un e-mail soit découpé par le
  nom du client, ou qu'« 125 000 000 € » soit pris pour un SIREN.
- **Tolérance** des entités connues : casse, accents (« Hélène » = « HELENE »), espaces multiples et
  retours à la ligne OCR, tiret ou espace dans les noms composés, apostrophes typographiques.
- **Bornes de mots** : « Acme » ne touche ni « Acmesoft » ni « SuperAcme ».
- **Jetons protégés** : une passe ne s'applique jamais à l'intérieur d'un jeton (un client nommé
  « Client » ne corrompt pas `[CLIENT]`).
- **Déterministe** : même entrée → même sortie (pas d'aléa, pas d'horloge) ; une requête archivée
  peut être rejouée.
- **Stable** : même valeur (même clé normalisée) → même jeton ; `map` partageable entre champs
  (`pseudonymizeDraftInput` le fait pour tout le formulaire).
- **Idempotent** : `pseudonymize(r.text, k, {map: r.map})` rend `r` inchangé.
- **Réversible** : `reidentify(pseudonymize(t).text, map) === t` quand chaque entité n'apparaît que
  sous une graphie ; deux graphies d'une même entité partagent un jeton et reviennent sous la
  première graphie rencontrée.
- **Invariant testé** : la sortie de `pseudonymize` passe toujours `assertNoLeak`.

### 6.3 Limites connues

- Montants **en lettres** (« mille deux cents euros ») non détectés par motif → à passer dans
  `knownEntities.amounts` ; montants sans devise (« 1 250 HT ») non détectés.
- Noms de personnes **sans** civilité ni « représentée par », et non fournis → non détectés.
- Adresses sans numéro ni type de voie (« Le Moulin, 12340 Bozouls »), boîtes postales → non détectées.
- Sur-pseudonymisation assumée : un « 40 € » légal devient `[MONTANT_n]` (et revient intact).
- La table des jetons est une donnée personnelle : elle reste sur le serveur, n'est jamais
  journalisée, et doit être stockée chiffrée, **séparément** de l'archive de la requête.

## 7. Validation de la réponse

1. Statut HTTP → erreurs typées (§9).
2. Enveloppe validée par Zod (souple sur les champs inconnus) ; seul `status = "completed"` est accepté
   (`incomplete` = génération coupée → rejet).
3. Texte du dernier message → `JSON.parse` (une clôture ` ```json ` est tolérée, rien d'autre).
4. Validation **stricte** par le schéma Zod de la tâche (§5). Échec → `AiSchemaViolationError` avec la
   liste des chemins en erreur, **aucun** brouillon partiel.
5. Post-traitement commun : retrait des URL et marqueurs de citation du texte (§8) ; pour
   `compareClause`, un `closestItemId` absent de la bibliothèque fournie est ramené à `""`.
6. Réidentification locale par l'appelant (`reidentifyDeep`), puis le HTML produit passe par le
   nettoyeur existant (`sanitizeContractHtml`) comme tout contenu (`reidentify(…, {escapeHtml: true})`
   si les valeurs sont injectées dans du HTML).

## 8. Politique des sources

- Une source = un élément des métadonnées de la réponse : `search_results[].results[]`,
  `fetch_url_results[].contents[]`, annotations `url_citation` du message. Dédoublonnage par URL,
  ordre d'apparition, URL `http(s)` valides uniquement, extraits tronqués à 500 caractères.
- Une URL écrite **par le modèle** (dans `text`, `justification`, `title`, annexes, explications) n'est
  **jamais** une source : elle est retirée du texte, conservée dans `clause.removedUrls` et signalée
  dans `warnings` (fixture `hallucinated-url.json`).
- Les marqueurs `[1]`, `[web:3]` sont retirés ; nos jetons `[CLIENT]`… sont préservés.
- Recherche activée mais aucune source renvoyée → avertissement « justifications non étayées ».
- Les sources sont conservées avec le projet (`AiCallResult.sources`) et affichées au relecteur.

## 9. Modes de défaillance

| Situation | Erreur typée | Réessayable | HTTP (`toHttpException`) |
|---|---|---|---|
| Aucun fournisseur / ni `model` ni `preset` / IA désactivée | `AiNotConfiguredError` | non | 503 |
| Donnée sensible détectée avant envoi | `PseudonymizationLeakError` (domaine) | non (corriger la saisie) | 503 |
| 401 / 403 (clé invalide, révoquée, crédit épuisé) | `AiAuthError` | non | 503 |
| 400 / 422 (modèle inconnu, paramètre invalide) | `AiBadRequestError` | non | 502 |
| 429 | `AiRateLimitError` (`retryAfterSeconds`) | oui, après délai | 503 |
| Délai dépassé (120 s au 1ᵉʳ appel d'un schéma, 60 s ensuite) | `AiTimeoutError` (`timeoutMs`) | oui | 504 |
| Corps non JSON, sortie non JSON, non conforme, `incomplete` | `AiSchemaViolationError` (`issues`) | oui | 502 |
| 5xx, réseau, `status = failed` | `AiUpstreamError` | oui | 503 |

Dans tous les cas : aucun contrat n'est créé, aucun brouillon partiel n'est rendu. Un échec ne marque
pas le schéma comme « préparé » : l'appel suivant garde le délai long.

## 10. Revue humaine obligatoire

- Le projet est créé en `DRAFT`, `origin = AI` ; chaque clause porte l'indicateur « générée par IA »,
  son `riskLevel`, sa `justification`, ses `removedUrls`, et les sources de l'appel.
- **Bandeau permanent** sur le projet, l'éditeur et l'aperçu : « **Projet généré par IA — à faire
  valider par un juriste** ». Il ne disparaît pas après validation des clauses (il qualifie l'origine
  du document), seulement son niveau d'alerte.
- **Validation clause par clause** : chaque clause IA doit être marquée « validée » par un utilisateur
  (identité + horodatage, tracé au journal d'audit). La transition `DRAFT → IN_REVIEW` est **refusée**
  tant qu'une clause IA n'est pas validée (garde côté domaine/API, jamais seulement côté front).
- Toute modification d'une clause validée la repasse « à valider ».
- Les clauses `HIGH` et les clauses avec `removedUrls` sont mises en tête de la liste de revue.
- Archivage pour audit : `raw.request` (texte pseudonymisé, sans clé), `raw.response`, fournisseur,
  modèle, date, utilisateur ; la table des jetons est stockée à part, chiffrée.

## 11. Extraction locale des métadonnées à l'import (brief §3.4)

`extractContractMetadata(texteOcr)` (`@lsi/domain`, pur, **aucun appel réseau**) propose, pour chaque
champ, `{value, confidence 0..1, evidence: {excerpt, offset}}` ou `null` :

| Champ | Valeur | Indices principaux |
|---|---|---|
| `prestataireRaisonSociale`, `clientRaisonSociale` | texte | bloc de partie terminé par « ci-après (dénommée) le Prestataire / Fournisseur / Mainteneur / Titulaire » ou « le Client / Bénéficiaire / Souscripteur » ; « la société X » (0,85) sinon première ligne du bloc (0,55) |
| `prestataireSiren`, `clientSiren` | 9 chiffres | SIREN / SIRET / RCS / immatriculation dans le bloc ; clé de Luhn invalide → 0,65 ; SIREN déduit d'un SIRET −0,05 |
| `dateSignature` | ISO | « Fait à X, le », « Date de signature », « Fait le », « Signé le », « en date du » ; dernière occurrence |
| `dateEffet` | ISO | « date d'effet », « prend effet le », « entre en vigueur le », « à compter du » ; « à la date de sa signature » → date de signature (≤ 0,7) |
| `dureeMois` | entier | « pour une durée (initiale/ferme) de 36 mois / trois (3) ans », « Durée : », « conclu pour » |
| `reconduction` | `TACITE` / `EXPRESSE` / `AUCUNE` | négations d'abord (« sans tacite reconduction », « ne sera pas reconduit », « prendra fin de plein droit à son terme ») ; indices contradictoires → confiance × 0,6 |
| `preavis` | `{quantite, unite: JOURS/MOIS}` | « préavis de trois (3) mois », « au moins 90 jours avant » |
| `montantMensuelHtCentimes`, `montantAnnuelHtCentimes` | centimes | montant en € dont la mention de périodicité **la plus proche** est mensuelle/annuelle ; HT → 0,9, sans mention de taxe → −0,3, TTC seul → ignoré ; capital social, pénalités, indemnité forfaitaire exclus |
| `indiceRevision` | `SYNTEC`, `ICHT`, `IPC`, `BT01`, `ILAT`, `ILC`, `PSDC` | nom de l'indice ; graphie OCR dégradée (« Syntcc ») → 0,6 ; contexte « indice/révision » +0,05 |

Dates reconnues : « 1er janvier 2024 », « 1ᵉʳ janvier 2024 », « 1 janv. 2024 », « 15 févr. 2023 »,
« 01/01/2024 », « 07.06.21 », « 2024-03-15 » ; dates impossibles rejetées. Réparation OCR à longueur
constante (les positions restent valables) : dans un « mot numérique », O→0 et l/I/|→1
(« 2O24 », « l5 mars », « 3OO,OO € ») ; « préav1s », « mensue11e » tolérés.

Fixtures : `test/fixtures/ocr/*.txt` + `*.expected.json` (5 échantillons : infogérance propre ;
maintenance à dates numériques et SIRET ; convention sans reconduction avec dates abrégées ; OCR
dégradé ; bon de commande lacunaire). Le test vérifie chaque valeur attendue et que chaque preuve est
l'extrait exact du texte à la position annoncée.

L'écran de validation côte à côte (PDF / champs) reste obligatoire : aucun contrat importé ne passe
`ACTIVE` sans validation humaine.

### 11.1 Extraction assistée par LLM (lot 6)

`POST /v1/contracts/:id/import/ai-extract` — **action explicite** d'un utilisateur (`contracts.import`),
jamais automatique dans le job OCR : l'envoi d'un document client à un sous-traitant se décide
document par document (hypothèse V2-H30).

1. Texte OCR relu depuis le stockage (60 000 caractères au plus), pseudonymisé avec les entités du
   client (raison sociale, SIREN, TVA, adresse, contacts) ; `assertNoLeak` avant l'envoi.
2. Schéma `import_extract_v1` : pour chaque champ, `{value, excerpt}` ; chaîne vide = non trouvé ;
   aucune recherche web.
3. Réponse réidentifiée, puis **interprétée strictement** (`interpretExtraction`) : une valeur n'est
   retenue que si son `excerpt` figure mot pour mot dans le texte OCR (espaces normalisés) et si elle
   se laisse analyser (date ISO, entier de mois, `TACITE/EXPRESSE/AUCUNE`, `<n> JOURS|MOIS`, montant,
   indice connu). Confiance fixe 0,6, `method: 'LLM'`.
4. Fusion : **seuls les champs encore vides** sont complétés — la saisie au dépôt et les règles
   locales priment. `extractionMethod` passe à `RULES+LLM` si au moins un champ a été ajouté.


## 12. Alternative Claude

`ClaudeContractDrafter` implémente le même port structuré via le SDK Anthropic
(`messages.parse` + `zodOutputFormat`) : **mêmes schémas Zod** (revalidés localement), **mêmes
prompts**, même garde-fou `assertNoLeak`, même nettoyage des URL. Modèle : `selection.model` du tenant,
défaut historique `claude-opus-4-8` (inchangé pour l'ancien `draft()`).

Différence : **aucune source**. Aucun outil de recherche n'est activé, et les citations natives de
l'API Anthropic sont incompatibles avec la sortie structurée (`output_config.format`) ; un
avertissement « sans recherche web » accompagne chaque résultat. Coût : non renvoyé par l'API
(`costUsd` absent) → à calculer à partir des jetons et du barème public si nécessaire.
Choisir Claude pour un tenant est explicite ; le registre ne bascule **jamais** silencieusement d'un
fournisseur à l'autre (transfert de données vers un sous-traitant non choisi).

## 13. Coût et usage par tenant

Chaque appel (réussi ou non) est journalisé dans `ai_usage` (migration 26, RLS tenant, jamais visible
d'un client, append-only : `UPDATE`/`DELETE` révoqués à `lsi_app`). **Aucun texte** n'y est stocké :

| Champ | Source |
|---|---|
| `tenantId`, `userId`, `contractId?` | contexte applicatif |
| `provider` (`perplexity`/`claude`), `model`, `preset?` | `AiCallResult.provider`, `.model`, sélection |
| `operation` (`draft`, `rephrase`, `explain`, `compare`, `missing`, `import_extract`) | appelant |
| `schemaName` | `SCHEMA_NAMES` |
| `inputTokens`, `outputTokens` | `usage` |
| `costUsd` (décimal) | `usage.cost.total_cost` (Perplexity) |
| `toolInvocations` (JSON) | `usage.tool_calls_details` |
| `status` (`OK`, `AUTH`, `RATE_LIMIT`, `TIMEOUT`, `SCHEMA_VIOLATION`, `UPSTREAM`, `LEAK_BLOCKED`) | résultat / `err.kind` |
| `durationMs`, `createdAt`, `upstreamRequestId?` | mesure / en-tête `X-Request-ID` |

Budget : plafond mensuel par tenant (paramètre `ai.monthlyBudgetUsd`, mois civil UTC, somme de
`cost_usd`) vérifié **avant** l'appel ; dépassement → `429 AI_BUDGET_EXCEEDED`, pas d'appel. Un
appel Claude (coût non communiqué) n'entre pas dans la somme : plafond à suivre par les jetons.
Synthèse : `GET /v1/admin/ai/usage?month=AAAA-MM` (`tenant.configure`).

## 14. RGPD et conformité

- Traitement « Assistance à la rédaction par IA » à inscrire au registre (§10 du brief) : finalité,
  base légale (intérêt légitime / exécution du contrat), destinataire **Perplexity AI, Inc.**
  (sous-traitant, hors UE → garanties de transfert à documenter), données : **texte pseudonymisé
  uniquement**, aucune catégorie particulière.
- `store: false` est envoyé : la réponse n'est pas récupérable ultérieurement via l'API. La politique
  de conservation du fournisseur reste à vérifier contractuellement (non documentée dans les pages lues).
- Désactivable par tenant ; mentionné dans la documentation de conformité et dans l'interface
  (bandeau + mention à côté du bouton de génération).
- Pseudonymisation ≠ anonymisation : la table des jetons permet la réidentification, elle reste sous
  la maîtrise exclusive du tenant.
- Clé `PERPLEXITY_API_KEY` en secret Docker ; rotation : nouvelle clé dans la console Perplexity →
  mise à jour du secret → redémarrage → révocation de l'ancienne.

## 15. API exposée au code applicatif

```ts
// @lsi/domain
pseudonymize(text, knownEntities?, { map? }): { text, map }
reidentify(text, map, { escapeHtml? }): string
assertNoLeak(text, knownEntities?, { detectPatterns? }): void   // lève PseudonymizationLeakError
extractContractMetadata(ocrText): ExtractedContractMetadata

// apps/api/src/ai-drafting
new DraftingProviderRegistry(env?, factories?).resolve(tenantPreferred?) : ContractDraftingProvider
provider.draftStructured({ contractType, needs, services, templateClauses?, selection?, knownEntities? })
provider.rephraseClause({ clause, mode: 'reformuler' | 'durcir', contractType?, selection?, knownEntities? })
provider.explainClause({ clause, … }) / compareClause({ clause, libraryItems, … })
provider.detectMissingClauses({ contractType, draftClauses, templateClauses, … })
pseudonymizeDraftInput(raw, knownEntities, selection?) : { input, map }
reidentifyDeep(value, map)
toHttpException(err)
```

Variables d'environnement : `PERPLEXITY_API_KEY`, `PERPLEXITY_BASE_URL` (défaut
`https://api.perplexity.ai`), `PERPLEXITY_TIMEOUT_MS` (défaut 60000),
`PERPLEXITY_FIRST_SCHEMA_TIMEOUT_MS` (défaut 120000), `ANTHROPIC_API_KEY`.

Fixtures `test/fixtures/perplexity/` (format `{status, headers, body}`, rejouées par un double de
`fetch`, aucun réseau) : `success.json`, `hallucinated-url.json`, `schema-violation.json`,
`truncated-json.json`, `error-401.json`, `error-422.json`, `error-429.json`, `timeout.json`.

## 16. Câblage applicatif (lot 6)

`AiGateway` est le point de passage **unique** vers un fournisseur :

| Étape | Règle |
|---|---|
| Drapeau | `contrats.ai.enabled` coupé → `503 AI_DISABLED`, rien ne part |
| Fournisseur | `ai.provider` du tenant (Perplexity par défaut) ; clé absente → `503`, jamais de repli vers l'autre |
| Modèle | `ai.model` / `ai.preset` du tenant, jamais codés en dur |
| Budget | §13, vérifié avant l'appel |
| Journal | une ligne `ai_usage` par appel, statut `OK` ou type d'erreur (`TIMEOUT`, `LEAK_BLOCKED`…) |
| Erreurs | `toHttpException` : 503 / 504 / 502 ; aucun brouillon partiel |

`ContractAiService` (droits `contracts.aiDraft`, portefeuille respecté par la RLS) :

| Route | Effet |
|---|---|
| `GET /v1/ai/availability` | `{enabled, provider, configured, budgetUsd, spentUsd, available}` pour l'interface |
| `POST /v1/contracts/:id/ai/draft` `{needs, services[], contractType?, mode: replace\|append}` | rédaction structurée ; les clauses du contrat courant (ou du modèle) servent de base ; nouvelle version, clauses `origin = AI` avec risque, justification et sources ; `unreviewedAiClauses` > 0 bloque la soumission (V2-AI) jusqu'à la revue clause par clause ; `contracts.origin = AI` en mode `replace` |
| `POST /v1/contracts/:id/clauses/:clauseKey/ai` `{action: rephrase\|harden\|explain\|compare}` | **suggestion seulement** (aucune version créée) ; `compare` confronte à la bibliothèque du tenant |
| `POST /v1/contracts/:id/ai/missing-clauses` | clauses absentes par rapport au modèle et à l'usage |
| `POST /v1/contracts/:id/import/ai-extract` | §11.1 |

Entités pseudonymisées pour un contrat : raison sociale et nom du client, SIREN, TVA, adresse,
contacts (noms, e-mails, téléphones) et signataires. Les catégories fines du fournisseur sont
ramenées aux catégories du modèle de données (`DEFINITIONS → OBJET`, `PAIEMENT/REVISION → PRIX`,
`NIVEAUX_DE_SERVICE → SLA`, `DONNEES_PERSONNELLES → RGPD`, `REVERSIBILITE → RESILIATION`, autres →
`DIVERS`). Le texte généré est échappé puis mis en paragraphes (`textToHtml`) : aucun HTML du
fournisseur n'entre dans le contrat.
