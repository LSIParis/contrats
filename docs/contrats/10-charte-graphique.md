# 10 — Charte graphique LSI Contrats

> Identité propre à l'application, déclinée du logo (planches : canvas « LSI Contrats — Logo »,
> <https://claude.ai/artifact/1f5pdinuDUpnX6d1RzCqYV>). Elle remplace depuis le 2026-10-31
> l'alignement visuel sur lticket demandé par le brief §11 (hypothèse V2-H76).
>
> Sources de vérité dans le code : `apps/web/src/ui/theme/tokens.ts` et `tokens.css` (le test
> `theme-tokens.test.ts` vérifie leur accord et les contrastes), `apps/web/src/ui/logo.tsx`,
> `apps/web/public/brand/`.

## 1. Principes

- **Bleu pour agir, cuivre pour signer.** Le cobalt porte les actions et l'information. Le cuivre
  est réservé à la marque : logo et repère de l'entrée active. Il n'indique jamais un état.
- **Sobre et lisible.** Outil de travail sur des documents engageants : fonds calmes, un seul
  dégradé autorisé (logo et icône en relief), densité d'information conservée.
- **Pas de mode sombre.** Seule la barre latérale est sombre.

## 2. Logo

Deux L imbriqués, cobalt et cuivre, autour d'un sceau en losange : LSI, les deux parties du contrat
et leur engagement.

| Fichier (`apps/web/public/brand/`) | Usage |
|---|---|
| `logo-light.svg`, `logo-dark.svg` | Logo complet avec « par LSI-Maintenance » : documents, présentations |
| `logo-compact-light.svg`, `logo-compact-dark.svg` | Sans mention, largeur réduite : en-têtes |
| `symbol-3d-light.svg`, `symbol-3d-dark.svg` | Symbole en relief, **à partir de 64 px** : connexion, couvertures |
| `symbol-flat-light.svg`, `symbol-flat-dark.svg` | Symbole plat, **de 16 à 64 px** |
| `symbol-mono-night.svg`, `symbol-mono-ivory.svg` | Une couleur : tampon, gravure, impression au trait |
| `app-icon.svg`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | Icône d'application |
| `favicon.svg`, `../favicon.ico` | Onglet du navigateur (16, 32, 48 px) |

Le texte des logos est vectorisé : ces fichiers n'ont pas besoin de la police.

**Règles**

- Zone de protection : au moins la largeur du losange × 2 (≈ 1/6 de la hauteur du symbole) tout autour.
- Taille minimale : symbole 16 px, logo compact 96 px de large, logo complet 160 px de large.
- Fond clair (blanc, ivoire) : version `light`. Fond nuit : version `dark`. Autre fond ou photo :
  version monochrome.
- Ne pas : recolorer, déformer, incliner, ajouter une ombre, séparer les deux L, utiliser le relief
  sous 64 px.
- LSI Maintenance garde son propre logo pour les documents institutionnels de la société. Le nom
  légal reste **LSI SAS** dans les mentions légales.

## 3. Couleurs

### Marque

| Échelle | 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Cobalt | `#EEF3FE` | `#DFE8FD` | `#C3D4FB` | `#9DBBFE` | `#6C9DFF` | `#3D7BFF` | `#2F62E6` | **`#2457E0`** | `#1A39A6` | `#122A7E` | `#0A1748` |
| Cuivre | `#FDF6EF` | `#FBEBDB` | `#F8D1A8` | `#F6C79A` | **`#E9A672`** | `#DE9158` | `#C9773D` | `#A85A28` | `#7A3A16` | `#4A200B` | |
| Nuit | | | | | | | | `#1C3170` | `#16285A` | **`#0B1530`** | `#060C1E` |

Ivoire `#F3F1EC` : écran de connexion et supports de marque. Neutres `slate` : voir `tokens.ts`.

### Rôles

| Rôle | Jeton | Valeur | Contraste mesuré |
|---|---|---|---|
| Action, lien, information | `primary`, `info` | cobalt 700 | blanc sur cobalt **5,97:1** ; sur cobalt 50 **5,37:1** |
| Survol d'action | `primary-hover` | cobalt 800 | blanc sur cobalt **9,63:1** |
| Anneau de focus | `focus` | cobalt 600 | **5,24:1** sur blanc |
| Barre latérale | `night-900` | nuit 900 | entrée (slate 200) **14,76:1** ; section (slate 400) **7,13:1** |
| Repère d'entrée active | `accent` | cuivre 400 | **8,73:1** sur nuit ; **décoratif, jamais sur blanc** |
| Texte | `ink`, `ink-muted`, `ink-faint` | slate 900, slate 600, `#637684` | 14,55:1, 6,22:1, 4,71:1 sur blanc |
| Succès, alerte, danger | `success`, `warn`, `danger` | `#117F3A`, `#B25209`, `#D12424` | ≥ 4,5:1 sur leur fond (§6) |

La mention « Contrats » du logo en cuivre 700 atteint 5,05:1 sur blanc et 4,47:1 sur ivoire : réservé
aux grands textes du logo sur ivoire (seuil 3:1), jamais à du texte courant.

Cuivre et alerte `#B25209` sont proches : le cuivre n'apparaît donc jamais dans un badge ni un message.

## 4. Typographie

| Famille | Usage | Graisses | Chargement |
|---|---|---|---|
| **Sora** | Logo, titres `h1` à `h3`, titre de barre supérieure | 300 et 700 (logo), 650 (titres) | `@fontsource-variable/sora` |
| **Inter** | Texte, formulaires, tableaux | 400, 500, 550 (boutons), 600, 700 | `@fontsource/inter` |
| Monospace système | Références techniques, code | 400 | pile système |

Auto-hébergées : aucun appel à Google Fonts ni à un CDN (la CSP limite les polices à `'self'`).

Échelle : 11 · 12 · 12,5 · 13 · **14 (corps)** · 15 · 17 · 18 · 22 px. Interligne du corps 1,5. Titres
`h1` 22 px, `h2` 17 px, `h3` 15 px, approche −0,01em. Pour un texte courant, ne pas descendre sous 12 px.

Ton rédactionnel : français, phrases courtes, verbe d'action sur les boutons (« Envoyer la proposition »).

## 5. Formes, espacements, icônes

| Élément | Valeurs |
|---|---|
| Rayons | 6 px boutons et champs (`rounded`), 10 px cartes (`rounded-lg`), 14 px grands panneaux (`rounded-xl`), pastille (`rounded-full`) |
| Ombres (teintées nuit) | `shadow-sm`, `shadow`, `shadow-md`, `shadow-pop` |
| Espacements | 4 · 8 · 12 · 16 · 24 · 32 px |
| Gabarit | barre latérale 248 px, barre supérieure 60 px, contenu 1180 px maximum |
| Voile de modale | `rgba(11, 21, 48, .45)` |
| Icônes | `ui/icons.tsx` : tracé 1,8 sur grille 24, `currentColor`, extrémités rondes, aucune bibliothèque |

## 6. Composants

| Composant | Code |
|---|---|
| Coquille, barre latérale, barre supérieure, pied de page légal | `ui/layout.tsx` : `Shell`, `Sidebar`, `NavItem`, `NavSection`, `Topbar`, `LegalFooter` |
| Logo | `ui/logo.tsx` : `Logo`, `LogoSymbol` |
| Écran d'authentification (fond ivoire, symbole en relief) | `AuthScreen` |
| Boutons | `ui/button.tsx` : primaire, secondaire, fantôme, danger, alerte |
| Cartes, champs, tableaux | `ui/card.tsx`, `ui/field.tsx`, `ui/input.tsx`, `ui/select.tsx`, `ui/table.tsx` |
| Badges | `ui/badge.tsx`, `ui/status-badge.tsx` |
| Onglets, modale, toast, fil d'Ariane | `ui/tabs.tsx`, `ui/modal.tsx`, `ui/toast.tsx`, `ui/breadcrumb.tsx` |

**Barre latérale** : sections Devis proposition, Contrat et Administration, chacune ouverte par
« Tableau de bord » ; « Paramètres » en bas. Entrée active : fond cuivré à 14 %, repère cuivre 400.

### Badges de statut

Une couleur + une **icône distincte** + un **libellé français** par statut (`ui/theme/status.ts`,
`lib/labels.ts`). La couleur ne porte jamais seule le sens. Vérifié par `status-badge.test.tsx`.

| Ton | Texte / fond | Rapport | Statuts |
|---|---|---|---|
| neutre | `#424E57` / `#F3F5F6` | **7,81:1** | Brouillon, Résilié |
| atténué | `#53636E` / `#F3F5F6` | **5,69:1** | Annulé |
| information | `#2457E0` / `#EEF3FE` | **5,37:1** | En revue interne, Envoyé au client, Partiellement signé, Renouvelé |
| succès | `#117F3A` / `#E7F6EC` | **4,56:1** | Validé, Accepté, Signé, Actif |
| alerte | `#B25209` / `#FBF0DD` | **4,53:1** | Modifications demandées, En négociation, En signature, À renouveler, Importé à valider |
| danger | `#D12424` / `#FCE9E9` | **4,51:1** | En résiliation, Expiré, Refusé, Signature expirée |

## 7. Accessibilité (RGAA de base)

- Texte ≥ 4,5:1, éléments graphiques et focus ≥ 3:1, contrôlés par `theme-tokens.test.ts`.
- Anneau de focus `:focus-visible` cobalt 600 sur tout élément cliquable, halo sur les champs.
- Lien d'évitement « Aller au contenu » ; navigation nommée ; `aria-current` sur l'entrée active et
  la dernière miette du fil d'Ariane.
- Onglets : motif WAI-ARIA (flèches, Début, Fin, tabindex glissant, panneau focusable).
- Modale : `role="dialog"`, `aria-modal`, `aria-labelledby`, focus piégé et restitué, Échap.
- Toasts : région `aria-live`, erreurs en `role="alert"` sans disparition automatique.
- Champs : libellé relié par `htmlFor`, aide et erreur reliées par `aria-describedby`, `aria-invalid`.
- Chargement annoncé (`role="status"`).

## 8. Déclinaisons

| Support | État |
|---|---|
| Console, portail client, page publique de proposition | Appliqué |
| Favicon, icône d'application, titre d'onglet « LSI Contrats » | Appliqué |
| Titres de la proposition en PDF (`proposal-content.ts`) | Couleur nuit 900 appliquée ; logo non intégré |
| Contrats en PDF | Inchangés : présentation de document neutre (`packages/domain`) |
| Documentation de l'API publique (`openapi.controller.ts`) | Inchangée : page technique autonome avec mode sombre |
| E-mails transactionnels | Inchangés |
| lticket | Hors périmètre : garde sa charte menthe et pétrole |

### Page publique de proposition `/p/<jeton>`

Mêmes jetons et primitives que l'application, sans barre latérale ; `Logo` en en-tête et `LegalFooter`
en pied de page. **Mobile d'abord** : une colonne de 900 px maximum, marges 16 px, tableau de prix
défilant sous 520 px. **Aucune ressource tierce.** `X-Robots-Tag: noindex`, `Cache-Control: no-store`,
requêtes en `referrerPolicy="no-referrer"`. Contenu HTML produit et assaini par le serveur ; la page
ne calcule aucun prix.
