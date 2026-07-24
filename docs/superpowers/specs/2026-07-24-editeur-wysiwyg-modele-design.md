# Éditeur WYSIWYG pour l'éditeur de modèle (sous-projet B / increment 3)

**Date** : 2026-07-24
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : remplacer la zone de texte « source HTML » (`<textarea>`) de l'éditeur
de modèle par un **éditeur riche WYSIWYG** (TipTap), pour que le texte s'affiche
mis en forme au lieu d'exposer les balises HTML — en particulier quand un
brouillon est généré par l'IA. Aucune nouvelle dépendance, aucun backend.

## 1. Objectif et constat

Le brouillon IA (sous-projet B, increment 2) est du HTML. L'éditeur de modèle
(`template-detail-page.tsx`, hérité du sous-projet A) est une `<textarea>` : elle
affiche le **texte brut**, donc `<p>…</p>` apparaît littéralement. Un utilisateur
non technique voit « toutes les balises visibles ».

Le projet contient **déjà** TipTap (`@tiptap/react`, `@tiptap/starter-kit`,
`@tiptap/pm`) et un éditeur WYSIWYG opérationnel — `ContentEditor`
(`apps/web/src/features/contracts/content-editor.tsx`) — utilisé pour le contenu
des contrats. On applique le même pattern à l'éditeur de modèle.

Aucune migration, aucun changement d'API. Le corps du modèle reste du HTML,
enregistré via le `PUT /v1/templates/:id/content` existant (qui sanitise).

## 2. Décisions

| Sujet | Décision |
|---|---|
| Bibliothèque | TipTap + StarterKit — **déjà installés**. Pas de nouvelle dépendance. |
| Composant | Nouveau `TemplateEditor` dédié (pas de réutilisation de `ContentEditor`, qui porte un « Aperçu PDF » propre aux contrats et n'accepte pas d'injection de contenu externe après montage). Évite de fragiliser l'éditeur de contrat. |
| Barre d'outils | Alignée sur l'allowlist du sanitizer serveur (`sanitizeContractHtml` : `h1-h3, p, br, strong/b, em/i, u, s, ul, ol, li, blockquote, a`) **∩** capacités de StarterKit → **Gras** (strong), **Italique** (em), **Barré** (s), **Titre** (h2), **Sous-titre** (h3), **• Liste** (ul), **1. Liste** (ol), **Citation** (blockquote). Souligné/lien : extensions non installées → hors périmètre (allowlist superset, aucune régression). |
| Injection du brouillon IA | Au succès de « Générer », le HTML est **chargé dans l'éditeur rendu** via `editor.commands.setContent(html)`, déclenché par un compteur (`nonce`) qui change à chaque génération — sans écraser la frappe en cours à chaque render. |
| Variables `{{…}}` | Restent du **texte simple** dans l'éditeur (préservées à l'aller-retour `getHTML()`). Pas de chips/surlignage (non-objectif). La liste « Variables détectées » (déjà affichée après génération) est conservée. |
| Sanitisation | Le HTML produit par TipTap (`p, strong, em, s, h2, h3, ul, ol, li, blockquote`) passe **tel quel** l'allowlist serveur à l'enregistrement — rien retiré. |
| Vide/publish | TipTap représente le vide par `<p></p>`. Le garde-fou « publier interdit si corps vide » vit **côté serveur** (`bodyHtml.trim() === ''` → 400) : `<p></p>` n'est pas vide au sens strict. Côté front, `canPublish` doit s'appuyer sur `editor.isEmpty` (ou un test de contenu textuel) plutôt que sur `html.trim().length`, pour ne pas proposer « Publier » sur un modèle visuellement vide. |
| Changement de modèle/version | L'éditeur doit refléter le bon corps quand on change de modèle (`:id`) ou après un fork de version : keyer l'instance d'éditeur (montée/remontée) sur `templateId` + `currentVersion.id`, sinon le contenu resterait figé au premier montage. |

## 3. Composant `TemplateEditor` (`apps/web/src/features/templates/`)

Props :
- `initialHtml: string` — contenu initial (corps de la version courante).
- `onChange: (html: string) => void` — appelé à chaque frappe avec `editor.getHTML()`.
- `onEmptyChange?: (empty: boolean) => void` — remonte `editor.isEmpty` à l'initialisation et à chaque frappe, pour piloter `canPublish` côté page.
- `inject?: { html: string; nonce: number }` — quand `nonce` change, `editor.commands.setContent(inject.html)` + `onChange(inject.html)`.
- `disabled?: boolean` — désactive l'édition pendant un enregistrement/génération si utile.

Comportement : TipTap `useEditor({ extensions: [StarterKit], content: initialHtml, onUpdate })` ; barre d'outils (boutons `chain().focus().toggleX().run()`) ; `<EditorContent>` dans un conteneur `prose`.

## 4. Intégration (`template-detail-page.tsx`)

- Remplacer la `<textarea>` par `<TemplateEditor>` (keyé sur `templateId:currentVersionId`).
- `onChange` → `setBodyHtml`.
- Génération IA : au lieu de `setBodyHtml(data.bodyHtml)`, poser `inject = { html: data.bodyHtml, nonce: ++ }` **et** mettre à jour `bodyHtml` — l'éditeur charge le rendu, l'utilisateur voit le contrat mis en forme et éditable.
- `canPublish` : baser sur l'état « vide » remonté par l'éditeur (pas sur `html.trim()`).
- Boutons **Enregistrer / Publier / Déprécier** et la bannière + « Variables détectées » : inchangés.

## 5. Sécurité et tests

- **Sécurité** : le rendu WYSIWYG est le HTML de l'éditeur ; il n'introduit pas d'injection (TipTap gère le contenu, pas de `dangerouslySetInnerHTML` sur du HTML non maîtrisé). La sortie IA est déjà sanitisée côté serveur avant d'arriver ; l'enregistrement re-sanitise. Aucun script ne peut être produit par la barre d'outils.
- **Tests** (Vitest + Testing-Library, comme `content-editor.test.tsx`) :
  - `TemplateEditor` monte, affiche la barre d'outils (au moins Gras/Titre/Liste), rend le `initialHtml`.
  - « Enregistrer » (au niveau page) transmet le HTML courant ; le HTML initial est renvoyé si non modifié (patron du test existant `content-editor`).
  - Injection : quand `inject.nonce` change, `onChange` est appelé avec le nouveau HTML (preuve que le brouillon IA charge bien l'éditeur).
- **Front global** : la suite web reste verte ; `typecheck` + `build` verts.

## 6. Non-objectifs (différés)

- Souligné, liens (extensions TipTap non installées).
- Chips/surlignage des variables `{{…}}`.
- Aperçu PDF du modèle (l'instanciation d'un contrat depuis un modèle reste non câblée).
- Unifier l'éditeur de contrat et l'éditeur de modèle en un seul composant partagé.
