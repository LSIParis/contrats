# Aide IA à la rédaction de contrat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un endpoint `POST /v1/templates/ai-draft` qui génère, via Claude Opus 4.8, un brouillon HTML de contrat sanitisé (+ variables) et l'affiche dans l'éditeur de version pour relecture humaine, sans rien persister.

**Architecture:** Un port `ContractDrafter` (interface) découple le métier du fournisseur LLM, calqué sur `DOCUMENT_STORAGE`/`JOB_QUEUE` : adaptateur prod `ClaudeContractDrafter` (lit `ANTHROPIC_API_KEY`), adaptateur `UnavailableContractDrafter` (503 si clé absente), stub injecté en test. `AiDraftingService` sanitise (`sanitizeContractHtml`) et ré-extrait les variables (`extractVariables`) du HTML renvoyé par le port. Le front remplit l'éditeur existant ; l'enregistrement/publication reste inchangé.

**Tech Stack:** NestJS 10 (Express, SWC runtime, ESM), `@anthropic-ai/sdk`, `zod` (structured output), class-validator (DTO), React 18 + TanStack Query + Vitest/Testing-Library, tests d'isolation Vitest + Testcontainers (Postgres/Redis).

## Global Constraints

- **Monorepo ESM** : tout import interne porte le suffixe `.js` (ex. `./contract-drafter.port.js`), y compris dans les tests. Node 22, pnpm workspace.
- **Modèle** : `claude-opus-4-8` uniquement. LLM via `@anthropic-ai/sdk` — jamais de HTTP brut ni de shim OpenAI.
- **Secret** : la clé Anthropic est lue **exclusivement** via `process.env.ANTHROPIC_API_KEY`. Jamais de valeur de clé en dur, jamais commitée (repo public `LSIParis/contrats`) : scanner `git diff` avant tout commit/push.
- **Rôles** : tout endpoint IA → `assertRole(session, ['MSP_ADMIN','LEGAL_REVIEWER'])` (403 sinon). Les CLIENT n'y accèdent jamais (garde + rôle).
- **Sanitisation obligatoire** : le HTML renvoyé au client passe TOUJOURS par `sanitizeContractHtml` ; les variables renvoyées sont TOUJOURS `extractVariables(htmlSanitisé)` (jamais la liste brute du modèle).
- **Aucune persistance** : `ai-draft` ne crée ni ne modifie aucun `ContractTemplate`/`ContractTemplateVersion`.
- **Gates CI** : les tests SWC ne typent pas. Lancer `pnpm --filter @lsi/api typecheck` (et `pnpm lint`) en plus des tests avant de considérer une tâche finie. `unsafeUnscopedClient` reste interdit hors `packages/persistence` (sans objet ici : aucun accès DB).
- **Tests d'isolation** : overrider le port `CONTRACT_DRAFTER` avec un stub (`.overrideProvider(CONTRACT_DRAFTER).useValue(stub).compile()`) — aucun appel réseau réel en CI.

---

### Task 1: Extraire l'utilitaire de variables de modèle

Rendre `extractVariables` / `variablesSchemaOf` réutilisables hors de `templates.service.ts` (le service d'IA en a besoin) sans dupliquer la regex.

**Files:**
- Create: `apps/api/src/templates/template-variables.ts`
- Modify: `apps/api/src/templates/templates.service.ts` (retirer les 2 fonctions locales, importer depuis le nouvel util)
- Test: `apps/api/tests/isolation/templates.test.ts` (existant, doit rester vert)

**Interfaces:**
- Produces: `export function extractVariables(html: string): string[]` (noms `{{ nom }}` dédupliqués, triés) et `export function variablesSchemaOf(names: string[]): { type: 'object'; properties: Record<string,{type:'string'}>; required: string[] }`.

- [ ] **Step 1: Créer l'util**

Créer `apps/api/src/templates/template-variables.ts` avec le contenu exact déplacé depuis le service :

```ts
/** Extrait les noms de variables `{{ nom }}` d'un corps HTML (dédupliqués, triés). */
export function extractVariables(html: string): string[] {
  const names = new Set<string>();
  const re = /\{\{\s*([\w.]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) names.add(m[1]);
  return [...names].sort();
}

export function variablesSchemaOf(names: string[]) {
  const properties: Record<string, { type: 'string' }> = {};
  for (const n of names) properties[n] = { type: 'string' };
  return { type: 'object', properties, required: names };
}
```

- [ ] **Step 2: Mettre à jour le service pour importer l'util**

Dans `apps/api/src/templates/templates.service.ts` : supprimer les deux fonctions locales `extractVariables` et `variablesSchemaOf` (lignes ~5–17) et ajouter en tête (avec les autres imports) :

```ts
import { extractVariables, variablesSchemaOf } from './template-variables.js';
```

Ne rien changer d'autre — les appels `extractVariables(clean)` / `variablesSchemaOf(...)` dans le service restent identiques.

- [ ] **Step 3: Lancer les tests de modèles (doivent rester verts)**

Run: `pnpm --filter @lsi/api test:integration -- templates`
Expected: PASS (les 6 tests de `templates.test.ts` inchangés).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @lsi/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/templates/template-variables.ts apps/api/src/templates/templates.service.ts
git commit -m "refactor(templates): extraire extractVariables/variablesSchemaOf dans template-variables.ts"
```

---

### Task 2: Port `ContractDrafter` + service métier (sanitise + ré-extrait)

Logique pure, sans SDK ni DI d'app : le port, l'adaptateur « non configuré », le service d'orchestration, et son test unitaire avec un faux drafter.

**Files:**
- Create: `apps/api/src/ai-drafting/contract-drafter.port.ts`
- Create: `apps/api/src/ai-drafting/unavailable-contract-drafter.ts`
- Create: `apps/api/src/ai-drafting/ai-drafting.service.ts`
- Test: `apps/api/tests/unit/ai-drafting.service.test.ts`

**Interfaces:**
- Consumes: `sanitizeContractHtml` (`apps/api/src/documents/html-sanitizer.js`), `extractVariables` (Task 1).
- Produces:
  - `export const CONTRACT_DRAFTER: symbol`
  - `export interface DraftInput { prompt: string; category?: string; context?: string }`
  - `export interface DraftResult { bodyHtml: string; suggestedVariables: string[] }`
  - `export interface ContractDrafter { draft(input: DraftInput): Promise<DraftResult> }`
  - `class AiDraftingService { draft(input: DraftInput): Promise<DraftResult> }` (sanitise `bodyHtml`, `suggestedVariables = extractVariables(clean)`).

- [ ] **Step 1: Écrire le test unitaire du service (échec attendu)**

Créer `apps/api/tests/unit/ai-drafting.service.test.ts` :

```ts
import { describe, test, expect } from 'vitest';
import { AiDraftingService } from '../../src/ai-drafting/ai-drafting.service.js';
import type { ContractDrafter } from '../../src/ai-drafting/contract-drafter.port.js';

const fakeDrafter: ContractDrafter = {
  async draft() {
    return {
      bodyHtml: '<p>Bonjour {{client_nom}}, montant {{montant}}.</p><script>alert(1)</script>',
      suggestedVariables: ['ignore_moi'],
    };
  },
};

describe('AiDraftingService', () => {
  test('sanitise le HTML et ré-extrait les variables du HTML nettoyé', async () => {
    const svc = new AiDraftingService(fakeDrafter);
    const res = await svc.draft({ prompt: 'Un contrat de maintenance' });
    expect(res.bodyHtml).not.toContain('<script>');
    expect(res.bodyHtml).toContain('{{client_nom}}');
    // dérivées du HTML nettoyé, pas de la liste brute du modèle
    expect(res.suggestedVariables).toEqual(['client_nom', 'montant']);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `pnpm --filter @lsi/api test -- ai-drafting.service`
Expected: FAIL (`Cannot find module '.../ai-drafting.service.js'`).

- [ ] **Step 3: Créer le port**

`apps/api/src/ai-drafting/contract-drafter.port.ts` :

```ts
export const CONTRACT_DRAFTER = Symbol('CONTRACT_DRAFTER');

export interface DraftInput {
  readonly prompt: string;
  readonly category?: string;
  readonly context?: string;
}

export interface DraftResult {
  bodyHtml: string;
  suggestedVariables: string[];
}

/**
 * Rédacteur de brouillon de contrat (port). Abstrait le fournisseur LLM :
 * les services dépendent du PORT, pas de l'adaptateur (cf. DOCUMENT_STORAGE,
 * JOB_QUEUE). En test, un stub évite tout appel réseau.
 */
export interface ContractDrafter {
  draft(input: DraftInput): Promise<DraftResult>;
}
```

- [ ] **Step 4: Créer l'adaptateur « non configuré »**

`apps/api/src/ai-drafting/unavailable-contract-drafter.ts` :

```ts
import { ServiceUnavailableException } from '@nestjs/common';
import type { ContractDrafter, DraftInput, DraftResult } from './contract-drafter.port.js';

/**
 * Utilisé quand ANTHROPIC_API_KEY est absente : l'app démarre normalement,
 * mais toute tentative de génération renvoie 503. Aucune dépendance au SDK.
 */
export class UnavailableContractDrafter implements ContractDrafter {
  async draft(_input: DraftInput): Promise<DraftResult> {
    throw new ServiceUnavailableException('Assistance IA non configurée.');
  }
}
```

- [ ] **Step 5: Créer le service**

`apps/api/src/ai-drafting/ai-drafting.service.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { sanitizeContractHtml } from '../documents/html-sanitizer.js';
import { extractVariables } from '../templates/template-variables.js';
import { CONTRACT_DRAFTER, type ContractDrafter, type DraftInput, type DraftResult } from './contract-drafter.port.js';

@Injectable()
export class AiDraftingService {
  constructor(@Inject(CONTRACT_DRAFTER) private readonly drafter: ContractDrafter) {}

  async draft(input: DraftInput): Promise<DraftResult> {
    const raw = await this.drafter.draft(input);
    const bodyHtml = sanitizeContractHtml(raw.bodyHtml);
    // Source de vérité = le HTML nettoyé ; on ignore la liste brute du modèle.
    const suggestedVariables = extractVariables(bodyHtml);
    return { bodyHtml, suggestedVariables };
  }
}
```

- [ ] **Step 6: Lancer le test pour vérifier le succès**

Run: `pnpm --filter @lsi/api test -- ai-drafting.service`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @lsi/api typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/ai-drafting/ apps/api/tests/unit/ai-drafting.service.test.ts
git commit -m "feat(ai-drafting): port ContractDrafter + service (sanitise + ré-extrait les variables)"
```

---

### Task 3: Endpoint `POST /v1/templates/ai-draft` + adaptateur Claude + câblage + test d'isolation

Tranche verticale : DTO, contrôleur, adaptateur prod, câblage DI (fabrique clé-dépendante), test d'isolation avec stub (403 / 400 / 200-forme / sanitise / non-persistance).

**Files:**
- Modify: `apps/api/package.json` (ajouter `@anthropic-ai/sdk`, `zod`)
- Create: `apps/api/src/ai-drafting/dto/ai-draft.dto.ts`
- Create: `apps/api/src/ai-drafting/claude-contract-drafter.ts`
- Create: `apps/api/src/ai-drafting/ai-drafting.controller.ts`
- Modify: `apps/api/src/app.module.ts` (importer + enregistrer contrôleur & providers)
- Test: `apps/api/tests/isolation/ai-drafting.test.ts`

**Interfaces:**
- Consumes: `AiDraftingService.draft` (Task 2), `CONTRACT_DRAFTER` (Task 2), `assertRole`/`@CurrentSession` (`../auth/current-scope.decorator.js`), `Session` (`../auth/session.service.js`).
- Produces: route `POST /v1/templates/ai-draft` `{ prompt, category?, context? }` → `{ bodyHtml: string, suggestedVariables: string[] }`.

- [ ] **Step 1: Ajouter les dépendances**

Run:
```bash
pnpm --filter @lsi/api add @anthropic-ai/sdk zod
```
Expected: `apps/api/package.json` gagne `@anthropic-ai/sdk` et `zod` dans `dependencies`. (Réseau requis — si indisponible, escalader.)

- [ ] **Step 2: Écrire le test d'isolation (échec attendu)**

Créer `apps/api/tests/isolation/ai-drafting.test.ts` :

```ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';
import { CONTRACT_DRAFTER, type ContractDrafter } from '../../src/ai-drafting/contract-drafter.port.js';

// Stub : renvoie un HTML fixe avec un <script> (preuve de sanitisation) et des
// placeholders (preuve d'extraction). Aucun appel réseau.
const stubDrafter: ContractDrafter = {
  async draft() {
    return {
      bodyHtml: '<p>Client {{client_nom}}, montant {{montant}}.</p><script>alert(1)</script>',
      suggestedVariables: ['ignore_moi'],
    };
  },
};

let app: INestApplication; let fx: TwoCustomerFixture;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CONTRACT_DRAFTER).useValue(stubDrafter).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) }, 3600);
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
});
const req = (s: string, m: 'get'|'post', p: string) => request(app.getHttpServer())[m](p).set('x-lsi-session', s);

describe('aide IA à la rédaction', () => {
  test('rôle non autorisé (ACCOUNT_MANAGER) → 403', async () => {
    await req('sess-am', 'post', '/v1/templates/ai-draft').send({ prompt: 'x' }).expect(403);
  });

  test('prompt vide → 400', async () => {
    await req('sess-admin', 'post', '/v1/templates/ai-draft').send({ prompt: '' }).expect(400);
  });

  test('génère un brouillon sanitisé + variables extraites du HTML nettoyé', async () => {
    const res = await req('sess-admin', 'post', '/v1/templates/ai-draft')
      .send({ prompt: 'Un contrat de maintenance', category: 'MAINTENANCE' }).expect(201);
    expect(res.body.bodyHtml).not.toContain('<script>');
    expect(res.body.suggestedVariables.sort()).toEqual(['client_nom', 'montant']);
  });

  test('ne persiste aucun modèle ni version', async () => {
    const before = (await req('sess-admin', 'get', '/v1/templates').expect(200)).body.items.length;
    await req('sess-admin', 'post', '/v1/templates/ai-draft').send({ prompt: 'Autre contrat' }).expect(201);
    const after = (await req('sess-admin', 'get', '/v1/templates').expect(200)).body.items.length;
    expect(after).toBe(before);
  });
});
```

- [ ] **Step 3: Lancer le test pour vérifier l'échec**

Run: `pnpm --filter @lsi/api test -- ai-drafting`
Expected: FAIL (module `ai-draft.dto`/contrôleur introuvable, ou route 404).

> Les tests d'isolation (`tests/isolation/**`) tournent via le script **`test`** (config par défaut, `globalSetup` Testcontainers) — PAS `test:integration`, dont la config ne matche que `tests/integration/**`.

- [ ] **Step 4: Créer le DTO**

`apps/api/src/ai-drafting/dto/ai-draft.dto.ts` :

```ts
import { IsOptional, IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class AiDraftDto {
  @IsString() @IsNotEmpty() @MaxLength(8000)
  prompt!: string;

  @IsOptional() @IsString() @MaxLength(120)
  category?: string;

  @IsOptional() @IsString() @MaxLength(4000)
  context?: string;
}
```

- [ ] **Step 5: Créer l'adaptateur Claude**

`apps/api/src/ai-drafting/claude-contract-drafter.ts` :

```ts
import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { ContractDrafter, DraftInput, DraftResult } from './contract-drafter.port.js';

const DraftSchema = z.object({
  bodyHtml: z.string(),
  suggestedVariables: z.array(z.string()),
});

const SYSTEM_PROMPT = `Tu es un assistant de rédaction de contrats pour LSI, une PME française de maintenance.
Tu produis un BROUILLON de corps de contrat, destiné à être RELU ET VALIDÉ PAR UN JURISTE avant toute utilisation.
Tu n'affirmes jamais une validité juridique et n'inventes pas de clauses légales spécifiques qui ne sont pas demandées.
Contraintes de sortie :
- « bodyHtml » : le corps du contrat en HTML SIMPLE (titres h1..h3, paragraphes p, listes ul/ol/li, strong, em, br). JAMAIS de balise <script> ou <style>, ni d'attribut d'événement (onclick, onload, ...).
- Utilise des variables de la forme {{ nom_en_snake_case }} pour TOUTE donnée à personnaliser (nom du client, dates, montants, durée, adresse, ...). N'écris jamais de valeurs en dur pour ces données.
- « suggestedVariables » : la liste des noms de variables que tu as utilisés.
Réponds en français.`;

function buildUserPrompt(input: DraftInput): string {
  const parts = [`Rédige un brouillon de contrat pour la demande suivante :\n${input.prompt}`];
  if (input.category) parts.push(`Catégorie du contrat : ${input.category}.`);
  if (input.context) parts.push(`Contexte additionnel :\n${input.context}`);
  return parts.join('\n\n');
}

/**
 * Adaptateur prod. Instancié UNIQUEMENT quand ANTHROPIC_API_KEY est présente
 * (cf. la fabrique dans app.module) : `new Anthropic()` lit la clé de l'env.
 */
@Injectable()
export class ClaudeContractDrafter implements ContractDrafter {
  private readonly client = new Anthropic();

  async draft(input: DraftInput): Promise<DraftResult> {
    const res = await this.client.messages.parse({
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: zodOutputFormat(DraftSchema) },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(input) }],
    });
    const parsed = res.parsed_output;
    if (!parsed) throw new Error('Réponse IA non exploitable.');
    // suggestedVariables sera de toute façon ré-extrait côté service.
    return { bodyHtml: parsed.bodyHtml, suggestedVariables: parsed.suggestedVariables };
  }
}
```

> **Note d'implémentation (binding SDK) :** cet adaptateur n'est PAS exercé par les tests (le stub le remplace) ; sa seule validation automatique est `pnpm typecheck`. Si la version installée de `@anthropic-ai/sdk` n'expose pas `messages.parse`, `zodOutputFormat`, ou le champ `output_config`, remplacer le corps de `draft` par la variante en texte simple ci-dessous (100 % supportée), qui donne un comportement API identique puisque `suggestedVariables` est de toute façon ré-extrait par le service :
>
> ```ts
> // Variante de repli : réponse texte, HTML brut, pas de zod / output_config.
> const res = await this.client.messages.create({
>   model: 'claude-opus-4-8', max_tokens: 16000,
>   thinking: { type: 'adaptive' },
>   system: SYSTEM_PROMPT + '\nRéponds UNIQUEMENT avec le HTML du corps, sans texte autour et sans balises de code markdown.',
>   messages: [{ role: 'user', content: buildUserPrompt(input) }],
> });
> const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
> if (!text) throw new Error('Réponse IA non exploitable.');
> const bodyHtml = text.text.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim();
> return { bodyHtml, suggestedVariables: [] };
> ```
> Dans ce cas de repli, la dépendance `zod` peut être retirée si elle n'est utilisée nulle part ailleurs.

- [ ] **Step 6: Créer le contrôleur**

`apps/api/src/ai-drafting/ai-drafting.controller.ts` :

```ts
import { Body, Controller, Post } from '@nestjs/common';
import { CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { AiDraftingService } from './ai-drafting.service.js';
import { AiDraftDto } from './dto/ai-draft.dto.js';

@Controller('v1/templates')
export class AiDraftingController {
  constructor(private readonly ai: AiDraftingService) {}

  @Post('ai-draft')
  draft(@CurrentSession() s: Session, @Body() dto: AiDraftDto) {
    assertRole(s, ['MSP_ADMIN', 'LEGAL_REVIEWER']);
    return this.ai.draft({ prompt: dto.prompt, category: dto.category, context: dto.context });
  }
}
```

> Route `POST /v1/templates/ai-draft` : segment littéral `ai-draft`, distinct de `POST /v1/templates` (create) et `POST /v1/templates/:id/publish` de `TemplatesController` — aucune collision.

- [ ] **Step 7: Câbler dans AppModule**

Dans `apps/api/src/app.module.ts` :

1. Ajouter les imports (près des imports `templates`) :
```ts
import { AiDraftingController } from './ai-drafting/ai-drafting.controller.js';
import { AiDraftingService } from './ai-drafting/ai-drafting.service.js';
import { CONTRACT_DRAFTER } from './ai-drafting/contract-drafter.port.js';
import { ClaudeContractDrafter } from './ai-drafting/claude-contract-drafter.js';
import { UnavailableContractDrafter } from './ai-drafting/unavailable-contract-drafter.js';
```

2. Ajouter `AiDraftingController` à la liste `controllers` (après `TemplatesController`).

3. Ajouter à la liste `providers` (après `TemplatesService`) :
```ts
AiDraftingService,
{
  // Claude si la clé est fournie (prod), sinon un adaptateur qui renvoie 503.
  // Le service dépend du PORT, pas de l'adaptateur : en test, le port est
  // overridé par un stub. `new Anthropic()` (dans ClaudeContractDrafter) n'est
  // instancié que si ANTHROPIC_API_KEY est présente, jamais en CI.
  provide: CONTRACT_DRAFTER,
  useFactory: () => (process.env.ANTHROPIC_API_KEY ? new ClaudeContractDrafter() : new UnavailableContractDrafter()),
},
```

- [ ] **Step 8: Lancer le test d'isolation (succès attendu)**

Run: `pnpm --filter @lsi/api test -- ai-drafting`
Expected: PASS (4 tests).

- [ ] **Step 9: Non-régression des modèles + typecheck + lint**

Run:
```bash
pnpm --filter @lsi/api test -- templates
pnpm --filter @lsi/api typecheck
pnpm lint
```
Expected: tout PASS. (Le typecheck valide le binding SDK de `ClaudeContractDrafter` — appliquer la variante de repli de l'étape 5 s'il échoue dessus.)

- [ ] **Step 10: Scanner le diff pour tout secret, puis commit**

Run: `git diff --cached ; git status` — vérifier qu'aucune clé/valeur de secret n'apparaît (seulement `process.env.ANTHROPIC_API_KEY`).
```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/ai-drafting/ apps/api/src/app.module.ts apps/api/tests/isolation/ai-drafting.test.ts
git commit -m "feat(ai-drafting): endpoint POST /v1/templates/ai-draft (Opus 4.8) + adaptateur Claude"
```

---

### Task 4: Front — panneau « Rédiger avec l'IA »

Composant présentation testable + câblage dans l'éditeur de modèle : prompt → génération → remplit la zone d'édition, avec bannière disclaimer.

**Files:**
- Create: `apps/web/src/features/templates/ai-draft-panel.tsx`
- Modify: `apps/web/src/features/templates/template-detail-page.tsx`
- Test: `apps/web/src/test/ai-draft-panel.test.tsx`

**Interfaces:**
- Consumes: `apiPost` (`../../lib/api.js`), `Button` (`../../ui/button.js`).
- Produces: `AiDraftPanel` — props `{ generating: boolean; error?: string; onGenerate: (input: { prompt: string; context?: string }) => void }`.

- [ ] **Step 1: Écrire le test du composant (échec attendu)**

Créer `apps/web/src/test/ai-draft-panel.test.tsx` :

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiDraftPanel } from '../features/templates/ai-draft-panel.js';

test('affiche la bannière « à valider par un juriste »', () => {
  render(<AiDraftPanel generating={false} onGenerate={() => {}} />);
  expect(screen.getByText(/valider par un juriste/i)).toBeInTheDocument();
});

test('« Générer » transmet le prompt saisi', async () => {
  const onGenerate = vi.fn();
  render(<AiDraftPanel generating={false} onGenerate={onGenerate} />);
  await userEvent.type(screen.getByPlaceholderText(/décri/i), 'Contrat de maintenance annuel');
  await userEvent.click(screen.getByRole('button', { name: /Générer/ }));
  expect(onGenerate).toHaveBeenCalledTimes(1);
  expect(onGenerate.mock.calls[0]![0].prompt).toContain('maintenance annuel');
});

test('bouton désactivé pendant la génération', () => {
  render(<AiDraftPanel generating={true} onGenerate={() => {}} />);
  expect(screen.getByRole('button', { name: /Génération|Générer/ })).toBeDisabled();
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `pnpm --filter @lsi/web test -- ai-draft-panel`
Expected: FAIL (module introuvable).

- [ ] **Step 3: Créer le composant**

`apps/web/src/features/templates/ai-draft-panel.tsx` :

```tsx
import { useState } from 'react';
import { Button } from '../../ui/button.js';

interface Props {
  generating: boolean;
  error?: string;
  onGenerate: (input: { prompt: string; context?: string }) => void;
}

export function AiDraftPanel({ generating, error, onGenerate }: Props) {
  const [prompt, setPrompt] = useState('');
  const [context, setContext] = useState('');
  return (
    <div className="space-y-3 rounded border border-blue-200 bg-blue-50/40 p-3">
      <p className="text-sm text-amber-700">
        ⚠️ Brouillon généré par IA — à faire valider par un juriste avant publication.
      </p>
      <textarea
        className="w-full min-h-[80px] rounded border p-2 text-sm"
        placeholder="Décris le contrat souhaité (type, parties, durée, obligations…)"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <textarea
        className="w-full min-h-[48px] rounded border p-2 text-sm"
        placeholder="Contexte additionnel (optionnel)"
        value={context}
        onChange={(e) => setContext(e.target.value)}
      />
      <Button
        onClick={() => onGenerate({ prompt, context: context.trim() || undefined })}
        disabled={generating || prompt.trim().length === 0}
      >
        {generating ? 'Génération…' : 'Générer'}
      </Button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Lancer le test pour vérifier le succès**

Run: `pnpm --filter @lsi/web test -- ai-draft-panel`
Expected: PASS (3 tests).

- [ ] **Step 5: Câbler dans l'éditeur de modèle**

Dans `apps/web/src/features/templates/template-detail-page.tsx` :

1. Import :
```tsx
import { AiDraftPanel } from './ai-draft-panel.js';
```

2. Après la mutation `deprecate` (vers ligne 42), ajouter la mutation de génération :
```tsx
const aiDraft = useMutation({
  mutationFn: (input: { prompt: string; context?: string }) =>
    apiPost<{ bodyHtml: string; suggestedVariables: string[] }>(`/v1/templates/ai-draft`, { ...input, category: t.category }),
  onSuccess: (data) => setBodyHtml(data.bodyHtml),
});
```
> `t` est défini plus bas (`const t = q.data`). Déplacer la déclaration `const t = q.data;` AVANT les mutations, ou référencer `q.data!.category` dans le `mutationFn` (évalué à l'appel, `q.data` est chargé). Choisir l'option qui garde le typecheck vert.

3. Dans le JSX, sous la `Card title="Contenu"` (après le bloc des boutons, avant `Card Versions`), rendre le panneau **uniquement quand la version courante est un DRAFT mutable** :
```tsx
{t.currentVersion && !t.currentVersion.isImmutable && (
  <Card title="Rédiger avec l'IA">
    <AiDraftPanel
      generating={aiDraft.isPending}
      error={aiDraft.error instanceof ApiError ? aiDraft.error.message : aiDraft.error ? 'Erreur.' : undefined}
      onGenerate={(input) => aiDraft.mutate(input)}
    />
  </Card>
)}
```
> `ApiError` est déjà importé. Un 503 (clé absente) remonte comme `ApiError` et affiche « Assistance IA non configurée. ».

- [ ] **Step 6: Typecheck + build + tests front**

Run:
```bash
pnpm --filter @lsi/web typecheck
pnpm --filter @lsi/web test
pnpm --filter @lsi/web build
```
Expected: tout PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/templates/ai-draft-panel.tsx apps/web/src/features/templates/template-detail-page.tsx apps/web/src/test/ai-draft-panel.test.tsx
git commit -m "feat(web): panneau « Rédiger avec l'IA » dans l'éditeur de modèle"
```

---

## Self-Review

**Couverture du spec :**
- §2 Modèle/SDK/clé → Task 3 (`ClaudeContractDrafter`, fabrique clé-dépendante). ✅
- §3 Port/adaptateur/DI/stub → Task 2 (port + Unavailable + service) & Task 3 (Claude + fabrique + override test). ✅
- §4 API `POST /v1/templates/ai-draft`, DTO, 403/400/503, non-persistance → Task 3 (contrôleur + DTO + test). ✅
- §5 System prompt (cadre juridique) → Task 3 step 5. ✅
- §6 Front (bouton/panneau, remplit l'éditeur, disclaimer, 503) → Task 4. ✅
- §7 Tests (403, 400, 200-forme, sanitise, extraction, non-persistance, unité service) → Task 2 & 3. ✅
- Sanitisation + ré-extraction (source de vérité = HTML) → Task 2 service + Task 1 util. ✅

**Cohérence des types :** `ContractDrafter`/`DraftInput`/`DraftResult`/`CONTRACT_DRAFTER` définis en Task 2, consommés à l'identique en Task 3 (service, contrôleur via service, test override) ; `AiDraftDto` (Task 3) → `DraftInput` (mapping explicite dans le contrôleur). Réponse `{ bodyHtml, suggestedVariables }` cohérente API (Task 3) ↔ front (`apiPost<{ bodyHtml; suggestedVariables }>`, Task 4). ✅

**Placeholders :** aucun — chaque étape porte le code réel. La seule alternative (variante de repli SDK en Task 3) est fournie en entier, conditionnée à un échec de typecheck explicite.
