# Export DOCX + PDF des modèles et contrats — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Télécharger le corps d'un **modèle** et d'un **contrat** en **PDF** (Gotenberg existant) et **DOCX** (nouveau), via des routes `export.pdf`/`export.docx`, avec boutons de téléchargement côté front.

**Architecture:** Le PDF réutilise le port `DocumentRenderer` (Gotenberg). Le DOCX ajoute un port `DocxRenderer` + adaptateur `HtmlToDocxRenderer` (`@turbodocx/html-to-docx`). Les services `ContentService` (contrat) et `TemplatesService` (modèle) exposent le HTML de la version courante et appellent les renderers ; les contrôleurs streament le binaire en `attachment` avec un nom de fichier slugifié.

**Tech Stack:** NestJS 10 (Express, SWC, ESM), `@turbodocx/html-to-docx`, Gotenberg (existant) ; React 18 ; tests Vitest + Testcontainers.

## Global Constraints

- **ESM** : tout import interne porte le suffixe `.js`.
- **Une seule nouvelle dépendance** : `@turbodocx/html-to-docx` dans `apps/api`. PDF = réutilise `DocumentRenderer` (Gotenberg), aucun nouveau moteur PDF.
- **Rôles** : export **modèle** → `assertRole(session, ['MSP_ADMIN','LEGAL_REVIEWER'])` (403 sinon). Export **contrat** → scope/RLS uniquement, PAS d'`assertRole` (identique à `preview.pdf` — hors scope → 404).
- **Nom de fichier slugifié** : ASCII, sans guillemets, `\r`, `\n`, ni caractère de contrôle (pas d'injection dans l'en-tête `Content-Disposition`).
- **HTML déjà sanitisé** en base (PDF & DOCX partent de contenu assaini) ; ne pas re-sanitiser inutilement, ne pas rendre du HTML non maîtrisé.
- **Aucune migration.**
- **Tests d'isolation** : overrider `DOCUMENT_RENDERER` (`FakeRenderer`) ET `DOCX_RENDERER` (`FakeDocxRenderer`) — aucun appel Gotenberg ni à la vraie lib DOCX dans les tests d'isolation.
- **Gates CI (repo-wide) obligatoires avant de finir une tâche** : `pnpm lint` ET `pnpm typecheck` (à la racine) — pas seulement les variantes `--filter`. `apps/api` n'a pas de script `typecheck` : le typecheck par paquet est `pnpm --filter @lsi/api exec tsc --noEmit`, mais le gate CI est `pnpm typecheck` racine. Ne JAMAIS ajouter de directive `eslint-disable <règle>` pour une règle non configurée (échec `eslint .`).

---

### Task 1: Port + adaptateur DOCX (`@turbodocx/html-to-docx`)

Infrastructure DOCX isolée : dépendance, port, adaptateur, câblage DI, test unitaire de l'adaptateur (vraie lib → DOCX valide).

**Files:**
- Modify: `apps/api/package.json` (dép `@turbodocx/html-to-docx`)
- Create: `apps/api/src/documents/docx-renderer.port.ts`
- Create: `apps/api/src/documents/html-to-docx.renderer.ts`
- Modify: `apps/api/src/app.module.ts` (provider `DOCX_RENDERER`)
- Test: `apps/api/tests/unit/html-to-docx.renderer.test.ts`

**Interfaces:**
- Produces: `export const DOCX_RENDERER: symbol` ; `export interface DocxRenderer { renderDocx(html: string, title: string): Promise<Buffer> }` ; `class HtmlToDocxRenderer implements DocxRenderer`.

- [ ] **Step 1: Ajouter la dépendance**

Run: `pnpm --filter @lsi/api add @turbodocx/html-to-docx`
Expected: `apps/api/package.json` gagne `@turbodocx/html-to-docx`. (Réseau requis — sinon escalader BLOCKED.)

- [ ] **Step 2: Écrire le test unitaire de l'adaptateur (échec attendu)**

Créer `apps/api/tests/unit/html-to-docx.renderer.test.ts` :

```ts
import { describe, test, expect } from 'vitest';
import { HtmlToDocxRenderer } from '../../src/documents/html-to-docx.renderer.js';

describe('HtmlToDocxRenderer', () => {
  test('produit un DOCX valide (Buffer non vide, signature ZIP PK\\x03\\x04)', async () => {
    const buf = await new HtmlToDocxRenderer().renderDocx('<h1>Titre</h1><p>Corps</p>', 'Mon document');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(100);
    // Un .docx est une archive ZIP : les 4 premiers octets sont 50 4B 03 04.
    expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304');
  });
});
```

- [ ] **Step 3: Lancer le test pour vérifier l'échec**

Run: `pnpm --filter @lsi/api test -- html-to-docx.renderer`
Expected: FAIL (module `html-to-docx.renderer` introuvable).

- [ ] **Step 4: Créer le port**

`apps/api/src/documents/docx-renderer.port.ts` :

```ts
export const DOCX_RENDERER = Symbol('DOCX_RENDERER');

/** Rendu DOCX à partir de HTML (port). Adaptateur : @turbodocx/html-to-docx. */
export interface DocxRenderer {
  renderDocx(html: string, title: string): Promise<Buffer>;
}
```

- [ ] **Step 5: Créer l'adaptateur**

`apps/api/src/documents/html-to-docx.renderer.ts` :

```ts
import { Injectable } from '@nestjs/common';
import HTMLtoDOCX from '@turbodocx/html-to-docx';
import type { DocxRenderer } from './docx-renderer.port.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/**
 * HTML → DOCX via @turbodocx/html-to-docx (pur JS). Le HTML reçu est déjà
 * assaini en amont. On l'enveloppe d'un document minimal (titre + police
 * serif) pour un rendu Word propre.
 */
@Injectable()
export class HtmlToDocxRenderer implements DocxRenderer {
  async renderDocx(html: string, title: string): Promise<Buffer> {
    const doc = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${html}</body></html>`;
    const out = await HTMLtoDOCX(doc, null, { title, font: 'Georgia' });
    // La lib peut renvoyer un Buffer, un ArrayBuffer ou un Blob selon l'env.
    if (Buffer.isBuffer(out)) return out;
    if (out instanceof ArrayBuffer) return Buffer.from(out);
    if (typeof (out as Blob).arrayBuffer === 'function') return Buffer.from(await (out as Blob).arrayBuffer());
    return Buffer.from(out as Uint8Array);
  }
}
```

> **Vérification du binding lib (obligatoire)** : l'import par défaut et la signature de `@turbodocx/html-to-docx` doivent être confirmés contre la version installée. Si le typecheck ou le test échoue sur l'import/le retour, ajuste (nom d'export par défaut, ordre des arguments `(html, headerHTML, options, footerHTML)`, type de retour) en itérant sur l'erreur, jusqu'à ce que le test de l'étape 2 passe (DOCX = ZIP `504b0304`). Ne change pas la signature du port.

- [ ] **Step 6: Câbler dans AppModule**

Dans `apps/api/src/app.module.ts` :
1. Imports (près de `S3Storage`/`GotenbergRenderer`) :
```ts
import { DOCX_RENDERER } from './documents/docx-renderer.port.js';
import { HtmlToDocxRenderer } from './documents/html-to-docx.renderer.js';
```
2. Dans `providers`, à côté de `{ provide: DOCUMENT_RENDERER, useClass: GotenbergRenderer }` :
```ts
{ provide: DOCX_RENDERER, useClass: HtmlToDocxRenderer },
```

- [ ] **Step 7: GREEN + typecheck + lint**

Run:
```bash
pnpm --filter @lsi/api test -- html-to-docx.renderer
pnpm --filter @lsi/api exec tsc --noEmit
pnpm lint
```
Expected: test PASS (DOCX ZIP), tsc PASS, lint PASS. (Appliquer la vérification du binding de l'étape 5 si le typecheck échoue sur l'import.)

- [ ] **Step 8: Scanner le diff (aucun secret) + commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/documents/docx-renderer.port.ts apps/api/src/documents/html-to-docx.renderer.ts apps/api/src/app.module.ts apps/api/tests/unit/html-to-docx.renderer.test.ts
git commit -m "feat(export): port DocxRenderer + adaptateur @turbodocx/html-to-docx"
```

---

### Task 2: Helper nom de fichier + export CONTRAT (PDF & DOCX)

Helper slug (sécurité en-tête), `FakeDocxRenderer` de test, méthode `exportDocx` + routes `export.pdf`/`export.docx` sur le contrat.

**Files:**
- Create: `apps/api/src/documents/filename.ts`
- Test: `apps/api/tests/unit/filename.test.ts`
- Modify: `apps/api/tests/support/fakes.ts` (ajout `FakeDocxRenderer`)
- Modify: `apps/api/src/contracts/content.service.ts` (méthode `exportDocx` + refacto `getRenderable`)
- Modify: `apps/api/src/contracts/content.controller.ts` (routes `export.pdf`, `export.docx`)
- Test: `apps/api/tests/isolation/contract-export.test.ts`

**Interfaces:**
- Consumes: `DOCX_RENDERER`/`DocxRenderer` (Task 1), `DOCUMENT_RENDERER`/`DocumentRenderer`, `FakeRenderer`.
- Produces: `export function slugifyFilename(name: string, fallback?: string): string` ; `class FakeDocxRenderer implements DocxRenderer { lastHtml: string }` ; `ContentService.exportDocx(scope, id): Promise<Buffer>` ; routes `GET /v1/contracts/:id/export.pdf|export.docx`.

- [ ] **Step 1: Écrire le test du helper slug (échec attendu)**

Créer `apps/api/tests/unit/filename.test.ts` :

```ts
import { describe, test, expect } from 'vitest';
import { slugifyFilename } from '../../src/documents/filename.js';

describe('slugifyFilename', () => {
  test('retire guillemets, retours à la ligne et caractères de contrôle', () => {
    const s = slugifyFilename('Maintenance "annuelle"\r\n préventive');
    expect(s).not.toMatch(/["\r\n]/);
    expect(s).toBe('Maintenance-annuelle-preventive');
  });
  test('translittère les accents en ASCII', () => {
    expect(slugifyFilename('Modèle Café')).toBe('Modele-Cafe');
  });
  test('chaîne vide → fallback', () => {
    expect(slugifyFilename('   ')).toBe('document');
    expect(slugifyFilename('***', 'modele')).toBe('modele');
  });
});
```

- [ ] **Step 2: Lancer le test (échec attendu)**

Run: `pnpm --filter @lsi/api test -- filename`
Expected: FAIL (module introuvable).

- [ ] **Step 3: Créer le helper**

`apps/api/src/documents/filename.ts` :

```ts
/**
 * Nom de fichier sûr pour l'en-tête Content-Disposition : ASCII, sans
 * guillemets ni caractères de contrôle (pas d'injection d'en-tête). Les
 * accents sont translittérés (NFD + suppression des diacritiques).
 */
export function slugifyFilename(name: string, fallback = 'document'): string {
  const base = name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  return base || fallback;
}
```

- [ ] **Step 4: Lancer le test (succès attendu)**

Run: `pnpm --filter @lsi/api test -- filename`
Expected: PASS (3 tests).

- [ ] **Step 5: Ajouter `FakeDocxRenderer` au support de test**

Dans `apps/api/tests/support/fakes.ts`, ajouter en fin de fichier (l'import de type pointe vers le src) :

```ts
import type { DocxRenderer } from '../../src/documents/docx-renderer.port.js';

/** Rendu DOCX déterministe : un Buffer reconnaissable (préfixe ZIP PK). */
export class FakeDocxRenderer implements DocxRenderer {
  lastHtml = '';
  async renderDocx(html: string, title: string): Promise<Buffer> {
    this.lastHtml = html;
    return Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.from(`\n${title}\n${html}`, 'utf8')]);
  }
}
```

- [ ] **Step 6: `ContentService.exportDocx` + refacto `getRenderable` (implémentation avant le test d'isolation ; la chaîne réelle est couverte par le fake)**

Dans `apps/api/src/contracts/content.service.ts` :
1. Injecter le port DOCX (ajouter au constructeur, à côté de `DOCUMENT_RENDERER`) :
```ts
import { DOCX_RENDERER } from '../documents/docx-renderer.port.js';
import type { DocxRenderer } from '../documents/docx-renderer.port.js';
// ...
  constructor(
    @Inject(DOCUMENT_RENDERER) private readonly renderer: DocumentRenderer,
    @Inject(DOCX_RENDERER) private readonly docx: DocxRenderer,
  ) {}
```
2. Extraire l'accès `{ html, title }` de la version courante dans une méthode privée réutilisée par `previewPdf` et `exportDocx` :
```ts
  private async renderable(tx: any, id: string): Promise<{ html: string; title: string }> {
    const c = await tx.contract.findUnique({ where: { id }, select: { id: true, title: true, currentVersionId: true } });
    if (!c) throw new NotFoundException('Contrat introuvable');
    if (!c.currentVersionId) throw new UnprocessableEntityException('Aucune version à exporter');
    const version = await tx.contractVersion.findUnique({ where: { id: c.currentVersionId }, select: { bodyHtml: true } });
    if (!version) throw new UnprocessableEntityException('Version introuvable');
    return { html: version.bodyHtml, title: c.title };
  }
```
3. Réécrire `previewPdf` pour l'utiliser (comportement inchangé) et ajouter `exportDocx` :
```ts
  async previewPdf(scope: Scope, id: string): Promise<Buffer> {
    return withScope(scope, async (tx) => {
      const { html, title } = await this.renderable(tx, id);
      const rendered = await this.renderer.render({ html, documentTitle: title });
      return rendered.pdf;
    });
  }

  async exportDocx(scope: Scope, id: string): Promise<Buffer> {
    return withScope(scope, async (tx) => {
      const { html, title } = await this.renderable(tx, id);
      return this.docx.renderDocx(html, title);
    });
  }
```
> `exportPdf` du contrat = mêmes octets que `previewPdf` ; le contrôleur réutilise `previewPdf` en changeant seulement l'en-tête (attachment). Pas de nouvelle méthode PDF.

- [ ] **Step 7: Routes `export.pdf` / `export.docx` sur le contrat**

Dans `apps/api/src/contracts/content.controller.ts`, ajouter (imports : `slugifyFilename` depuis `../documents/filename.js`) :

```ts
  @Get(':id/export.pdf')
  async exportPdf(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const pdf = await this.content.previewPdf(scope, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${slugifyFilename('contrat')}.pdf"`);
    res.send(pdf);
  }

  @Get(':id/export.docx')
  async exportDocx(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const docx = await this.content.exportDocx(scope, id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${slugifyFilename('contrat')}.docx"`);
    res.send(docx);
  }
```
> Le titre du contrat n'est pas exposé par les méthodes actuelles ; utiliser le libellé fixe `contrat` (slugifié) pour le nom de fichier au MVP est acceptable et sûr. (Amélioration possible plus tard : renvoyer le titre.)

- [ ] **Step 8: Écrire le test d'isolation contrat (échec attendu)**

Créer `apps/api/tests/isolation/contract-export.test.ts` :

```ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { DOCUMENT_RENDERER } from '../../src/documents/renderer.token.js';
import { DOCX_RENDERER } from '../../src/documents/docx-renderer.port.js';
import { FakeRenderer, FakeDocxRenderer } from '../support/fakes.js';
import { internalScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DOCUMENT_RENDERER).useValue(new FakeRenderer())
    .overrideProvider(DOCX_RENDERER).useValue(new FakeDocxRenderer())
    .compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: 'sess-am-b', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amUserId) });
});
const req = (sess: string, p: string) => request(app.getHttpServer()).get(p).set('x-lsi-session', sess);

describe('export contrat', () => {
  test('export.pdf et export.docx de la version courante', async () => {
    await request(app.getHttpServer()).put(`/v1/contracts/${fx.customerA.contractId}/content`)
      .set('x-lsi-session', 'sess-am-a').send({ bodyHtml: '<p>Texte du contrat</p>' }).expect(200);

    const pdf = await req('sess-am-a', `/v1/contracts/${fx.customerA.contractId}/export.pdf`).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('attachment');

    const docx = await req('sess-am-a', `/v1/contracts/${fx.customerA.contractId}/export.docx`).expect(200);
    expect(docx.headers['content-type']).toContain('officedocument.wordprocessingml.document');
    expect(docx.headers['content-disposition']).toContain('.docx');
  });

  test('contrat hors scope → 404', async () => {
    await req('sess-am-b', `/v1/contracts/${fx.customerA.contractId}/export.pdf`).expect(404);
    await req('sess-am-b', `/v1/contracts/${fx.customerA.contractId}/export.docx`).expect(404);
  });
});
```

- [ ] **Step 9: Lancer le test (échec → puis implémentation déjà faite → succès)**

Run: `pnpm --filter @lsi/api test -- contract-export`
Expected: PASS (2 tests). (Si RED subsiste, corriger le câblage contrôleur/service.)

- [ ] **Step 10: Non-régression preview + typecheck + lint**

Run:
```bash
pnpm --filter @lsi/api test -- content-preview
pnpm --filter @lsi/api exec tsc --noEmit
pnpm lint
```
Expected: tout PASS (le refacto `renderable` ne change pas `preview.pdf`).

- [ ] **Step 11: Scan diff + commit**

```bash
git add apps/api/src/documents/filename.ts apps/api/tests/unit/filename.test.ts apps/api/tests/support/fakes.ts apps/api/src/contracts/content.service.ts apps/api/src/contracts/content.controller.ts apps/api/tests/isolation/contract-export.test.ts
git commit -m "feat(export): export.pdf/export.docx du contrat + helper de nom de fichier"
```

---

### Task 3: Export MODÈLE (PDF & DOCX)

Méthodes `exportPdf`/`exportDocx` + routes rôle-gardées sur le modèle.

**Files:**
- Modify: `apps/api/src/templates/templates.service.ts` (injecter les 2 renderers ; `exportPdf`, `exportDocx`)
- Modify: `apps/api/src/templates/templates.controller.ts` (routes `export.pdf`, `export.docx`)
- Test: `apps/api/tests/isolation/template-export.test.ts`

**Interfaces:**
- Consumes: `DOCUMENT_RENDERER`/`DocumentRenderer`, `DOCX_RENDERER`/`DocxRenderer` (Task 1), `slugifyFilename` (Task 2), `FakeRenderer`/`FakeDocxRenderer` (Task 2).
- Produces: `TemplatesService.exportPdf(scope, id): Promise<Buffer>` ; `TemplatesService.exportDocx(scope, id): Promise<Buffer>` ; routes `GET /v1/templates/:id/export.pdf|export.docx`.

- [ ] **Step 1: Écrire le test d'isolation modèle (échec attendu)**

Créer `apps/api/tests/isolation/template-export.test.ts` :

```ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { DOCUMENT_RENDERER } from '../../src/documents/renderer.token.js';
import { DOCX_RENDERER } from '../../src/documents/docx-renderer.port.js';
import { FakeRenderer, FakeDocxRenderer } from '../support/fakes.js';
import { adminScope, internalScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DOCUMENT_RENDERER).useValue(new FakeRenderer())
    .overrideProvider(DOCX_RENDERER).useValue(new FakeDocxRenderer())
    .compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) });
  await s.put({ sessionId: 'sess-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
});
const post = (p: string, b: any) => request(app.getHttpServer()).post(p).set('x-lsi-session', 'sess-admin').send(b);
const getAs = (sess: string, p: string) => request(app.getHttpServer()).get(p).set('x-lsi-session', sess);

async function newTemplateWithBody(body: string) {
  const id = (await post('/v1/templates', { name: 'Maintenance standard', category: 'MAINTENANCE' }).expect(201)).body.id as string;
  await request(app.getHttpServer()).put(`/v1/templates/${id}/content`).set('x-lsi-session', 'sess-admin').send({ bodyHtml: body }).expect(200);
  return id;
}

describe('export modèle', () => {
  test('export.pdf et export.docx du modèle (avec {{variables}})', async () => {
    const id = await newTemplateWithBody('<p>Client {{client_nom}}</p>');
    const pdf = await getAs('sess-admin', `/v1/templates/${id}/export.pdf`).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('attachment');
    const docx = await getAs('sess-admin', `/v1/templates/${id}/export.docx`).expect(200);
    expect(docx.headers['content-type']).toContain('officedocument.wordprocessingml.document');
  });

  test('rôle non autorisé (ACCOUNT_MANAGER) → 403', async () => {
    const id = await newTemplateWithBody('<p>x</p>');
    await getAs('sess-am', `/v1/templates/${id}/export.pdf`).expect(403);
    await getAs('sess-am', `/v1/templates/${id}/export.docx`).expect(403);
  });

  test('modèle inexistant → 404 ; corps vide → 422', async () => {
    await getAs('sess-admin', '/v1/templates/00000000-0000-7000-8000-000000000000/export.pdf').expect(404);
    const empty = (await post('/v1/templates', { name: 'Vide', category: 'MAINTENANCE' }).expect(201)).body.id as string;
    await getAs('sess-admin', `/v1/templates/${empty}/export.pdf`).expect(422);
  });
});
```

- [ ] **Step 2: Lancer le test (échec attendu)**

Run: `pnpm --filter @lsi/api test -- template-export`
Expected: FAIL (routes `export.pdf`/`export.docx` → 404 sur route inexistante, ou 403 avant, mais le cas 200 échoue).

- [ ] **Step 3: Ajouter les méthodes d'export au service**

Dans `apps/api/src/templates/templates.service.ts` :
1. Imports + injection (le service n'a pas de constructeur aujourd'hui — en ajouter un) :
```ts
import { Inject } from '@nestjs/common';
import type { DocumentRenderer } from '@lsi/domain';
import { DOCUMENT_RENDERER } from '../documents/renderer.token.js';
import { DOCX_RENDERER, type DocxRenderer } from '../documents/docx-renderer.port.js';
// ...
@Injectable()
export class TemplatesService {
  constructor(
    @Inject(DOCUMENT_RENDERER) private readonly pdf: DocumentRenderer,
    @Inject(DOCX_RENDERER) private readonly docx: DocxRenderer,
  ) {}
  // ... méthodes existantes inchangées ...
```
2. Méthode privée `renderable` + `exportPdf`/`exportDocx` (le corps courant + le nom du modèle ; 422 si vide) :
```ts
  private async renderableOf(tx: any, id: string): Promise<{ html: string; title: string }> {
    const t = await this.load(tx, id); // lève NotFound (404) hors scope — méthode privée existante
    const cur = t.currentVersionId
      ? await tx.contractTemplateVersion.findUnique({ where: { id: t.currentVersionId }, select: { bodyHtml: true } })
      : null;
    const html = cur?.bodyHtml ?? '';
    if (html.trim() === '') throw new UnprocessableEntityException('Corps vide : rien à exporter.');
    return { html, title: t.name };
  }

  async exportPdf(scope: Scope, id: string): Promise<Buffer> {
    return withScope(scope, async (tx) => {
      const { html, title } = await this.renderableOf(tx, id);
      const rendered = await this.pdf.render({ html, documentTitle: title });
      return rendered.pdf;
    });
  }

  async exportDocx(scope: Scope, id: string): Promise<Buffer> {
    return withScope(scope, async (tx) => {
      const { html, title } = await this.renderableOf(tx, id);
      return this.docx.renderDocx(html, title);
    });
  }
```
> Ajouter l'import `UnprocessableEntityException` à la ligne d'import `@nestjs/common` existante du service. `this.load` et `withScope` existent déjà.

- [ ] **Step 4: Ajouter les routes au contrôleur**

Dans `apps/api/src/templates/templates.controller.ts` (imports : `Get`, `Param`, `ParseUUIDPipe` déjà présents ; ajouter `Res` de `@nestjs/common`, `Response` de `express`, `slugifyFilename` de `../documents/filename.js`) :

```ts
  @Get(':id/export.pdf')
  async exportPdf(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    assertRole(s, [...ROLES]);
    const pdf = await this.templates.exportPdf(scope, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${slugifyFilename('modele')}.pdf"`);
    res.send(pdf);
  }

  @Get(':id/export.docx')
  async exportDocx(@CurrentScope() scope: Scope, @CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    assertRole(s, [...ROLES]);
    const docx = await this.templates.exportDocx(scope, id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${slugifyFilename('modele')}.docx"`);
    res.send(docx);
  }
```
> `ROLES` (= `['MSP_ADMIN','LEGAL_REVIEWER']`) est déjà défini en tête du contrôleur. `assertRole` lève 403 AVANT d'écrire dans `res`.

- [ ] **Step 5: GREEN + non-régression templates + typecheck + lint**

Run:
```bash
pnpm --filter @lsi/api test -- template-export
pnpm --filter @lsi/api test -- templates
pnpm --filter @lsi/api exec tsc --noEmit
pnpm lint
```
Expected: tout PASS (`templates.test.ts` inchangé — l'ajout d'un constructeur au service n'altère pas ses méthodes existantes).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/templates/templates.service.ts apps/api/src/templates/templates.controller.ts apps/api/tests/isolation/template-export.test.ts
git commit -m "feat(export): export.pdf/export.docx du modèle (rôle-gardé)"
```

---

### Task 4: Boutons de téléchargement (front)

Liens de téléchargement sur l'éditeur de modèle et la fiche contrat.

**Files:**
- Modify: `apps/web/src/features/templates/template-detail-page.tsx`
- Modify: `apps/web/src/features/contracts/contract-detail-page.tsx`

**Interfaces:** aucune nouvelle ; liens ancre vers les routes de Tasks 2–3.

- [ ] **Step 1: Modèle — liens de téléchargement**

Dans `apps/web/src/features/templates/template-detail-page.tsx`, dans la carte « Contenu », sous la rangée des boutons Enregistrer/Publier/Déprécier (après le bloc `<div className="flex flex-wrap gap-2">…</div>` des actions, avant les messages d'erreur), ajouter — visibles si une version courante existe :

```tsx
          {t.currentVersion && (
            <div className="flex flex-wrap gap-3 text-sm">
              <a href={`/v1/templates/${t.id}/export.pdf`} className="text-lsi hover:underline">Télécharger PDF</a>
              <a href={`/v1/templates/${t.id}/export.docx`} className="text-lsi hover:underline">Télécharger DOCX</a>
            </div>
          )}
```

- [ ] **Step 2: Contrat — liens de téléchargement**

Dans `apps/web/src/features/contracts/contract-detail-page.tsx`, dans la carte « Contenu » (rangée `flex flex-wrap gap-3 text-sm`), à côté du lien « Aperçu PDF » (visible si `contract.currentVersionId`), ajouter :

```tsx
          {contract.currentVersionId && (
            <a href={`/v1/contracts/${contract.id}/export.pdf`} className="text-lsi hover:underline">Télécharger PDF</a>
          )}
          {contract.currentVersionId && (
            <a href={`/v1/contracts/${contract.id}/export.docx`} className="text-lsi hover:underline">Télécharger DOCX</a>
          )}
```

- [ ] **Step 3: Typecheck + suite web + build + lint**

Run:
```bash
pnpm --filter @lsi/web typecheck
pnpm --filter @lsi/web test
pnpm --filter @lsi/web build
pnpm lint
```
Expected: tout PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/features/templates/template-detail-page.tsx apps/web/src/features/contracts/contract-detail-page.tsx
git commit -m "feat(web): boutons Télécharger PDF/DOCX (modèle & contrat)"
```

---

## Self-Review

**Couverture du spec :**
- §3.1 Port + adaptateur DOCX (`@turbodocx/html-to-docx`) + câblage → Task 1. ✅
- §2 Nom de fichier slugifié (sécurité en-tête) → Task 2 (helper + test). ✅
- §3.2/§3.3 Export **contrat** (service `exportDocx`, refacto `renderable`, routes `export.pdf`/`export.docx`, scope/RLS) → Task 2. ✅
- §3.2/§3.3 Export **modèle** (service 2 renderers, routes rôle-gardées, 403/404/422) → Task 3. ✅
- §4 Boutons front (modèle & contrat) → Task 4. ✅
- §5 Tests (unit adaptateur DOCX = ZIP ; unit slug ; isolation contrat 200+headers/404 ; isolation modèle 200/403/404/422 ; renderers fakes) → Tasks 1–3. ✅
- Rôles : modèle gardé (`assertRole`), contrat scope/RLS (pas d'`assertRole`) → Tasks 2–3. ✅

**Cohérence des types :** `DOCX_RENDERER`/`DocxRenderer` définis Task 1, consommés Tasks 2 (ContentService, FakeDocxRenderer) et 3 (TemplatesService). `slugifyFilename` défini Task 2, consommé Tasks 2 et 3. `FakeDocxRenderer` défini Task 2, réutilisé Task 3. `renderDocx(html, title): Promise<Buffer>` uniforme partout. Routes `export.pdf`/`export.docx` (Tasks 2–3) consommées par le front (Task 4).

**Placeholders :** aucun — code réel à chaque étape. Seule zone à vérifier au runtime : le binding exact de `@turbodocx/html-to-docx` (étape 5 Task 1), borné par le test ZIP et une instruction de compile-run-fix explicite.
