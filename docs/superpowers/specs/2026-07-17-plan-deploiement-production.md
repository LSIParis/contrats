# Plan de déploiement production — LSI Contrats

**Date** : 2026-07-17
**Statut** : en revue
**Contexte** : fait suite au dossier de conception `2026-07-16-gestion-contrats-msp-design.md`

---

## 1. La réalité d'infrastructure corrige le dossier

Le dossier supposait AWS `eu-west-3`. La réalité est **OVH / Vultr Paris**, orchestré par Portainer. Deux conséquences structurantes, dans les deux sens.

### R1 (Cloud Act) — **amélioré**

| | Dossier (hypothèse H3) | Réalité |
|---|---|---|
| Hébergeur | AWS (société US) région EU | **OVH / Vultr** — opérateurs européens |
| Cloud Act | Risque à documenter (R1, impact élevé) | **Ne s'applique pas** : pas d'opérateur US dans la chaîne |

C'est un **gain net**. Le risque le plus difficilement réversible du dossier (§19-R1) disparaît : l'argument de souveraineté devient un atout commercial plutôt qu'un point de vigilance. H3 est remplacée par « hébergement souverain OVH/Vultr Paris ».

### §10.7 (chiffrement documentaire) — **dégradé, à assumer**

| | Dossier (AWS KMS) | Réalité (MinIO / OVH Object Storage) |
|---|---|---|
| Isolation crypto | Encryption context KMS `{tenant,customer}`, **authentifié cryptographiquement** — un objet du client A ne se déchiffre pas avec le contexte de B, mathématiquement | **Pas d'équivalent.** Le S3-compatible offre le chiffrement au repos, pas le liage par contexte |
| Garantie qui **survit à un bug de code** | Oui | **Non** |

Conséquence honnête : la couche de défense « même si le code construit la mauvaise clé S3, KMS refuse » **n'existe pas** sur OVH. L'isolation documentaire repose alors sur :
1. le **préfixe de chemin** scopé (`t/{tenant}/c/{customer}/…`) ;
2. la vérification applicative `assertKeyMatchesScope` (déjà codée) ;
3. le chiffrement au repos du bucket ;
4. **RLS**, qui reste la garantie primaire et n'est pas affectée.

Ce n'est pas un showstopper — RLS et le scoping de chemin tiennent — mais c'est **un cran de défense en moins** qu'en AWS, et il faut le dire. Réévaluation possible : chiffrement applicatif par enveloppe avec une clé dérivée par tenant, si le niveau d'exigence documentaire l'impose (hors périmètre immédiat).

---

## 2. Définition de « prêt pour la production »

Déployer publiquement l'app **telle quelle** serait trompeur : sans authentification, tout endpoint répond 401 (le webhook et le healthcheck exceptés). Techniquement « sûr » (rien n'est accessible), mais **inutilisable**. « Prêt pour la prod » exige donc, au minimum :

- authentification réelle (interne + client) ;
- stockage documentaire persistant ;
- worker pour les rappels et les transitions automatiques ;
- une interface pour les équipes ;
- observabilité, sauvegardes, revue de sécurité.

C'est ce que la feuille de route ci-dessous construit, par phases livrables indépendamment.

---

## 3. État actuel vs cible

| Brique | Actuel | Cible prod |
|---|---|---|
| Domaine métier | ✅ complet | ✅ |
| Persistance + RLS | ✅ (mots de passe de test) | 🔧 secrets réels |
| API contrats/transitions/envoi/webhook | ✅ testée, validée contre EE réelle | ✅ |
| Rendu PDF | ✅ | ✅ |
| Auth | ❌ sessions en mémoire | 🔨 OIDC + magic link + Redis |
| Stockage | ❌ stub mémoire | 🔨 S3-compatible (MinIO/OVH) |
| Worker / scheduler | ❌ | 🔨 BullMQ + jobs |
| Notifications | ❌ | 🔨 emails |
| Frontend | ❌ | 🔨 Next.js BFF + UI + portail |
| Téléchargement preuves (W-05) | ❌ | 🔨 |
| Réconciliation (EC-06) | ❌ | 🔨 |
| Dockerfile / CI / registre | ❌ | 🔨 |
| DNS / proxy / TLS | ❌ | 🔨 |
| Observabilité / sauvegardes / pentest | ❌ | 🔨 |

Légende : ✅ fait · 🔧 ajustement · 🔨 à construire

---

## 4. Feuille de route phasée

Chaque phase est livrable et vérifiable seule. L'ordre suit les dépendances **et** le risque : on déploie l'ossature tôt (pour dérisquer l'exploitation), l'auth ensuite (car elle débloque l'usage), puis les fonctionnalités.

### Phase A — Socle de déploiement

- **Objectif** : l'API tourne en public sur `contrats.lsi-maintenance.fr`, déployée reproductiblement. Ferme la **boucle webhook** dès qu'on peut déclencher un envoi.
- **Livrables** :
  - `Dockerfile` multi-stage (build pnpm monorepo → image API), image de migrations
  - dépôt GitHub + GitHub Actions → build & push vers **ghcr.io**
  - stack Portainer sur Docker Legal (API + Postgres + Gotenberg + Redis + MinIO)
  - **secrets réels** : rotation des mots de passe `lsi_app`/`lsi_webhook`/`lsi_scheduler` post-migration, injectés par variables de stack Portainer (pas dans l'image)
  - DNS `contrats.lsi-maintenance.fr` + reverse proxy (nginx-pm) + TLS
  - healthcheck, CI verte (lint + typecheck + tests unitaires ; l'intégration reste manuelle)
- **Dépendances** : un dépôt GitHub pour LSI (compte/org + token ghcr).
- **Risques** : les mots de passe de rôles en dur dans les migrations — traiter par `ALTER ROLE` depuis un secret au premier déploiement, jamais garder les valeurs de test.
- **Acceptation** : `contrats.lsi-maintenance.fr/health` répond ; le webhook accepte un événement HMAC valide ; tout autre endpoint répond 401 ; l'image se déploie depuis ghcr en une action Portainer.

### Phase B — Authentification

- **Objectif** : rendre l'app pilotable et sûre à exposer utilement.
- **Livrables** : OIDC Entra ID (interne), magic link email (client), sessions **Redis** (remplace le stub mémoire), révocation immédiate (EC-17), cookie `__Host-`.
- **Dépendances** : Phase A ; tenant Entra ID capable d'émettre une app OIDC (H6 à confirmer).
- **Risques** : si H6 fausse, repli mot de passe + TOTP (plus de dev).
- **Acceptation** : un employé se connecte via M365 et voit son scope ; un client se connecte par magic link ; une session révoquée tombe à la requête suivante.

### Phase C — Persistance & preuves

- **Objectif** : fermer la boucle signature **durablement**.
- **Livrables** : adaptateur S3-compatible (remplace le stub mémoire) ; W-05 (téléchargement PDF signé + audit trail, hash, Object Lock si dispo) ; EC-06 (réconciliation horaire) ; dossier de preuve (§11.6).
- **Dépendances** : Phases A–B.
- **Acceptation** : un contrat signé produit un PDF signé + sa piste d'audit stockés et hashés ; un webhook perdu est rattrapé par la réconciliation.

### Phase D — Worker & notifications

- **Objectif** : rendre l'expiration silencieuse impossible (le problème n°1 du dossier).
- **Livrables** : worker BullMQ ; jobs `contracts.activate`/`contracts.expire`/`reminders.scan`/`reminders.send`/`signatures.reconcile` ; emails (SES ou SMTP OVH) ; rappels J-90/60/30.
- **Dépendances** : Phases A–C.
- **Acceptation** : scheduler arrêté 48 h → rappels partent en retard, marqués `late` ; échéance < 90 j → `SKIPPED_OBSOLETE` tracé.

### Phase E — Frontend

- **Objectif** : donner une interface aux équipes et un portail au client.
- **Livrables** : Next.js BFF + UI interne (tableau de bord, contrats, envoi, revue) + portail client + signature embarquée (`<docuseal-form>`).
- **Dépendances** : Phases A–D.
- **Acceptation** : Sylvie crée et envoie un contrat sans ligne de commande ; un client signe depuis le portail sur mobile.

### Phase F — Durcissement & go-live

- **Objectif** : exploitable en confiance.
- **Livrables** : observabilité (OpenTelemetry, alertes) ; sauvegardes Postgres + PRA (RTO/RPO à définir) ; revue de sécurité / pentest ; runbooks ; RGPD (registre, export/effacement, rétention).
- **Acceptation** : pentest sans faille critique/majeure ; restauration testée ; runbooks écrits.

---

## 5. Décisions actées (2026-07-17)

| Décision | Choix |
|---|---|
| Périmètre | Viser une **vraie production** (feuille de route ci-dessus) |
| Exposition | **Domaine public** `contrats.lsi-maintenance.fr` via reverse proxy + TLS |
| Livraison d'image | **ghcr.io** (GitHub Container Registry) + GitHub Actions |
| Hôte | Docker Legal (OVH Paris), Ubuntu 26.04, 6 CPU / 12 Go |
| Hébergement | Souverain OVH/Vultr — **R1 (Cloud Act) levé** |

---

## 6. Prochaine étape immédiate : Phase A

Le premier livrable concret est le **socle de déploiement**. Il ne dépend d'aucune fonctionnalité nouvelle et dérisque tout le reste : Dockerfile, dépôt GitHub, CI → ghcr, stack Portainer, secrets, DNS + proxy + TLS.

**Déblocage requis avant de commencer** : un **dépôt GitHub pour LSI** (compte ou organisation) et un **token** autorisant le push vers ghcr.io. Sans ça, la chaîne d'image ne peut pas exister. Tout le reste de la Phase A (Dockerfile, stack, migrations, secrets) peut être préparé en parallèle.

---

## 7. Questions ouvertes

1. **GitHub / ghcr** — LSI a-t-il un compte/organisation GitHub ? Puis-je en créer un, ou fournis-tu les accès ?
2. **DNS** — qui gère la zone `lsi-maintenance.fr` ? Faut-il un enregistrement `contrats` pointant vers l'IP de Docker Legal, et le proxy nginx-pm est-il sur le **même** hôte que l'app ou sur Docker 01 ?
3. **Entra ID (H6)** — le tenant M365 de LSI peut-il émettre une application OIDC ? Sinon, repli mot de passe + TOTP.
4. **Stockage** — MinIO auto-hébergé sur Legal, ou OVH Object Storage (S3-compatible managé) ?
5. **Emails** — SMTP OVH, ou un service transactionnel (bounce tracking) ? SPF/DKIM/DMARC sur `lsi-maintenance.fr` à vérifier.
6. **§10.7** — le niveau d'exigence documentaire justifie-t-il un chiffrement applicatif par enveloppe pour compenser l'absence de KMS ? (défaut : non, RLS + préfixe suffisent)
