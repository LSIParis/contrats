# Éditeur WYSIWYG pour l'éditeur de modèle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer la `<textarea>` « source HTML » de l'éditeur de modèle par un éditeur riche TipTap (`TemplateEditor`), pour que le texte s'affiche mis en forme (plus de balises visibles), y compris quand un brouillon est généré par l'IA.

**Architecture:** Un composant `TemplateEditor` (TipTap + StarterKit, déjà présents dans le projet — même pattern que `ContentEditor` des contrats), avec une barre d'outils alignée sur l'allowlist du sanitizer serveur, une émission de l'état à chaque frappe (HTML + vide) et une injection de contenu externe (brouillon IA) via un compteur `nonce`. Intégré dans `template-detail-page.tsx` à la place de la textarea ; flux Enregistrer/Publier/Déprécier inchangés côté API.

**Tech Stack:** React 18 + TipTap 2.27 (`@tiptap/react`, `@tiptap/starter-kit`) + Tailwind ; Vitest + Testing-Library.

## Global Constraints

- **Aucune nouvelle dépendance** : `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/pm` sont **déjà** dans `apps/web/package.json`. Suivre le pattern de `apps/web/src/features/contracts/content-editor.tsx`.
- **ESM** : tout import interne porte le suffixe `.js` (ex. `./template-editor.js`).
- **Barre d'outils = StarterKit ∩ allowlist du sanitizer** (`sanitizeContractHtml` : `h1-h3, p, br, strong/b, em/i, u, s, ul, ol, li, blockquote, a`). Boutons exactement : **Gras** (`toggleBold`), **Italique** (`toggleItalic`), **Barré** (`toggleStrike`), **Titre** (`toggleHeading {level:2}`), **Sous-titre** (`toggleHeading {level:3}`), **• Liste** (`toggleBulletList`), **1. Liste** (`toggleOrderedList`), **Citation** (`toggleBlockquote`). **Pas** de souligné ni de lien (extensions non installées).
- **`canPublish` doit s'appuyer sur l'état vide de l'éditeur** (`editor.isEmpty`), PAS sur `html.trim().length` : TipTap représente le vide par `<p></p>`, que `.trim()` juge non vide.
- **Ne pas toucher** au backend ni au `ContentEditor` des contrats.
- Scripts : `pnpm --filter @lsi/web test` (Vitest), `pnpm --filter @lsi/web typecheck`, `pnpm --filter @lsi/web build`.
- Le HTML produit par TipTap (`p, strong, em, s, h2, h3, ul, ol, li, blockquote`) doit passer tel quel l'allowlist serveur — ne rien produire hors allowlist.

---

### Task 1: Composant `TemplateEditor` (TipTap) + test

Éditeur riche autonome : barre d'outils, émission de l'état (HTML + vide) au montage et à chaque frappe, injection de contenu externe via `nonce`.

**Files:**
- Create: `apps/web/src/features/templates/template-editor.tsx`
- Test: `apps/web/src/test/template-editor.test.tsx`

**Interfaces:**
- Produces: `TemplateEditor` — props `{ initialHtml: string; onChange: (html: string) => void; onEmptyChange?: (empty: boolean) => void; inject?: { html: string; nonce: number } }`.
  - Émet `onChange(editor.getHTML())` + `onEmptyChange?.(editor.isEmpty)` **au montage** (une fois l'éditeur prêt) et **à chaque frappe** (`onUpdate`).
  - Quand `inject.nonce` change : `editor.commands.setContent(inject.html)` puis ré-émet `onChange`/`onEmptyChange`.

- [ ] **Step 1: Écrire le test du composant (échec attendu)**

Créer `apps/web/src/test/template-editor.test.tsx` :

```tsx
import { render, screen } from '@testing-library/react';
import { TemplateEditor } from '../features/templates/template-editor.js';

test('affiche la barre d\'outils (Gras, Titre, Citation)', () => {
  render(<TemplateEditor initialHtml="<p>x</p>" onChange={() => {}} />);
  expect(screen.getByRole('button', { name: 'G' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Titre' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Citation' })).toBeInTheDocument();
});

test('émet le HTML initial au montage', () => {
  const onChange = vi.fn();
  render(<TemplateEditor initialHtml="<p>Bonjour</p>" onChange={onChange} />);
  expect(onChange).toHaveBeenCalled();
  expect(String(onChange.mock.calls.at(-1)![0])).toContain('Bonjour');
});

test('remonte l\'état « vide » au montage', () => {
  const onEmptyChange = vi.fn();
  render(<TemplateEditor initialHtml="<p>Du contenu</p>" onChange={() => {}} onEmptyChange={onEmptyChange} />);
  expect(onEmptyChange).toHaveBeenLastCalledWith(false);
});

test('injecte un nouveau contenu quand nonce change (brouillon IA)', () => {
  const onChange = vi.fn();
  const { rerender } = render(<TemplateEditor initialHtml="<p>vide</p>" onChange={onChange} />);
  onChange.mockClear();
  rerender(
    <TemplateEditor initialHtml="<p>vide</p>" onChange={onChange} inject={{ html: '<p>Nouveau brouillon IA</p>', nonce: 1 }} />,
  );
  expect(String(onChange.mock.calls.at(-1)![0])).toContain('Nouveau brouillon IA');
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `pnpm --filter @lsi/web test -- template-editor`
Expected: FAIL (module `template-editor` introuvable).

- [ ] **Step 3: Créer le composant**

`apps/web/src/features/templates/template-editor.tsx` :

```tsx
import { useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

interface Props {
  initialHtml: string;
  onChange: (html: string) => void;
  onEmptyChange?: (empty: boolean) => void;
  /** Recharge le contenu de l'éditeur quand `nonce` change (ex. brouillon IA). */
  inject?: { html: string; nonce: number };
}

export function TemplateEditor({ initialHtml, onChange, onEmptyChange, inject }: Props) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: initialHtml,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
      onEmptyChange?.(editor.isEmpty);
    },
  });

  // Émet l'état initial une fois l'éditeur prêt (montage / remontage via `key`).
  // onChange/onEmptyChange volontairement hors deps : ce sont des closures
  // recréées à chaque render de la page ; les inclure re-déclencherait l'effet
  // en boucle. On veut une seule émission par instance d'éditeur.
  useEffect(() => {
    if (!editor) return;
    onChange(editor.getHTML());
    onEmptyChange?.(editor.isEmpty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Injection d'un brouillon (ex. IA) : recharge le contenu quand nonce change.
  useEffect(() => {
    if (!editor || !inject) return;
    editor.commands.setContent(inject.html);
    onChange(editor.getHTML());
    onEmptyChange?.(editor.isEmpty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inject?.nonce]);

  const tb = 'rounded border px-2 py-1 text-sm hover:bg-gray-100';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleBold().run()}><b>G</b></button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleItalic().run()}><i>I</i></button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleStrike().run()}><s>S</s></button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>Titre</button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}>Sous-titre</button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleBulletList().run()}>• Liste</button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>1. Liste</button>
        <button type="button" className={tb} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>Citation</button>
      </div>
      <div className="rounded border p-3 min-h-[240px] prose max-w-none">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Lancer le test pour vérifier le succès**

Run: `pnpm --filter @lsi/web test -- template-editor`
Expected: PASS (4 tests).

> Si TipTap émet un avertissement `immediatelyRender` sous jsdom (SSR) faisant échouer un test, aligner sur `ContentEditor` — et, seulement si nécessaire, passer `immediatelyRender: false` à `useEditor`. Ne pas changer autre chose.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @lsi/web typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/templates/template-editor.tsx apps/web/src/test/template-editor.test.tsx
git commit -m "feat(web): composant TemplateEditor (WYSIWYG TipTap) pour l'éditeur de modèle"
```

---

### Task 2: Intégrer `TemplateEditor` dans l'éditeur de modèle

Remplacer la textarea, piloter `canPublish` par l'état vide de l'éditeur, charger le brouillon IA dans l'éditeur via `inject`.

**Files:**
- Modify: `apps/web/src/features/templates/template-detail-page.tsx`

**Interfaces:**
- Consumes: `TemplateEditor` (Task 1).

- [ ] **Step 1: Remplacer la textarea et brancher l'état**

Dans `apps/web/src/features/templates/template-detail-page.tsx` :

1. Ajouter l'import :
```tsx
import { TemplateEditor } from './template-editor.js';
```

2. Ajouter deux états près de `const [bodyHtml, setBodyHtml] = useState<string | null>(null);` :
```tsx
  const [editorEmpty, setEditorEmpty] = useState(true);
  const [inject, setInject] = useState<{ html: string; nonce: number } | undefined>(undefined);
```

3. Rediriger la génération IA vers l'éditeur (injection) au lieu de remplir un state brut. Remplacer le `onSuccess` de la mutation `aiDraft` :
```tsx
    onSuccess: (data) => setInject((prev) => ({ html: data.bodyHtml, nonce: (prev?.nonce ?? 0) + 1 })),
```

4. Remplacer le calcul de `canPublish` (ligne `const canPublish = …`) par :
```tsx
  const saveHtml = bodyHtml ?? t.currentVersion?.bodyHtml ?? '';
  const canPublish = t.status !== 'PUBLISHED' && !editorEmpty;
```
(et supprimer l'ancienne ligne `const html = bodyHtml ?? t.currentVersion?.bodyHtml ?? '';`).

5. Remplacer le bloc `<textarea …/>` par l'éditeur (keyé sur modèle:version pour se remonter au changement de version) :
```tsx
          <TemplateEditor
            key={`${t.id}:${t.currentVersion?.id ?? 'none'}`}
            initialHtml={t.currentVersion?.bodyHtml ?? ''}
            onChange={setBodyHtml}
            onEmptyChange={setEditorEmpty}
            inject={inject}
          />
```

6. Le bouton **Enregistrer** envoie désormais `saveHtml` :
```tsx
            <Button onClick={() => save.mutate(saveHtml)} disabled={save.isPending}>
```

> Ne pas modifier les mutations `save`/`publish`/`deprecate`, la bannière, ni le bloc « Variables détectées » (il lit toujours `aiDraft.data.suggestedVariables`).

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @lsi/web typecheck`
Expected: PASS. (Vérifier qu'aucune référence à l'ancienne variable `html` ne subsiste.)

- [ ] **Step 3: Suite web complète (non-régression)**

Run: `pnpm --filter @lsi/web test`
Expected: PASS (toute la suite, dont `template-editor` et `ai-draft-panel`).

- [ ] **Step 4: Build**

Run: `pnpm --filter @lsi/web build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/templates/template-detail-page.tsx
git commit -m "feat(web): éditeur de modèle en WYSIWYG + brouillon IA chargé dans l'éditeur rendu"
```

---

## Self-Review

**Couverture du spec :**
- §2/§3 `TemplateEditor` (TipTap, barre alignée allowlist, émission état, injection nonce) → Task 1. ✅
- §4 Intégration (remplace textarea, `canPublish` via vide, IA via `inject`, keyé version, Enregistrer inchangé) → Task 2. ✅
- §5 Tests (barre affichée, HTML initial émis, vide remonté, injection au changement de nonce ; suite web verte + typecheck + build) → Task 1 (composant) + Task 2 (non-régression). ✅
- §6 Non-objectifs (pas de souligné/lien/chips/aperçu PDF) respectés (barre limitée, aucune extension ajoutée). ✅

**Cohérence des types :** `TemplateEditor` props définies en Task 1, consommées à l'identique en Task 2 (`onChange: setBodyHtml`, `onEmptyChange: setEditorEmpty`, `inject`). `inject` de forme `{ html, nonce }` produite par `aiDraft.onSuccess` (Task 2) et consommée par le composant (Task 1). `saveHtml` remplace `html` partout dans la page (Enregistrer). ✅

**Placeholders :** aucun — chaque étape porte le code réel. La seule note conditionnelle (`immediatelyRender: false`) est bornée à un échec de test explicite et ne s'applique que si nécessaire.
