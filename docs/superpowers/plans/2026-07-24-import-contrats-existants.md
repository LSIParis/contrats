# Enregistrer un contrat existant (import manuel) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un formulaire « Importer un contrat existant » qui crée le contrat directement en `ACTIVE` (`origin=IMPORTED`), avec un document PDF/DOCX joint (stocké scopé) et ses métadonnées, pour le registre / l'audit / les rappels — sans flux DocuSeal ni re-signature.

**Architecture:** Migration ajoutant `origin` + les champs du document importé. Un endpoint multipart `POST /v1/contracts/import` (premier upload de l'app : `FileInterceptor`) stocke le fichier via `DOCUMENT_STORAGE` (clé scopée) et insère la ligne `contracts` directement en `ACTIVE`/`IMPORTED` (hors machine à états — c'est une création). Un endpoint de téléchargement et l'exposition de `origin` dans la lecture de détail alimentent le front (formulaire + badge « Importé »).

**Tech Stack:** NestJS 10 (Express, SWC, ESM), Prisma + PostgreSQL RLS, multer (via `@nestjs/platform-express`), React 18 ; tests Vitest + Testcontainers.

## Global Constraints

- **ESM** : tout import interne porte le suffixe `.js`.
- **Isolation** : `tenantId` vient TOUJOURS de la session, jamais du DTO. `customerId` est un filtre vérifié au scope (client hors portefeuille → **404**, pas 403). Toute écriture sous `withScope`.
- **Rôles** : import → `assertRole(session, ['MSP_ADMIN','ACCOUNT_MANAGER'])` (403 sinon).
- **Stockage document** : `DOCUMENT_STORAGE` (`InMemoryStorage` en test, S3 en prod), clé **scopée** `t/{tenant}/c/{customer}/imported/{id}.{ext}` validée par `assertKeyMatchesScope` (préfixe tenant/client).
- **Un contrat importé** : `status='ACTIVE'`, `origin='IMPORTED'`, `currentVersionId=null`, aucune version de contenu, aucune preuve DocuSeal. Distingué par `origin`.
- **Référence** unique par tenant (`@@unique([tenantId, reference])`) → **409** en double ; vérifier AVANT de stocker le fichier (pour ne pas orphéliner un objet S3).
- **Audit** : l'`AuditInterceptor` global trace déjà les POST réussis — ne rien ajouter de spécifique.
- **Migration** : forward-only, compatible RLS ; `origin` a un défaut (`NATIVE`) pour les lignes existantes.
- **Gates CI (repo-wide) avant de finir une tâche** : `pnpm lint` ET `pnpm typecheck` (racine). `apps/api` n'a pas de script `typecheck` (utiliser `pnpm --filter @lsi/api exec tsc --noEmit`), mais le gate est `pnpm typecheck` racine. Jamais d'`eslint-disable <règle>` pour une règle non configurée.
- **Montants** : `amountCents` en `BigInt` (jamais de flottant).

---

### Task 1: Migration + schéma Prisma (`origin` + document importé)

**Files:**
- Modify: `packages/persistence/prisma/schema.prisma` (enum `ContractOrigin` + champs sur `Contract`)
- Create: `packages/persistence/prisma/migrations/00000000000016_contract_import/migration.sql`

**Interfaces:**
- Produces: colonnes `contracts.origin` (`ContractOrigin`, défaut `NATIVE`), `imported_document_key`, `imported_document_name`, `imported_document_sha256`, `imported_document_content_type` (nullable) ; type Prisma régénéré exposant `origin` + ces champs sur `Contract`.

- [ ] **Step 1: Ajouter l'enum + les champs au schéma Prisma**

Dans `packages/persistence/prisma/schema.prisma` :
1. Ajouter l'enum (près des autres enums `Contract*`, ~ligne 77) :
```prisma
enum ContractOrigin {
  NATIVE
  IMPORTED
}
```
2. Dans `model Contract`, ajouter (après `status`/`category`, avant les relations) :
```prisma
  /// Provenance : NATIVE (créé dans l'app) vs IMPORTED (enregistré depuis
  /// l'existant, signé hors application — pas de preuve DocuSeal).
  origin ContractOrigin @default(NATIVE)

  /// Document importé (PDF/DOCX signé hors app). NULL pour un contrat NATIVE.
  importedDocumentKey         String? @map("imported_document_key")
  importedDocumentName        String? @map("imported_document_name")
  importedDocumentSha256      String? @map("imported_document_sha256") @db.Char(64)
  importedDocumentContentType String? @map("imported_document_content_type")
```

- [ ] **Step 2: Écrire la migration SQL**

Créer `packages/persistence/prisma/migrations/00000000000016_contract_import/migration.sql` :

```sql
-- Import de contrats existants : provenance + document joint (signé hors app).
-- Les lignes existantes deviennent NATIVE. RLS inchangée (mêmes colonnes de
-- scope) ; colonnes document nullable.
CREATE TYPE "ContractOrigin" AS ENUM ('NATIVE', 'IMPORTED');

ALTER TABLE contracts
  ADD COLUMN origin "ContractOrigin" NOT NULL DEFAULT 'NATIVE',
  ADD COLUMN imported_document_key text,
  ADD COLUMN imported_document_name text,
  ADD COLUMN imported_document_sha256 char(64),
  ADD COLUMN imported_document_content_type text;
```

- [ ] **Step 3: Valider + régénérer le client Prisma**

Run:
```bash
pnpm --filter @lsi/persistence exec prisma validate
pnpm --filter @lsi/persistence exec prisma generate
```
Expected: validate PASS, generate PASS (le type `Contract` gagne `origin` + les champs document).

- [ ] **Step 4: Prouver que la migration s'applique (via un test d'isolation existant)**

Run: `pnpm --filter @lsi/api test -- templates`
Expected: PASS (le `globalSetup` Testcontainers applique TOUTES les migrations, dont la nouvelle — un échec d'application casserait ce run).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @lsi/api exec tsc --noEmit` (PASS)
```bash
git add packages/persistence/prisma/schema.prisma packages/persistence/prisma/migrations/00000000000016_contract_import/
git commit -m "feat(import): migration origin + champs document importé sur contracts"
```

---

### Task 2: Endpoint d'import (multipart) + service

**Files:**
- Modify: `apps/api/package.json` (dev dep `@types/multer`)
- Create: `apps/api/src/contracts/dto/import-contract.dto.ts`
- Modify: `apps/api/src/contracts/contracts.service.ts` (méthode `importContract`)
- Modify: `apps/api/src/contracts/contracts.controller.ts` (route `POST import` + `FileInterceptor`)
- Test: `apps/api/tests/isolation/contract-import.test.ts`

**Interfaces:**
- Consumes: `DOCUMENT_STORAGE`/`assertKeyMatchesScope` (déjà injectés dans `ContractsService`), `assertRole`.
- Produces: `ImportContractDto` ; `ContractsService.importContract(scope, dto, file, now): Promise<{ id: string }>` ; route `POST /v1/contracts/import`.

- [ ] **Step 1: Ajouter le type multer (dev)**

Run: `pnpm --filter @lsi/api add -D @types/multer`
Expected: `@types/multer` en devDependencies (pour le type `Express.Multer.File`). (Réseau requis — sinon BLOCKED.)

- [ ] **Step 2: Écrire le test d'isolation (échec attendu)**

Créer `apps/api/tests/isolation/contract-import.test.ts` :

```ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { internalScope } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  fx = await seedTwoCustomers();
  const s = app.get(SessionService);
  await s.put({ sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: 'sess-tech', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['TECHNICIAN'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
});
const PDF = () => Buffer.from('%PDF-1.7 faux contrat\n%%EOF', 'utf8');

function importReq(sess: string) {
  return request(app.getHttpServer()).post('/v1/contracts/import').set('x-lsi-session', sess);
}

describe('import de contrat existant', () => {
  test('import → 201, contrat ACTIVE/IMPORTED, document récupérable', async () => {
    const res = await importReq('sess-am-a')
      .field('customerId', fx.customerA.id).field('reference', 'IMP-001').field('title', 'Bail existant')
      .field('endDate', '2027-01-01').field('amountCents', '120000')
      .attach('document', PDF(), { filename: 'bail.pdf', contentType: 'application/pdf' })
      .expect(201);
    const id = res.body.id as string;
    const detail = await request(app.getHttpServer()).get(`/v1/contracts/${id}`).set('x-lsi-session', 'sess-am-a').expect(200);
    expect(detail.body.contract.status).toBe('ACTIVE');
    const doc = await request(app.getHttpServer()).get(`/v1/contracts/${id}/imported-document`).set('x-lsi-session', 'sess-am-a').expect(200);
    expect(doc.headers['content-type']).toContain('application/pdf');
    expect(doc.headers['content-disposition']).toContain('attachment');
  });

  test('rôle non autorisé (TECHNICIAN) → 403', async () => {
    await importReq('sess-tech').field('customerId', fx.customerA.id).field('reference', 'IMP-403').field('title', 'x')
      .attach('document', PDF(), { filename: 'x.pdf', contentType: 'application/pdf' }).expect(403);
  });

  test('client hors scope → 404', async () => {
    await importReq('sess-am-a').field('customerId', fx.customerB.id).field('reference', 'IMP-404').field('title', 'x')
      .attach('document', PDF(), { filename: 'x.pdf', contentType: 'application/pdf' }).expect(404);
  });

  test('référence en double → 409', async () => {
    const ok = () => importReq('sess-am-a').field('customerId', fx.customerA.id).field('reference', 'IMP-DUP').field('title', 'x')
      .attach('document', PDF(), { filename: 'x.pdf', contentType: 'application/pdf' });
    await ok().expect(201);
    await ok().expect(409);
  });

  test('fichier absent → 400 ; type non supporté → 400', async () => {
    await importReq('sess-am-a').field('customerId', fx.customerA.id).field('reference', 'IMP-NOFILE').field('title', 'x').expect(400);
    await importReq('sess-am-a').field('customerId', fx.customerA.id).field('reference', 'IMP-TXT').field('title', 'x')
      .attach('document', Buffer.from('texte'), { filename: 'x.txt', contentType: 'text/plain' }).expect(400);
  });
});
```

- [ ] **Step 3: Lancer le test (échec attendu)**

Run: `pnpm --filter @lsi/api test -- contract-import`
Expected: FAIL (route `/import` inexistante → 404/erreur).

- [ ] **Step 4: Créer le DTO**

`apps/api/src/contracts/dto/import-contract.dto.ts` :

```ts
import { IsDateString, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Min, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

/** Métadonnées d'un contrat importé (multipart : les nombres/dates arrivent
 *  en chaîne → @Type coerce). tenantId JAMAIS ici (vient de la session). */
export class ImportContractDto {
  @IsUUID('7') customerId!: string;
  @IsString() @IsNotEmpty() @MaxLength(100) reference!: string;
  @IsString() @IsNotEmpty() @MaxLength(300) title!: string;

  @IsOptional() @IsEnum(['MAIN', 'AMENDMENT']) type?: 'MAIN' | 'AMENDMENT';
  @IsOptional() @IsEnum(['MAINTENANCE', 'SUPPORT', 'HOSTING', 'SLA', 'OTHER'])
  category?: 'MAINTENANCE' | 'SUPPORT' | 'HOSTING' | 'SLA' | 'OTHER';

  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
  @IsOptional() @IsDateString() signedAt?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) noticePeriodDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) amountCents?: number;
}
```

- [ ] **Step 5: Ajouter `importContract` au service**

Dans `apps/api/src/contracts/contracts.service.ts` : ajouter l'import `createHash` (`import { createHash } from 'node:crypto';` en tête) et `import type { ImportContractDto } from './dto/import-contract.dto.js';`, puis la méthode (à côté de `create`) :

```ts
  async importContract(
    scope: Scope,
    dto: ImportContractDto,
    file: { buffer: Buffer; mimetype: string; originalname: string },
    now: Date,
  ): Promise<{ id: string }> {
    return withScope(scope, async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: dto.customerId } });
      if (!customer) throw new NotFoundException('Client introuvable');
      // Unicité de référence AVANT de stocker le fichier (pas d'objet orphelin).
      const dup = await tx.contract.findFirst({ where: { reference: dto.reference }, select: { id: true } });
      if (dup) throw new ConflictException({ code: 'REF_DUP', detail: 'Un contrat avec cette référence existe déjà.' });

      const id = uuidv7();
      const ext = file.mimetype === 'application/pdf' ? 'pdf' : 'docx';
      const key = `t/${scope.tenantId}/c/${dto.customerId}/imported/${id}.${ext}`;
      assertKeyMatchesScope(key, { tenantId: scope.tenantId, customerId: dto.customerId });
      await this.storage.put(key, file.buffer, { tenantId: scope.tenantId, customerId: dto.customerId }, file.mimetype);
      const sha256 = createHash('sha256').update(file.buffer).digest('hex');

      await tx.contract.create({
        data: {
          id, tenantId: scope.tenantId, customerId: dto.customerId,
          reference: dto.reference, title: dto.title, type: dto.type ?? 'MAIN',
          status: 'ACTIVE', origin: 'IMPORTED', category: dto.category ?? 'MAINTENANCE',
          currentVersionId: null,
          startDate: dto.startDate ? new Date(dto.startDate) : null,
          endDate: dto.endDate ? new Date(dto.endDate) : null,
          noticePeriodDays: dto.noticePeriodDays ?? null,
          amountCents: dto.amountCents !== undefined ? BigInt(dto.amountCents) : null,
          billingFrequency: 'MONTHLY',
          signedAt: dto.signedAt ? new Date(dto.signedAt) : null,
          activatedAt: dto.startDate ? new Date(dto.startDate) : now,
          importedDocumentKey: key, importedDocumentName: file.originalname,
          importedDocumentSha256: sha256, importedDocumentContentType: file.mimetype,
          ownerUserId: scope.userId, createdAt: now, updatedAt: now,
          createdByUserId: scope.userId, updatedByUserId: scope.userId,
        },
      });
      return { id };
    });
  }
```

- [ ] **Step 6: Ajouter la route au contrôleur**

Dans `apps/api/src/contracts/contracts.controller.ts` : ajouter aux imports `UploadedFile`, `UseInterceptors` (`@nestjs/common`), `FileInterceptor` (`@nestjs/platform-express`), `ImportContractDto` (`./dto/import-contract.dto.js`). Puis, après `create` :

```ts
  @Post('import')
  @UseInterceptors(FileInterceptor('document', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async import(
    @CurrentScope() scope: Scope,
    @CurrentSession() session: Session,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: ImportContractDto,
  ) {
    assertRole(session, ['MSP_ADMIN', 'ACCOUNT_MANAGER']);
    if (!file) throw new BadRequestException('Document manquant.');
    const ALLOWED = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (!ALLOWED.includes(file.mimetype)) throw new BadRequestException('Format non supporté (PDF ou DOCX).');
    return this.contracts.importContract(scope, dto, file, new Date());
  }
```
> `assertRole` puis la validation fichier lèvent AVANT toute écriture. `BadRequestException` est déjà importé dans ce contrôleur.

- [ ] **Step 7: GREEN (le téléchargement `imported-document` est en Task 3 — adapter le test)**

> Le test de l'étape 2 appelle `GET /:id/imported-document`, implémenté en **Task 3**. Pour que Task 2 soit vert seul, RETIRER temporairement l'assertion `imported-document` du 1er test ici **n'est pas souhaité** : à la place, **déplacer la route de téléchargement dans Task 2** est le choix retenu — implémente aussi le téléchargement maintenant (voir sous-étape) pour que le test complet passe.

Sous-étape 7a — ajouter le téléchargement (service + route) :

Service `contracts.service.ts` :
```ts
  async getImportedDocument(scope: Scope, id: string): Promise<{ buffer: Buffer; name: string; contentType: string }> {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id }, select: { customerId: true, importedDocumentKey: true, importedDocumentName: true, importedDocumentContentType: true } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      if (!c.importedDocumentKey) throw new NotFoundException('Aucun document importé');
      const buffer = await this.storage.get(c.importedDocumentKey, { tenantId: scope.tenantId, customerId: c.customerId });
      if (!buffer) throw new NotFoundException('Document introuvable');
      return { buffer, name: c.importedDocumentName ?? 'document', contentType: c.importedDocumentContentType ?? 'application/octet-stream' };
    });
  }
```
Contrôleur `contracts.controller.ts` (ajouter `Res` de `@nestjs/common`, `Response` de `express`, `slugifyFilename` de `../documents/filename.js`) :
```ts
  @Get(':id/imported-document')
  async importedDocument(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { buffer, name, contentType } = await this.contracts.getImportedDocument(scope, id);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${slugifyFilename(name, 'document')}"`);
    res.send(buffer);
  }
```
> (Task 3 se concentrera alors sur l'exposition de `origin` dans la lecture de détail + le front.)

Run: `pnpm --filter @lsi/api test -- contract-import`
Expected: PASS (5 tests).

- [ ] **Step 8: Typecheck + lint + scan secrets + commit**

Run:
```bash
pnpm --filter @lsi/api exec tsc --noEmit
pnpm lint
```
Expected: PASS. Puis `git diff --cached` (aucun secret) et :
```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/contracts/dto/import-contract.dto.ts apps/api/src/contracts/contracts.service.ts apps/api/src/contracts/contracts.controller.ts apps/api/tests/isolation/contract-import.test.ts
git commit -m "feat(import): POST /v1/contracts/import (multipart) + téléchargement du document importé"
```

---

### Task 3: Exposer `origin` + document importé dans la lecture de détail

Le front a besoin de `origin` et du nom du document pour afficher le badge « Importé » et le lien de téléchargement.

**Files:**
- Modify: le service/handler de `GET /v1/contracts/:id` (localiser : la lecture de détail du contrat — probablement `apps/api/src/contracts/contracts.service.ts` ou un service de lecture ; le champ `contract` de la réponse)
- Test: `apps/api/tests/isolation/contract-import.test.ts` (ajouter une assertion) OU le test de détail existant

**Interfaces:**
- Produces: la réponse `GET /v1/contracts/:id` inclut `contract.origin` (`'NATIVE'|'IMPORTED'`) et `importedDocument: { name: string } | null`.

- [ ] **Step 1: Localiser la lecture de détail**

Run: `grep -rnE "Get\\(':id'\\)|getDetail|contract:.*status|currentVersionId" apps/api/src/contracts` — identifier la méthode qui construit la réponse de `GET /v1/contracts/:id` (l'objet `{ contract: { status, currentVersionId, … }, … }`).

- [ ] **Step 2: Ajouter l'assertion au test (échec attendu)**

Dans `apps/api/tests/isolation/contract-import.test.ts`, dans le 1er test (après l'import), ajouter :
```ts
    expect(detail.body.contract.origin).toBe('IMPORTED');
    expect(detail.body.importedDocument?.name).toBe('bail.pdf');
```
Run: `pnpm --filter @lsi/api test -- contract-import` → FAIL (champ `origin`/`importedDocument` absent de la réponse).

- [ ] **Step 3: Exposer les champs**

Dans le `select`/mapping de la lecture de détail, ajouter `origin` (et `importedDocumentName`) au `select` Prisma, et au shape de réponse : `origin` sur l'objet `contract`, plus `importedDocument: contract.importedDocumentKey ? { name: contract.importedDocumentName } : null` (adapter aux noms réels du mapping ; sélectionner aussi `importedDocumentKey`/`importedDocumentName`).

- [ ] **Step 4: GREEN + non-régression + typecheck + lint + commit**

Run:
```bash
pnpm --filter @lsi/api test -- contract-import
pnpm --filter @lsi/api test -- contracts   # non-régression lecture contrats (si un test existe)
pnpm --filter @lsi/api exec tsc --noEmit
pnpm lint
```
Expected: PASS.
```bash
git add apps/api/src/contracts/ apps/api/tests/isolation/contract-import.test.ts
git commit -m "feat(import): exposer origin + document importé dans la lecture de détail du contrat"
```

---

### Task 4: Front — formulaire d'import + badge « Importé »

**Files:**
- Create: `apps/web/src/features/contracts/contract-import-page.tsx`
- Modify: `apps/web/src/lib/api.ts` (helper `apiPostForm` pour multipart, si absent)
- Modify: le routeur (`apps/web/src/App.tsx` ou équivalent) — route `/contracts/import`
- Modify: la page liste des contrats (lien « Importer un contrat existant »)
- Modify: `apps/web/src/features/contracts/contract-detail-page.tsx` (badge + bloc document)
- Test: `apps/web/src/test/contract-import-page.test.tsx`

**Interfaces:** consomme `POST /v1/contracts/import` (multipart) et `GET /v1/contracts/:id/imported-document`.

- [ ] **Step 1: Helper multipart (si `apiPostForm` n'existe pas)**

Dans `apps/web/src/lib/api.ts`, ajouter (aligné sur le style d'`apiPost`, mais sans `Content-Type` JSON — le navigateur pose le boundary) :
```ts
export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: 'POST', body: form, credentials: 'include' });
  if (!res.ok) {
    let message = 'Erreur.';
    try { const b = await res.json(); message = b.message ?? b.detail ?? message; } catch { /* noop */ }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}
```
> Vérifier la signature exacte d'`ApiError`/`apiPost` existants et s'y conformer.

- [ ] **Step 2: Composant formulaire testable + test (TDD)**

Créer un composant présentation `ContractImportForm` (dans `contract-import-page.tsx` ou séparé) avec des champs contrôlés + `<input type="file">`, props `{ customers: {id,name}[]; submitting: boolean; error?: string; onSubmit: (fd: FormData) => void }`. Écrire d'abord `apps/web/src/test/contract-import-page.test.tsx` : le formulaire rend les champs (référence, titre, fichier), et `onSubmit` reçoit un `FormData` contenant la référence saisie et le fichier joint. RED → implémenter → GREEN (`pnpm --filter @lsi/web test -- contract-import`).

- [ ] **Step 3: Page + route + wiring mutation**

- `contract-import-page.tsx` : charge la liste des clients (`apiGet('/v1/customers')` ou l'endpoint existant), rend `ContractImportForm`, mutation `apiPostForm('/v1/contracts/import', fd)` → au succès, navigue vers la fiche du contrat créé. Gérer 409 (référence en double), 404 (client), 400 (fichier).
- Ajouter la route `/contracts/import` au routeur (gate rôle si le routeur gère les rôles ; sinon la garde serveur suffit).
- Ajouter un lien **« Importer un contrat existant »** sur la page liste des contrats.

- [ ] **Step 4: Fiche contrat — badge « Importé » + bloc document**

Dans `contract-detail-page.tsx` :
- Étendre l'interface `Detail` : `contract.origin: 'NATIVE' | 'IMPORTED'` et `importedDocument: { name: string } | null`.
- Si `contract.origin === 'IMPORTED'` : afficher un badge « Importé » près du statut, et dans la carte « Contenu » (ou une carte dédiée) un bloc **« Document importé (signé hors application) »** avec `<a href={`/v1/contracts/${contract.id}/imported-document`}>Télécharger le document</a>`. Masquer l'« Aperçu PDF »/édition (déjà conditionnés par `currentVersionId`, qui est nul pour un importé — vérifier que rien ne casse).

- [ ] **Step 5: Typecheck + suite web + build + lint + commit**

Run:
```bash
pnpm --filter @lsi/web typecheck
pnpm --filter @lsi/web test
pnpm --filter @lsi/web build
pnpm lint
```
Expected: PASS.
```bash
git add apps/web/src/
git commit -m "feat(web): formulaire d'import de contrat existant + badge Importé"
```

---

## Self-Review

**Couverture du spec :**
- §3.1 Migration (origin + champs document) → Task 1. ✅
- §3.2 Endpoint import multipart (rôle, client 404, réf 409, fichier validé, ACTIVE/IMPORTED, doc stocké) + téléchargement → Task 2. ✅
- §3.2 Exposition `origin`/document dans la lecture de détail → Task 3. ✅
- §4 Front (formulaire, badge, bloc document) → Task 4. ✅
- §5 Tests (201/403/404/409/400 ; ACTIVE/IMPORTED ; download ; front) → Tasks 2–4. ✅
- Sécurité (scope, assertKeyMatchesScope, audit auto, pas de preuve) → Tasks 2–4. ✅

**Cohérence des types :** `ImportContractDto` (Task 2) consommé par `importContract` (service) et la route (controller). `origin`/champs document créés en Task 1, consommés Tasks 2 (écriture) et 3 (lecture) et 4 (front). `getImportedDocument` (Task 2) → route téléchargement → lien front (Task 4). Réponse détail enrichie (Task 3) → `Detail` front (Task 4).

**Placeholders :** aucun sur le backend (code réel). Task 3–4 laissent la **localisation** exacte du handler de détail et du routeur/lien à l'implémenteur (fichiers non lus ici) — chaque étape nomme le quoi et le où approximatif, avec une commande `grep` pour localiser précisément ; à confirmer au moment de l'implémentation.
