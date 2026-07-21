# Commentaires — actions & états Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter aux commentaires : technicien (INTERNAL), résolution, bascule INTERNAL→SHARED irréversible, et édition / suppression douce tracées — côté API + cockpit + portail.

**Architecture:** Migration n°13 (3 colonnes sur `comments`), puis mutations dans `CommentsService`/`CommentsController` (interne) et projection portail, enfin l'UI cockpit et portail. La cloison INTERNAL/SHARED reste DB-enforced par `comments_scope`.

**Tech Stack:** NestJS (SWC), Prisma + PostgreSQL RLS, `withScope` ; React 18 + TanStack Query 5 + Tailwind ; Vitest + supertest.

## Global Constraints

- Toute requête DB via `withScope(scope, tx => …)`. La cloison INTERNAL/SHARED reste portée par `comments_scope` — jamais réimplémentée.
- 404 (RLS) si comment/contrat hors scope ; **403** si visible mais rôle/auteur insuffisant ; **409** sur transition invalide (déjà SHARED, édition d'un supprimé).
- Rôles : INTERNAL_ROLES = `['MSP_ADMIN','ACCOUNT_MANAGER','LEGAL_REVIEWER','TECHNICIAN']` ; SHARE_ROLES = `['MSP_ADMIN','ACCOUNT_MANAGER','LEGAL_REVIEWER']`. POST INTERNAL → INTERNAL_ROLES ; POST/PATCH SHARED → SHARE_ROLES ; edit/delete → route ouverte aux INTERNAL_ROLES puis le service exige **auteur ou MSP_ADMIN** (403 sinon).
- Suppression **douce** : `deletedAt`/`deletedByUserId` posés, ligne conservée ; `body` = `null` dans **toutes** les projections (interne + portail).
- Nouvelles colonnes `comments` : `edited_at timestamptz?`, `deleted_at timestamptz?`, `deleted_by_user_id uuid?`. `resolvedAt`/`resolvedByUserId` existent déjà.
- Migrations = fichier SQL manuscrit dans un dossier numéroté, appliqué par `prisma migrate deploy` (service `migrate`). Le schéma Prisma doit refléter les colonnes pour le client généré.
- IDs `uuidv7`. Imports ESM `.js`. Fetch cockpit `apiGet/apiPost/apiPatch/apiDelete`, portail `portalGet/portalPost`.

---

### Task 1: Migration n°13 + schéma Prisma

**Files:**
- Create: `packages/persistence/prisma/migrations/00000000000013_comment_edit_soft_delete/migration.sql`
- Modify: `packages/persistence/prisma/schema.prisma` (modèle `Comment`)

**Interfaces:**
- Produces: colonnes `comments.edited_at`, `comments.deleted_at`, `comments.deleted_by_user_id` + champs Prisma `editedAt`, `deletedAt`, `deletedByUserId`.

- [ ] **Step 1: Écrire la migration SQL**

Créer `packages/persistence/prisma/migrations/00000000000013_comment_edit_soft_delete/migration.sql` :

```sql
-- §6.10 différée B : traçage édition + suppression douce des commentaires.
-- Aucune policy RLS à changer : comments_scope est au niveau ligne, indépendant
-- des colonnes. La suppression est DOUCE (la ligne reste, le corps est masqué
-- côté application) pour préserver une trace en l'absence de journal d'audit.
ALTER TABLE comments
  ADD COLUMN edited_at          timestamptz,
  ADD COLUMN deleted_at         timestamptz,
  ADD COLUMN deleted_by_user_id uuid;
```

- [ ] **Step 2: Refléter dans le schéma Prisma**

Dans `packages/persistence/prisma/schema.prisma`, modèle `Comment`, ajouter après `resolvedByUserId` (avant `createdAt`) :

```prisma
  editedAt         DateTime? @map("edited_at")
  deletedAt        DateTime? @map("deleted_at")
  deletedByUserId  String?   @map("deleted_by_user_id") @db.Uuid
```

- [ ] **Step 3: Générer le client + valider le schéma**

Run: `pnpm --filter @lsi/persistence exec prisma generate`
Expected: client régénéré, aucune erreur de schéma.

- [ ] **Step 4: Appliquer la migration en base de test et lancer une suite existante**

Run: `pnpm --filter @lsi/api test -- comments-internal`
Expected: PASS (le harness de test applique les migrations ; les colonnes existent, aucune régression).

- [ ] **Step 5: Commit**

```bash
git add packages/persistence/prisma/migrations/00000000000013_comment_edit_soft_delete packages/persistence/prisma/schema.prisma
git commit -m "feat(db): migration 13 — comments.edited_at / deleted_at / deleted_by_user_id"
```

---

### Task 2: API interne — technicien, résolution, partage, édition, suppression douce

**Files:**
- Modify: `apps/api/src/comments/comments.service.ts`
- Modify: `apps/api/src/comments/comments.controller.ts`
- Create: `apps/api/src/comments/dto/edit-comment.dto.ts`
- Test: `apps/api/tests/isolation/comments-actions.test.ts`

**Interfaces:**
- Consumes: `withScope`, `uuidv7`, `type Scope` ; `assertRole`, `CurrentScope`, `CurrentSession`.
- Produces (méthodes `CommentsService`) :
  - `resolve(scope, contractId, commentId, resolverUserId, now): Promise<{ ok: true }>`
  - `unresolve(scope, contractId, commentId): Promise<{ ok: true }>`
  - `share(scope, contractId, commentId, now): Promise<{ ok: true }>`
  - `edit(scope, contractId, commentId, actorUserId, isAdmin, body, now): Promise<{ ok: true }>`
  - `softDelete(scope, contractId, commentId, actorUserId, isAdmin, now): Promise<{ ok: true }>`
  - `listInternal` renvoie désormais `resolvedAt, editedAt, deletedAt` et `body=null` si supprimé.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `apps/api/tests/isolation/comments-actions.test.ts` :

```ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { adminScope, internalScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;

async function seedContract() {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.contract.create({ data: {
    id, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `LSI-CA-${id.slice(-8)}`,
    title: 'Actions', type: 'MAIN', status: 'ACTIVE', category: 'MAINTENANCE',
    currency: 'EUR', billingFrequency: 'MONTHLY', ownerUserId: fx.amUserId,
    createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId } }));
  return id;
}
async function seedComment(contractId: string, authorUserId: string, visibility: 'INTERNAL'|'SHARED') {
  const id = uuidv7(); const now = new Date();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.comment.create({ data: {
    id, tenantId: fx.tenantId, customerId: fx.customerA.id, contractId, authorUserId,
    visibility, body: `corps ${visibility}`, createdAt: now, updatedAt: now } }));
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({ sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
  await sessions.put({ sessionId: 'sess-admin', userId: fx.adminUserId, tenantId: fx.tenantId,
    roles: ['MSP_ADMIN'], scope: adminScope(fx.tenantId, fx.adminUserId) }, 3600);
  await sessions.put({ sessionId: 'sess-tech', userId: fx.amBUserId, tenantId: fx.tenantId,
    roles: ['TECHNICIAN'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amBUserId) }, 3600);
});
const req = (s: string, m: 'get'|'post'|'patch'|'delete', p: string) => request(app.getHttpServer())[m](p).set('x-lsi-session', s);

describe('commentaires — actions & états', () => {
  test('TECHNICIAN peut poster INTERNAL mais pas SHARED', async () => {
    const c = await seedContract();
    await req('sess-tech', 'post', `/v1/contracts/${c}/comments`).send({ body: 'note tech', visibility: 'INTERNAL' }).expect(201);
    await req('sess-tech', 'post', `/v1/contracts/${c}/comments`).send({ body: 'partage tech', visibility: 'SHARED' }).expect(403);
    // et il voit bien la liste interne
    await req('sess-tech', 'get', `/v1/contracts/${c}/comments`).expect(200);
  });

  test('resolve / unresolve pose puis efface resolvedAt', async () => {
    const c = await seedContract(); const m = await seedComment(c, fx.amUserId, 'INTERNAL');
    await req('sess-am-a', 'post', `/v1/contracts/${c}/comments/${m}/resolve`).expect(201);
    let list = await req('sess-am-a', 'get', `/v1/contracts/${c}/comments`).expect(200);
    expect(list.body.items.find((i: any) => i.id === m).resolvedAt).not.toBeNull();
    await req('sess-am-a', 'post', `/v1/contracts/${c}/comments/${m}/unresolve`).expect(201);
    list = await req('sess-am-a', 'get', `/v1/contracts/${c}/comments`).expect(200);
    expect(list.body.items.find((i: any) => i.id === m).resolvedAt).toBeNull();
  });

  test('share : INTERNAL→SHARED, puis 409 si déjà partagé', async () => {
    const c = await seedContract(); const m = await seedComment(c, fx.amUserId, 'INTERNAL');
    await req('sess-am-a', 'patch', `/v1/contracts/${c}/comments/${m}/share`).expect(200);
    const list = await req('sess-am-a', 'get', `/v1/contracts/${c}/comments`).expect(200);
    expect(list.body.items.find((i: any) => i.id === m).visibility).toBe('SHARED');
    await req('sess-am-a', 'patch', `/v1/contracts/${c}/comments/${m}/share`).expect(409);
  });

  test('édition : auteur OK (editedAt posé), non-auteur 403, admin OK', async () => {
    const c = await seedContract(); const m = await seedComment(c, fx.amUserId, 'INTERNAL');
    await req('sess-am-a', 'patch', `/v1/contracts/${c}/comments/${m}`).send({ body: 'corrigé' }).expect(200);
    const list = await req('sess-am-a', 'get', `/v1/contracts/${c}/comments`).expect(200);
    const it = list.body.items.find((i: any) => i.id === m);
    expect(it.body).toBe('corrigé'); expect(it.editedAt).not.toBeNull();
    // technicien (non-auteur, non-admin) → 403
    await req('sess-tech', 'patch', `/v1/contracts/${c}/comments/${m}`).send({ body: 'hack' }).expect(403);
    // admin → OK
    await req('sess-admin', 'patch', `/v1/contracts/${c}/comments/${m}`).send({ body: 'admin edit' }).expect(200);
  });

  test('suppression douce : body masqué partout, édition d’un supprimé → 409', async () => {
    const c = await seedContract(); const m = await seedComment(c, fx.amUserId, 'INTERNAL');
    await req('sess-am-a', 'delete', `/v1/contracts/${c}/comments/${m}`).expect(200);
    const list = await req('sess-am-a', 'get', `/v1/contracts/${c}/comments`).expect(200);
    const it = list.body.items.find((i: any) => i.id === m);
    expect(it.body).toBeNull(); expect(it.deletedAt).not.toBeNull();
    // la ligne existe toujours en base (suppression douce)
    const rows = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.comment.findMany({ where: { id: m }, select: { deletedAt: true, body: true } }));
    expect(rows).toHaveLength(1); expect(rows[0].deletedAt).not.toBeNull();
    // éditer un supprimé → 409
    await req('sess-am-a', 'patch', `/v1/contracts/${c}/comments/${m}`).send({ body: 'x' }).expect(409);
  });

  test('non-auteur non-admin ne peut pas supprimer (403)', async () => {
    const c = await seedContract(); const m = await seedComment(c, fx.amUserId, 'INTERNAL');
    await req('sess-tech', 'delete', `/v1/contracts/${c}/comments/${m}`).expect(403);
  });
});
```

- [ ] **Step 2: Lancer le test — échoue**

Run: `pnpm --filter @lsi/api test -- comments-actions`
Expected: FAIL (routes/champs absents).

- [ ] **Step 3: Créer le DTO d'édition**

`apps/api/src/comments/dto/edit-comment.dto.ts` :

```ts
import { IsString, MaxLength, MinLength } from 'class-validator';

export class EditCommentDto {
  @IsString()
  @MinLength(1, { message: 'Le commentaire ne peut pas être vide.' })
  @MaxLength(5000, { message: 'Commentaire trop long (5000 caractères max).' })
  body!: string;
}
```

- [ ] **Step 4: Étendre le service**

Dans `apps/api/src/comments/comments.service.ts`, remplacer le `import` par
`import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';`
(garder l'import `@lsi/persistence`), mettre à jour `listInternal` et ajouter un
helper + les 5 méthodes :

```ts
  /** Commentaire du contrat, visible sous scope (sinon 404). */
  private async loadComment(tx: any, contractId: string, commentId: string) {
    const cm = await tx.comment.findFirst({
      where: { id: commentId, contractId },
      select: { id: true, authorUserId: true, visibility: true, deletedAt: true },
    });
    if (!cm) throw new NotFoundException('Commentaire introuvable'); // RLS → 404 hors scope
    return cm;
  }
```

Remplacer le `select`/`map` de `listInternal` par :

```ts
      const rows = await tx.comment.findMany({
        where: { contractId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, body: true, visibility: true, createdAt: true, authorUserId: true,
          resolvedAt: true, editedAt: true, deletedAt: true,
          author: { select: { fullName: true } },
        },
      });
      return rows.map((r: any) => ({
        id: r.id, body: r.deletedAt ? null : r.body, visibility: r.visibility,
        authorUserId: r.authorUserId,
        resolvedAt: r.resolvedAt, editedAt: r.editedAt, deletedAt: r.deletedAt,
        author: { fullName: r.author.fullName }, createdAt: r.createdAt,
      }));
```

Ajouter les méthodes (dans la classe) :

```ts
  async resolve(scope: Scope, contractId: string, commentId: string, resolverUserId: string, now: Date) {
    return withScope(scope, async (tx) => {
      await this.loadComment(tx, contractId, commentId);
      await tx.comment.update({ where: { id: commentId }, data: { resolvedAt: now, resolvedByUserId: resolverUserId, updatedAt: now } });
      return { ok: true as const };
    });
  }

  async unresolve(scope: Scope, contractId: string, commentId: string, now: Date) {
    return withScope(scope, async (tx) => {
      await this.loadComment(tx, contractId, commentId);
      await tx.comment.update({ where: { id: commentId }, data: { resolvedAt: null, resolvedByUserId: null, updatedAt: now } });
      return { ok: true as const };
    });
  }

  async share(scope: Scope, contractId: string, commentId: string, now: Date) {
    return withScope(scope, async (tx) => {
      const cm = await this.loadComment(tx, contractId, commentId);
      if (cm.visibility === 'SHARED') throw new ConflictException({ code: 'ALREADY_SHARED', detail: 'Commentaire déjà partagé.' });
      await tx.comment.update({ where: { id: commentId }, data: { visibility: 'SHARED', updatedAt: now } });
      return { ok: true as const };
    });
  }

  async edit(scope: Scope, contractId: string, commentId: string, actorUserId: string, isAdmin: boolean, body: string, now: Date) {
    return withScope(scope, async (tx) => {
      const cm = await this.loadComment(tx, contractId, commentId);
      if (cm.authorUserId !== actorUserId && !isAdmin) throw new ForbiddenException('Seul l’auteur ou un administrateur peut modifier ce commentaire.');
      if (cm.deletedAt) throw new ConflictException({ code: 'COMMENT_DELETED', detail: 'Commentaire supprimé.' });
      await tx.comment.update({ where: { id: commentId }, data: { body, editedAt: now, updatedAt: now } });
      return { ok: true as const };
    });
  }

  async softDelete(scope: Scope, contractId: string, commentId: string, actorUserId: string, isAdmin: boolean, now: Date) {
    return withScope(scope, async (tx) => {
      const cm = await this.loadComment(tx, contractId, commentId);
      if (cm.authorUserId !== actorUserId && !isAdmin) throw new ForbiddenException('Seul l’auteur ou un administrateur peut supprimer ce commentaire.');
      if (!cm.deletedAt) {
        await tx.comment.update({ where: { id: commentId }, data: { deletedAt: now, deletedByUserId: actorUserId, updatedAt: now } });
      }
      return { ok: true as const };
    });
  }
```

- [ ] **Step 5: Étendre le contrôleur**

Remplacer `apps/api/src/comments/comments.controller.ts` par :

```ts
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import { CurrentScope, CurrentSession, assertRole } from '../auth/current-scope.decorator.js';
import type { Session } from '../auth/session.service.js';
import { CommentsService } from './comments.service.js';
import { CreateCommentDto } from './dto/create-comment.dto.js';
import { EditCommentDto } from './dto/edit-comment.dto.js';

const INTERNAL_ROLES = ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER', 'TECHNICIAN'] as const;
const SHARE_ROLES = ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER'] as const;

@Controller('v1/contracts')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get(':id/comments')
  async list(@CurrentScope() scope: Scope, @CurrentSession() session: Session, @Param('id', ParseUUIDPipe) id: string) {
    assertRole(session, [...INTERNAL_ROLES]);
    const items = await this.comments.listInternal(scope, id);
    return { items };
  }

  @Post(':id/comments')
  async create(
    @CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateCommentDto,
  ) {
    const visibility = dto.visibility ?? 'INTERNAL';
    assertRole(session, visibility === 'SHARED' ? [...SHARE_ROLES] : [...INTERNAL_ROLES]);
    return this.comments.createInternal(scope, session.userId, id, dto.body, visibility, new Date());
  }

  @Post(':id/comments/:commentId/resolve')
  resolve(@CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Param('commentId', ParseUUIDPipe) commentId: string) {
    assertRole(session, [...INTERNAL_ROLES]);
    return this.comments.resolve(scope, id, commentId, session.userId, new Date());
  }

  @Post(':id/comments/:commentId/unresolve')
  unresolve(@CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Param('commentId', ParseUUIDPipe) commentId: string) {
    assertRole(session, [...INTERNAL_ROLES]);
    return this.comments.unresolve(scope, id, commentId, new Date());
  }

  @Patch(':id/comments/:commentId/share')
  share(@CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Param('commentId', ParseUUIDPipe) commentId: string) {
    assertRole(session, [...SHARE_ROLES]);
    return this.comments.share(scope, id, commentId, new Date());
  }

  @Patch(':id/comments/:commentId')
  edit(@CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() dto: EditCommentDto) {
    assertRole(session, [...INTERNAL_ROLES]);
    return this.comments.edit(scope, id, commentId, session.userId, session.roles.includes('MSP_ADMIN'), dto.body, new Date());
  }

  @Delete(':id/comments/:commentId')
  remove(@CurrentScope() scope: Scope, @CurrentSession() session: Session,
    @Param('id', ParseUUIDPipe) id: string, @Param('commentId', ParseUUIDPipe) commentId: string) {
    assertRole(session, [...INTERNAL_ROLES]);
    return this.comments.softDelete(scope, id, commentId, session.userId, session.roles.includes('MSP_ADMIN'), new Date());
  }
}
```

- [ ] **Step 6: Lancer le test — passe**

Run: `pnpm --filter @lsi/api test -- comments-actions`
Expected: PASS (6/6).

- [ ] **Step 7: Non-régression commentaires**

Run: `pnpm --filter @lsi/api test -- comments`
Expected: PASS (comments-internal + comments-actions).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/comments apps/api/tests/isolation/comments-actions.test.ts
git commit -m "feat(comments): technicien INTERNAL + resolve/share/edit/soft-delete (auteur ou admin, 403/409)"
```

---

### Task 3: API portail — corps masqué si supprimé + marqueur editedAt

**Files:**
- Modify: `apps/api/src/portal/portal.service.ts` (`listComments`)
- Test: `apps/api/tests/isolation/portal-comments.test.ts` (ajouter un test)

**Interfaces:**
- Consumes: colonnes `deletedAt`/`editedAt` (Task 1).
- Produces: la projection portail expose `editedAt` et masque `body` (null) pour un commentaire supprimé.

- [ ] **Step 1: Ajouter le test qui échoue**

Dans `apps/api/tests/isolation/portal-comments.test.ts`, ajouter ce test à la fin du `describe` (réutilise les helpers `seedContract`/`seedComment` déjà présents dans ce fichier ; si `seedComment` n'accepte pas encore d'override d'état, créer le commentaire puis le mettre à jour via `adminScope`) :

```ts
  test('un commentaire SHARED supprimé apparaît masqué (body null) au portail', async () => {
    const id = await seedContract(fx.customerA.id, fx.amUserId);
    const cid = uuidv7(); const now = new Date();
    await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.comment.create({ data: {
      id: cid, tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id, authorUserId: fx.amUserId,
      visibility: 'SHARED', body: 'à supprimer', editedAt: now, deletedAt: now, deletedByUserId: fx.amUserId,
      createdAt: now, updatedAt: now } }));
    const res = await asClient('get', `/v1/portal/contracts/${id}/comments`).expect(200);
    const it = res.body.items.find((i: any) => i.id === cid);
    expect(it).toBeTruthy();
    expect(it.body).toBeNull();
    expect(it.deletedAt).not.toBeNull();
    expect(it.editedAt).not.toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('à supprimer');
  });
```

- [ ] **Step 2: Lancer le test — échoue**

Run: `pnpm --filter @lsi/api test -- portal-comments`
Expected: FAIL (body renvoie « à supprimer », `deletedAt`/`editedAt` absents).

- [ ] **Step 3: Étendre `listComments`**

Dans `apps/api/src/portal/portal.service.ts`, remplacer le `select` et le `map`
de `listComments` par :

```ts
      const rows = await tx.comment.findMany({
        where: { contractId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, body: true, createdAt: true, authorUserId: true, editedAt: true, deletedAt: true },
      });
      return rows.map((r) => ({
        id: r.id, body: r.deletedAt ? null : r.body,
        author: r.authorUserId === scope.userId
          ? { fullName: 'Vous', kind: 'CLIENT' as const }
          : { fullName: 'LSI', kind: 'INTERNAL' as const },
        editedAt: r.editedAt, deletedAt: r.deletedAt,
        createdAt: r.createdAt,
      }));
```

- [ ] **Step 4: Lancer le test — passe**

Run: `pnpm --filter @lsi/api test -- portal-comments`
Expected: PASS (tous, dont le nouveau).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/portal/portal.service.ts apps/api/tests/isolation/portal-comments.test.ts
git commit -m "feat(portail): commentaire supprimé masqué (body null) + marqueur editedAt"
```

---

### Task 4: Frontend cockpit — actions & états dans CommentsBlock

**Files:**
- Modify: `apps/web/src/features/contracts/comments-block.tsx`
- Test: `apps/web/src/test/comments-block.test.tsx` (ajouter des tests)

**Interfaces:**
- Consumes: `apiPost`, `apiPatch`, `apiDelete` (`../../lib/api.js`) ; `useMe` (`../../lib/queries.js`) pour l'auteur/rôle ; endpoints Task 2.
- Produces: actions (Résoudre/Rouvrir, Partager, Modifier, Supprimer) + rendu des états.

- [ ] **Step 1: Ajouter les tests qui échouent**

Dans `apps/web/src/test/comments-block.test.tsx`, ajouter (le fichier stubbe déjà `fetch`) :

```tsx
test('un commentaire résolu est marqué, un supprimé affiche « message supprimé »', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [
    { id: 'm1', body: 'Traité', visibility: 'INTERNAL', resolvedAt: '2026-07-21T10:00:00Z', editedAt: null, deletedAt: null, author: { fullName: 'Marc D.' }, createdAt: '2026-07-21T09:00:00Z' },
    { id: 'm2', body: null, visibility: 'SHARED', resolvedAt: null, editedAt: null, deletedAt: '2026-07-21T11:00:00Z', author: { fullName: 'Marc D.' }, createdAt: '2026-07-21T09:00:00Z' },
  ] }), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap();
  await waitFor(() => expect(screen.getByText('Traité')).toBeInTheDocument());
  expect(screen.getByText(/Résolu/i)).toBeInTheDocument();
  expect(screen.getByText(/message supprimé/i)).toBeInTheDocument();
});
```

*(Note : `wrap()` doit fournir un `me` — voir Step 3 : le composant lit `useMe`. Si `wrap` ne monte pas de provider `me`, le stub `fetch` renvoie déjà `{items}` pour `/comments` ; ajouter une branche `if (url.endsWith('/auth/me')) return me` dans le stub, avec `me = { userId: 'u1', roles: ['MSP_ADMIN'] }`.)*

- [ ] **Step 2: Lancer le test — échoue**

Run: `pnpm --filter @lsi/web test -- comments-block`
Expected: FAIL (états non rendus).

- [ ] **Step 3: Étendre `CommentsBlock`**

Dans `apps/web/src/features/contracts/comments-block.tsx` :

1. Enrichir l'interface `Comment` : ajouter `resolvedAt: string | null; editedAt: string | null; deletedAt: string | null;`.
2. Importer `apiPatch, apiDelete` (en plus de `apiGet, apiPost`) et `useMe` (`import { useMe } from '../../lib/queries.js';`).
3. Dans le composant, `const me = useMe();` et des mutations :

```tsx
  const act = (fn: () => Promise<unknown>) => { fn().then(() => qc.invalidateQueries({ queryKey: ['comments', contractId] })); };
  const resolve = (id: string, on: boolean) => act(() => apiPost(`/v1/contracts/${contractId}/comments/${id}/${on ? 'resolve' : 'unresolve'}`, {}));
  const share = (id: string) => { if (confirm('Partager ce commentaire avec le client ? (irréversible)')) act(() => apiPatch(`/v1/contracts/${contractId}/comments/${id}/share`, {})); };
  const remove = (id: string) => { if (confirm('Supprimer ce commentaire ?')) act(() => apiDelete(`/v1/contracts/${contractId}/comments/${id}`)); };
  const saveEdit = (id: string, body: string) => act(() => apiPatch(`/v1/contracts/${contractId}/comments/${id}`, { body }));
```

4. Dans le rendu de chaque commentaire `c` :
   - Si `c.deletedAt` : afficher `<span className="italic text-gray-400">message supprimé</span>` et **aucune** action.
   - Sinon : afficher `c.body`, plus les marqueurs — `c.editedAt` → `<span className="text-xs text-gray-400"> (modifié)</span>` ; `c.resolvedAt` → badge/texte `Résolu` + style grisé (`opacity-60`).
   - Actions (boutons texte) sous le corps, gâtées :
     - **Résoudre** si `!c.resolvedAt`, **Rouvrir** si `c.resolvedAt` → `resolve(c.id, !c.resolvedAt)`.
     - **Partager avec le client** si `c.visibility === 'INTERNAL'` → `share(c.id)`.
     - **Modifier** et **Supprimer** si `me.data?.userId === c.authorUserId || me.data?.roles?.includes('MSP_ADMIN')`. La projection interne expose déjà `authorUserId` (ajouté en Task 2) ; l'ajouter à l'interface `Comment` du front.

   Pour l'édition en ligne : un état local `editing: string | null` + un `<textarea>` pré-rempli `c.body`, boutons Enregistrer (`saveEdit`) / Annuler.

- [ ] **Step 4: Lancer le test — passe**

Run: `pnpm --filter @lsi/web test -- comments-block`
Expected: PASS.

- [ ] **Step 5: Build**

Run: `pnpm --filter @lsi/web build`
Expected: OK.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/contracts/comments-block.tsx apps/web/src/test/comments-block.test.tsx
git commit -m "feat(web/cockpit): actions commentaires (résoudre/partager/modifier/supprimer) + rendu des états"
```

---

### Task 5: Frontend portail — commentaire supprimé + marqueur modifié

**Files:**
- Modify: `apps/web/src/portal/portal-contract-page.tsx` (`CommentsCard`)
- Test: `apps/web/src/test/portal-comments.test.tsx` (ajouter un test)

**Interfaces:**
- Consumes: projection portail (Task 3) avec `editedAt`/`deletedAt`.
- Produces: rendu « message supprimé » + « (modifié) » dans le fil portail.

- [ ] **Step 1: Ajouter le test qui échoue**

Dans `apps/web/src/test/portal-comments.test.tsx`, ajouter :

```tsx
test('le portail affiche « message supprimé » et le marqueur « (modifié) »', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('/comments')) return new Response(JSON.stringify({ items: [
      { id: 'm1', body: null, author: { fullName: 'LSI', kind: 'INTERNAL' }, editedAt: null, deletedAt: '2026-07-21T11:00:00Z', createdAt: '2026-07-21T09:00:00Z' },
      { id: 'm2', body: 'Corrigé', author: { fullName: 'LSI', kind: 'INTERNAL' }, editedAt: '2026-07-21T12:00:00Z', deletedAt: null, createdAt: '2026-07-21T09:00:00Z' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(detail), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as never);
  wrap();
  await waitFor(() => expect(screen.getByText(/message supprimé/i)).toBeInTheDocument());
  expect(screen.getByText(/\(modifié\)/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Lancer le test — échoue**

Run: `pnpm --filter @lsi/web test -- portal-comments`
Expected: FAIL.

- [ ] **Step 3: Étendre `CommentsCard`**

Dans `apps/web/src/portal/portal-contract-page.tsx`, enrichir l'interface
`PortalComment` avec `editedAt: string | null; deletedAt: string | null;` puis,
dans le rendu de chaque message :
- Si `m.deletedAt` : `<span className="italic text-gray-400">message supprimé</span>` à la place du corps.
- Sinon : afficher `m.body`, suivi de `{m.editedAt && <span className="text-xs text-gray-400"> (modifié)</span>}`.

- [ ] **Step 4: Lancer le test — passe**

Run: `pnpm --filter @lsi/web test -- portal-comments`
Expected: PASS.

- [ ] **Step 5: Build + commit**

```bash
pnpm --filter @lsi/web build
git add apps/web/src/portal/portal-contract-page.tsx apps/web/src/test/portal-comments.test.tsx
git commit -m "feat(web/portail): commentaire supprimé masqué + marqueur (modifié)"
```

---

## Self-Review

**Spec coverage :**
- §3 technicien INTERNAL / rôles POST → Task 2 ✅ ; resolve/unresolve → Task 2 ✅ ; share (409) → Task 2 ✅ ; edit (auteur/admin, 409 supprimé) → Task 2 ✅ ; soft-delete → Task 2 ✅ ; projection interne (resolvedAt/editedAt/deletedAt, body masqué) → Task 2 ✅
- §4 portail (editedAt + body masqué) → Task 3 ✅
- §5.1 cockpit états + actions → Task 4 ✅ ; §5.2 portail états → Task 5 ✅
- Migration colonnes → Task 1 ✅
- §6 sécurité (403 rôle/auteur, 404 scope, 409 transitions, body jamais exposé) → tests Task 2/3 ✅

**Placeholders :** aucun code laissé en TODO ; les extraits sont complets. La seule zone descriptive (Task 4 Step 3, rendu JSX des actions) précise exactement les conditions de gâchette et les handlers ; l'implémenteur assemble le JSX en suivant le pattern existant du composant.

**Cohérence des types :** endpoints `resolve/unresolve/share/edit/delete` (Task 2 contrôleur) ↔ appels front (Task 4). `authorUserId` exposé par `listInternal` (Task 2, requis par Task 4 — noté explicitement). Projection portail `editedAt/deletedAt` (Task 3) ↔ front portail (Task 5). Migration (Task 1) fournit les colonnes consommées par Task 2/3.

## Execution Handoff

Plan sauvegardé. Exécution en **subagent-driven-development**.
