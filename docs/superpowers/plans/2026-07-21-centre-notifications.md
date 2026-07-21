# Centre de notifications — cloche cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Afficher les notifications internes déjà stockées via une cloche cockpit (compteur non-lues, marquage lu, navigation vers le contrat lié).

**Architecture:** Un `NotificationsService` + `NotificationsController` (`/v1/notifications`) qui lit **la boîte du destinataire courant** (RLS `notifications_scope`), et un composant `NotificationBell` monté dans `AppShell`. Aucune migration.

**Tech Stack:** NestJS (SWC), Prisma + PostgreSQL RLS, `withScope` ; React 18 + TanStack Query 5 + Tailwind ; Vitest + supertest.

## Global Constraints

- Toute requête DB via `withScope(scope, tx => …)` — jamais de Prisma nu. La RLS restreint au destinataire ; le service ne lit jamais `recipientUserId` depuis l'entrée.
- « Non-lue » = `readAt IS NULL`. Marquer lu = `status='READ'` + `readAt=now`.
- 404 (jamais 403) quand on cible une notification qui n'est pas la sienne (0 ligne sous RLS).
- Aucun `assertRole` : tout utilisateur interne a une boîte ; le `ClientPortalGuard` global bloque déjà toute session CLIENT hors `/v1/portal/*`.
- Modèle `Notification` (existant) : `id, tenantId, customerId?, recipientUserId, channel(IN_APP déf.), type(String), subject, body, relatedContractId?, status(QUEUED déf.), readAt?, createdAt`.
- IDs via `uuidv7()`. Imports ESM `.js`. Fetch cockpit via `apiGet/apiPatch/apiPost` de `../../lib/api.js`.

---

### Task 1: API — module notifications

**Files:**
- Create: `apps/api/src/notifications/notifications.service.ts`
- Create: `apps/api/src/notifications/notifications.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/tests/isolation/notifications.test.ts`

**Interfaces:**
- Consumes: `withScope`, `type Scope` de `@lsi/persistence` ; `CurrentScope` de `../auth/current-scope.decorator.js`.
- Produces:
  - `NotificationsService.list(scope): Promise<{ items: {...}[]; unreadCount: number }>`
  - `NotificationsService.markRead(scope, id: string, now: Date): Promise<{ ok: true }>`
  - `NotificationsService.markAllRead(scope, now: Date): Promise<{ count: number }>`

- [ ] **Step 1: Écrire le test qui échoue**

Créer `apps/api/tests/isolation/notifications.test.ts` :

```ts
import { describe, test, expect, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { systemScope, internalScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

let app: INestApplication; let fx: TwoCustomerFixture;

async function seedNotif(recipientUserId: string, customerId: string, subject: string, readAt: Date | null = null) {
  const id = uuidv7(); const now = new Date();
  await withScope(systemScope(fx.tenantId, customerId), (tx) => tx.notification.create({ data: {
    id, tenantId: fx.tenantId, customerId, recipientUserId, type: 'CLIENT_COMMENT',
    subject, body: 'corps', status: readAt ? 'READ' : 'QUEUED', readAt, createdAt: now } }));
  return id;
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); await app.init();
  fx = await seedTwoCustomers();
  const sessions = app.get(SessionService);
  await sessions.put({ sessionId: 'sess-am-a', userId: fx.amUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) }, 3600);
  await sessions.put({ sessionId: 'sess-am-b', userId: fx.amBUserId, tenantId: fx.tenantId,
    roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId) }, 3600);
});
const as = (s: string) => (m: 'get'|'post'|'patch', p: string) => request(app.getHttpServer())[m](p).set('x-lsi-session', s);
const asA = as('sess-am-a'); const asB = as('sess-am-b');

describe('centre de notifications', () => {
  test('chacun ne voit que sa boîte, avec unreadCount', async () => {
    await seedNotif(fx.amUserId, fx.customerA.id, 'Pour A #1');
    await seedNotif(fx.amUserId, fx.customerA.id, 'Pour A #2', new Date());
    await seedNotif(fx.amBUserId, fx.customerB.id, 'Pour B #1');
    const a = await asA('get', '/v1/notifications').expect(200);
    const subjectsA = a.body.items.map((i: any) => i.subject);
    expect(subjectsA).toContain('Pour A #1');
    expect(subjectsA).toContain('Pour A #2');
    expect(subjectsA).not.toContain('Pour B #1');
    expect(a.body.unreadCount).toBe(1); // seul « Pour A #1 » est non-lu
  });

  test('PATCH /:id/read marque lu et fait baisser unreadCount', async () => {
    const id = await seedNotif(fx.amUserId, fx.customerA.id, 'À lire');
    const before = (await asA('get', '/v1/notifications').expect(200)).body.unreadCount;
    await asA('patch', `/v1/notifications/${id}/read`).expect(200);
    const after = (await asA('get', '/v1/notifications').expect(200)).body.unreadCount;
    expect(after).toBe(before - 1);
  });

  test('marquer lue la notif d’un autre → 404 (jamais 403), sans effet', async () => {
    const id = await seedNotif(fx.amBUserId, fx.customerB.id, 'Boîte de B');
    await asA('patch', `/v1/notifications/${id}/read`).expect(404);
    // toujours non-lue pour B
    const b = await asB('get', '/v1/notifications').expect(200);
    expect(b.body.items.find((i: any) => i.id === id)?.readAt).toBeNull();
  });

  test('read-all ne touche que mes non-lues', async () => {
    await seedNotif(fx.amUserId, fx.customerA.id, 'reste-1');
    await seedNotif(fx.amUserId, fx.customerA.id, 'reste-2');
    const res = await asA('post', '/v1/notifications/read-all').expect(201);
    expect(res.body.count).toBeGreaterThanOrEqual(2);
    const a = await asA('get', '/v1/notifications').expect(200);
    expect(a.body.unreadCount).toBe(0);
  });
});
```

- [ ] **Step 2: Lancer le test — échoue**

Run: `pnpm --filter @lsi/api test -- notifications`
Expected: FAIL (routes absentes → 404 / body undefined).

- [ ] **Step 3: Créer le service**

`apps/api/src/notifications/notifications.service.ts` :

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';

const SELECT = {
  id: true, type: true, subject: true, body: true,
  relatedContractId: true, status: true, readAt: true, createdAt: true,
} as const;

@Injectable()
export class NotificationsService {
  async list(scope: Scope) {
    return withScope(scope, async (tx) => {
      const [items, unreadCount] = await Promise.all([
        tx.notification.findMany({ orderBy: { createdAt: 'desc' }, take: 50, select: SELECT }),
        tx.notification.count({ where: { readAt: null } }),
      ]);
      return { items, unreadCount };
    });
  }

  async markRead(scope: Scope, id: string, now: Date) {
    return withScope(scope, async (tx) => {
      try {
        await tx.notification.update({ where: { id }, data: { status: 'READ', readAt: now } });
      } catch (e: any) {
        if (e?.code === 'P2025') throw new NotFoundException('Notification introuvable'); // RLS → pas la mienne
        throw e;
      }
      return { ok: true as const };
    });
  }

  async markAllRead(scope: Scope, now: Date) {
    return withScope(scope, async (tx) => {
      const r = await tx.notification.updateMany({ where: { readAt: null }, data: { status: 'READ', readAt: now } });
      return { count: r.count };
    });
  }
}
```

- [ ] **Step 4: Créer le contrôleur**

`apps/api/src/notifications/notifications.controller.ts` :

```ts
import { Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import { CurrentScope } from '../auth/current-scope.decorator.js';
import { NotificationsService } from './notifications.service.js';

@Controller('v1/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentScope() scope: Scope) {
    return this.notifications.list(scope);
  }

  @Patch(':id/read')
  markRead(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(scope, id, new Date());
  }

  @Post('read-all')
  markAllRead(@CurrentScope() scope: Scope) {
    return this.notifications.markAllRead(scope, new Date());
  }
}
```

- [ ] **Step 5: Câbler dans app.module.ts**

Ajouter les imports :

```ts
import { NotificationsController } from './notifications/notifications.controller.js';
import { NotificationsService } from './notifications/notifications.service.js';
```

Ajouter `NotificationsController` au tableau `controllers` et `NotificationsService` aux `providers`.

- [ ] **Step 6: Lancer le test — passe**

Run: `pnpm --filter @lsi/api test -- notifications`
Expected: PASS (4/4).

- [ ] **Step 7: Non-régression API rapide**

Run: `pnpm --filter @lsi/api test -- notifications portal comments`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/notifications apps/api/src/app.module.ts apps/api/tests/isolation/notifications.test.ts
git commit -m "feat(notifications): API cockpit — liste + unreadCount + marquage lu (RLS boîte du destinataire)"
```

---

### Task 2: Frontend — NotificationBell dans l'en-tête cockpit

**Files:**
- Create: `apps/web/src/features/notifications/notification-bell.tsx`
- Modify: `apps/web/src/shell/app-shell.tsx`
- Modify: `apps/web/src/lib/labels.ts` (ajouter `notificationTypeLabel`)
- Test: `apps/web/src/test/notification-bell.test.tsx`

**Interfaces:**
- Consumes: `apiGet`, `apiPatch`, `apiPost` de `../../lib/api.js` ; endpoints Task 1.
- Produces: `NotificationBell` (composant sans prop).

- [ ] **Step 1: Écrire le test qui échoue**

Créer `apps/web/src/test/notification-bell.test.tsx` :

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NotificationBell } from '../features/notifications/notification-bell.js';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><NotificationBell /></MemoryRouter></QueryClientProvider>);
}

const payload = { items: [{ id: 'n1', type: 'CLIENT_COMMENT', subject: 'Message client', body: 'Bonjour', relatedContractId: 'c1', status: 'QUEUED', readAt: null, createdAt: '2026-07-21T10:00:00Z' }], unreadCount: 1 };

test('affiche la pastille de non-lues puis la liste au clic', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })) as never);
  wrap();
  await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
  expect(screen.getByText('Message client')).toBeInTheDocument();
});

test('« Tout marquer lu » poste sur read-all', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return new Response(JSON.stringify(url.toString().endsWith('read-all') ? { count: 1 } : payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as never);
  wrap();
  await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
  fireEvent.click(screen.getByRole('button', { name: /Tout marquer lu/i }));
  await waitFor(() => expect(calls.some((c) => c.includes('read-all') && c.startsWith('POST'))).toBe(true));
});
```

- [ ] **Step 2: Lancer le test — échoue**

Run: `pnpm --filter @lsi/web test -- notification-bell`
Expected: FAIL (module absent).

- [ ] **Step 3: Ajouter le libellé de type**

Dans `apps/web/src/lib/labels.ts`, ajouter :

```ts
export function notificationTypeLabel(type: string): string {
  if (type === 'CLIENT_COMMENT') return 'Message client';
  if (type.startsWith('REMINDER')) return 'Rappel';
  return type;
}
```

- [ ] **Step 4: Créer le composant**

`apps/web/src/features/notifications/notification-bell.tsx` :

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '../../lib/api.js';
import { notificationTypeLabel } from '../../lib/labels.js';

interface Notif {
  id: string;
  type: string;
  subject: string;
  body: string;
  relatedContractId: string | null;
  status: string;
  readAt: string | null;
  createdAt: string;
}

export function NotificationBell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['notifications'],
    queryFn: () => apiGet<{ items: Notif[]; unreadCount: number }>('/v1/notifications'),
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const readOne = useMutation({ mutationFn: (id: string) => apiPatch(`/v1/notifications/${id}/read`, {}), onSuccess: invalidate });
  const readAll = useMutation({ mutationFn: () => apiPost('/v1/notifications/read-all', {}), onSuccess: invalidate });

  const unread = q.data?.unreadCount ?? 0;
  const items = q.data?.items ?? [];

  const openNotif = (n: Notif) => {
    readOne.mutate(n.id);
    setOpen(false);
    if (n.relatedContractId) navigate(`/contracts/${n.relatedContractId}`);
  };

  return (
    <div className="relative">
      <button
        type="button" aria-label="Notifications" onClick={() => setOpen((o) => !o)}
        className="relative rounded p-1 hover:bg-gray-100"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0a3 3 0 11-6 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-2 w-80 rounded border bg-white shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2 text-sm font-semibold">
            <span>Notifications</span>
            {unread > 0 && (
              <button type="button" onClick={() => readAll.mutate()} className="text-xs text-lsi hover:underline">
                Tout marquer lu
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-3 py-4 text-sm text-gray-400">Aucune notification.</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button" onClick={() => openNotif(n)}
                    className={`flex w-full flex-col items-start gap-0.5 border-b px-3 py-2 text-left text-sm hover:bg-gray-50 ${n.readAt ? 'opacity-60' : ''}`}
                  >
                    <span className="flex items-center gap-2">
                      {!n.readAt && <span className="h-2 w-2 rounded-full bg-red-600" />}
                      <span className="font-medium">{n.subject}</span>
                    </span>
                    <span className="text-xs text-gray-500">{notificationTypeLabel(n.type)} · {new Date(n.createdAt).toLocaleDateString('fr-FR')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Monter la cloche dans AppShell**

Dans `apps/web/src/shell/app-shell.tsx` : importer `import { NotificationBell } from '../features/notifications/notification-bell.js';` et remplacer l'en-tête par :

```tsx
        <header className="flex items-center justify-end gap-4 border-b p-3 text-sm text-gray-600">
          <NotificationBell />
          <span>{me.data?.fullName} · {me.data?.roles?.join(', ')}</span>
        </header>
```

- [ ] **Step 6: Lancer le test — passe**

Run: `pnpm --filter @lsi/web test -- notification-bell`
Expected: PASS (2/2).

- [ ] **Step 7: Build + typecheck web**

Run: `pnpm --filter @lsi/web build`
Expected: build OK.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/notifications/notification-bell.tsx apps/web/src/shell/app-shell.tsx apps/web/src/lib/labels.ts apps/web/src/test/notification-bell.test.tsx
git commit -m "feat(web/cockpit): cloche de notifications (compteur non-lues, marquage lu, navigation contrat)"
```

---

## Self-Review

**Spec coverage :**
- §3.1 GET liste + unreadCount → Task 1 ✅
- §3.2 PATCH :id/read (404 non-propriétaire) → Task 1 ✅
- §3.3 POST read-all → Task 1 ✅
- §4 cloche + panneau + navigation + libellés → Task 2 ✅
- §5 sécurité (boîte du destinataire, 404-jamais-403, read-all borné) → tests Task 1 ✅

**Placeholders :** aucun — code complet à chaque étape.

**Cohérence des types :** `list/markRead/markAllRead` (Task 1) ↔ appels front `['notifications']`, `apiPatch('/v1/notifications/:id/read')`, `apiPost('/v1/notifications/read-all')` (Task 2). `notificationTypeLabel` défini avant usage. Réponse `read-all` = `{count}` (POST → 201). `Notification` seedée avec les champs requis (`id, tenantId, recipientUserId, type, subject, body, status, createdAt`).

## Execution Handoff

Plan sauvegardé. Exécution en **subagent-driven-development**.
