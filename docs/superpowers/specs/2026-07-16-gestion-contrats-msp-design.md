# Gestion des contrats LSI Maintenance — Dossier de conception

**Date** : 2026-07-16
**Statut** : en revue
**Auteur** : équipe technique LSI Maintenance

---

## 1. Vision produit

Centraliser dans une application unique le cycle de vie complet des contrats de services que LSI Maintenance souscrit auprès de ses clients PME/TPE, de la rédaction à l'archivage, avec signature électronique intégrée et rappels d'échéance automatiques.

Le problème réel n'est pas « nous n'avons pas d'outil pour stocker des PDF ». C'est :

1. **Les échéances passent inaperçues.** Un contrat qui expire sans renouvellement est une perte de revenu récurrent, et personne ne détient aujourd'hui la vue consolidée des dates de fin.
2. **La version qui fait foi est introuvable.** Entre le DOCX sur le partage réseau, le PDF signé dans une boîte mail et l'avenant négocié par téléphone, personne ne sait quel texte engage LSI.
3. **La signature est un parcours du combattant.** Impression, scan, relance manuelle.
4. **Rien n'est traçable.** Qui a validé quoi, quand, sur quelle version : aucune réponse en cas de litige.

**Critère de succès du MVP** : aucun contrat ne peut expirer sans qu'un humain ait été prévenu 90, 60 et 30 jours avant, et pour tout contrat actif on peut produire en une minute la version signée qui fait foi accompagnée de sa piste d'audit.

**Non-objectifs explicites** (YAGNI) : facturation, gestion de tickets, CRM, comptabilité, gestion de parc. L'application gère des contrats. Elle s'interfacera avec l'existant, elle ne le remplace pas.

---

## 2. Hypothèses

Hypothèses retenues faute d'information contraire. Chacune est révisable, mais le dossier est construit dessus.

| # | Hypothèse | Impact si fausse |
|---|---|---|
| H1 | Le « tenant » est LSI Maintenance ; la frontière d'isolation opérationnelle est le **customer** (client PME). Confirmé par l'utilisateur. | Structure tout le modèle de données. |
| H2 | Volumétrie < 100 clients et < 2 000 contrats à 3 ans. Confirmé. | Disqualifie base-par-tenant et tout sharding. |
| H3 | Hébergement AWS région `eu-west-3` (Paris). Confirmé, avec réserve Cloud Act documentée en §18. | Argumentaire RGPD et analyse de risque. |
| H4 | DocuSeal auto-hébergé, en Docker, dans le même VPC. Confirmé. | Les documents ne sortent pas de l'infra. |
| H5 | Les équipes internes LSI comptent moins de 20 personnes. | Rend inutile toute délégation de droits complexe. |
| H6 | LSI utilise Microsoft 365. L'authentification interne se fait via OIDC Entra ID. | Si faux : email + mot de passe + TOTP. |
| H7 | Le niveau de signature visé est la **signature électronique simple (SES)** au sens eIDAS, pas l'avancée ni la qualifiée. | Détermine la charge de la preuve. À faire valider juridiquement. |
| H8 | Le droit applicable est le droit français, les contrats sont en français, en euros. | Formats, mentions, prescription. |
| H9 | Un contrat appartient à exactement un client. Pas de contrat multi-clients (groupement). | Simplifie radicalement le modèle de scope. |
| H10 | Les modèles de contrats sont rédigés par LSI et mutualisés entre clients ; seules les **instances** de contrats sont cloisonnées. | Voir §10 : les templates sont au niveau tenant, pas customer. |
| H11 | L'espace client est en consultation + signature uniquement. Un client ne rédige jamais. | Réduit fortement la surface d'attaque du portail. |
| H12 | Pas d'exigence de valeur probante renforcée type NF Z42-013 / archivage à valeur probante. | Sinon, coffre-fort numérique tiers requis. |

---

## 3. Personas et rôles

### 3.1 Personas

**Sylvie — Responsable administrative LSI (utilisatrice principale)**
Prépare les contrats, relance les clients, surveille les échéances. Vit dans Excel aujourd'hui. Peu technophile, très rigoureuse. C'est elle qui décide si l'outil est adopté ou abandonné. Son critère : « est-ce que je vois d'un coup d'œil ce qui va expirer ? »

**Marc — Dirigeant / commercial LSI**
Négocie, valide les conditions commerciales, veut voir le portefeuille et le récurrent. Consulte plus qu'il ne saisit, souvent sur mobile.

**Karim — Technicien / chef de projet LSI**
Consulte le contrat pour savoir ce qui est couvert (périmètre, SLA, nombre de postes). Ne modifie rien. Représente le plus gros volume de lectures.

**Nathalie — Gérante d'une PME cliente**
Reçoit le contrat, le lit, le signe. Utilise l'outil trois fois par an, dix minutes à chaque fois. Toute friction se paie en relances téléphoniques. Ne créera jamais de compte avec mot de passe.

**Un conseil juridique externe (occasionnel)**
Relit les clauses non standard avant envoi. N'a pas besoin d'un compte permanent.

### 3.2 Rôles

Deux familles étanches. Un utilisateur appartient à **une seule** famille — jamais les deux. C'est une contrainte structurante, pas une commodité : elle interdit par construction le compte hybride qui serait le vecteur de fuite le plus probable.

#### Famille INTERNE (personnel LSI, membres du tenant)

| Rôle | Portée | Droits clés |
|---|---|---|
| `MSP_ADMIN` | Tous les clients du tenant | Tout, y compris gestion des utilisateurs, modèles, paramètres, purge RGPD. Rôle rare : 2 personnes. |
| `ACCOUNT_MANAGER` | **Portefeuille restreint** de clients | Créer, éditer, soumettre à validation, envoyer en signature, initier renouvellements/avenants sur ses clients uniquement. |
| `LEGAL_REVIEWER` | Tous les clients du tenant | Valider ou refuser un contrat en revue. Ne peut ni créer ni envoyer en signature. Séparation des pouvoirs. |
| `TECHNICIAN` | Portefeuille restreint | **Lecture seule** sur les contrats de ses clients. Peut commenter en interne. |

Point de conception : `ACCOUNT_MANAGER` et `TECHNICIAN` ont un portefeuille **explicite** (table `customer_access`). Un account manager n'a pas accès aux 80 clients par défaut. C'est ici que se joue réellement le cloisonnement — voir §10.4.

#### Famille CLIENT (personnes externes, rattachées à un customer)

| Rôle | Portée | Droits clés |
|---|---|---|
| `CLIENT_SIGNER` | **Un seul customer** | Consulter les contrats qui le concernent, signer, commenter, télécharger le signé. |
| `CLIENT_VIEWER` | **Un seul customer** | Consulter et télécharger. Ne signe pas. |

Un utilisateur client est rattaché à exactement un `customer_id`, non modifiable après création. Pour donner accès à deux clients à la même personne physique (cas du dirigeant de deux sociétés), on crée **deux comptes distincts**. C'est volontairement rigide : la session client est épinglée à un customer et ne peut pas basculer.

#### Rôle système

`SYSTEM` — utilisé par les jobs et les webhooks. N'est jamais porté par un humain, n'a jamais de session interactive, et opère toujours dans un scope résolu explicitement (jamais « tous les clients »).

### 3.3 Matrice de permissions (MVP)

Légende : ● autorisé · ○ autorisé sur son portefeuille uniquement · ✗ interdit

| Action | MSP_ADMIN | ACCOUNT_MANAGER | LEGAL_REVIEWER | TECHNICIAN | CLIENT_SIGNER | CLIENT_VIEWER |
|---|---|---|---|---|---|---|
| Lire un contrat | ● | ○ | ● | ○ | ● (son customer, si publié) | ● (idem) |
| Créer un contrat | ● | ○ | ✗ | ✗ | ✗ | ✗ |
| Éditer un brouillon | ● | ○ | ✗ | ✗ | ✗ | ✗ |
| Soumettre à validation | ● | ○ | ✗ | ✗ | ✗ | ✗ |
| Valider / refuser | ● | ✗ | ● | ✗ | ✗ | ✗ |
| Envoyer en signature | ● | ○ | ✗ | ✗ | ✗ | ✗ |
| Signer | ✗ | ✗ | ✗ | ✗ | ● | ✗ |
| Commenter (interne) | ● | ○ | ● | ○ | ✗ | ✗ |
| Commenter (partagé client) | ● | ○ | ● | ✗ | ● | ● |
| Créer avenant / renouveler | ● | ○ | ✗ | ✗ | ✗ | ✗ |
| Résilier | ● | ○ | ✗ | ✗ | ✗ | ✗ |
| Annuler avant signature | ● | ○ | ✗ | ✗ | ✗ | ✗ |
| Gérer les modèles | ● | ✗ | ● | ✗ | ✗ | ✗ |
| Gérer les utilisateurs | ● | ✗ | ✗ | ✗ | ✗ | ✗ |
| Lire le journal d'audit | ● | ✗ | ● | ✗ | ✗ | ✗ |
| Exporter | ● | ○ | ● | ✗ | ✗ | ✗ |

Deux règles non évidentes, délibérées :

- **`MSP_ADMIN` ne peut pas signer.** Un employé LSI ne signe jamais à la place du client. Ce n'est pas une question de droits, c'est une question de valeur probante : un compte interne capable de déclencher une signature côté client détruirait la non-répudiation.
- **`LEGAL_REVIEWER` ne peut pas envoyer en signature.** Celui qui valide n'est pas celui qui expédie. Sans cette séparation, la validation interne est un théâtre.

---

## 4. Cas d'usage

### 4.1 Cas d'usage principaux

| ID | Acteur | Cas d'usage | Fréquence |
|---|---|---|---|
| UC-01 | Account manager | Créer un contrat depuis un modèle pour un client | Hebdo |
| UC-02 | Account manager | Créer un contrat sur mesure (from scratch) | Mensuel |
| UC-03 | Account manager | Soumettre un contrat à la validation interne | Hebdo |
| UC-04 | Juriste | Valider ou demander des modifications | Hebdo |
| UC-05 | Account manager | Envoyer un contrat en signature | Hebdo |
| UC-06 | Signataire client | Consulter et signer un contrat | Hebdo |
| UC-07 | Système | Synchroniser le statut de signature depuis DocuSeal | Continu |
| UC-08 | Système | Émettre les rappels à J-90, J-60, J-30 | Quotidien |
| UC-09 | Account manager | Renouveler un contrat arrivant à échéance | Mensuel |
| UC-10 | Account manager | Créer un avenant sur un contrat actif | Mensuel |
| UC-11 | Account manager | Résilier un contrat actif | Rare |
| UC-12 | Account manager | Annuler un contrat avant signature | Rare |
| UC-13 | Sylvie / Marc | Consulter le tableau de bord des échéances | Quotidien |
| UC-14 | Technicien | Retrouver le périmètre couvert d'un client | Quotidien |
| UC-15 | Admin | Consulter la piste d'audit d'un contrat | Rare, critique |
| UC-16 | Admin | Gérer la bibliothèque de modèles | Mensuel |
| UC-17 | Admin | Exporter le portefeuille contractuel | Mensuel |
| UC-18 | Admin | Traiter une demande RGPD (accès / effacement) | Rare, obligatoire |

### 4.2 Cas limites à traiter dès la conception

Ce sont eux qui font la différence entre une démo et un outil exploitable. Chacun est tracé jusqu'à une règle métier (§5) ou un test (§16).

| ID | Situation | Traitement retenu |
|---|---|---|
| EC-01 | Contrat déjà expiré au moment de la saisie (reprise d'existant) | Import autorisé avec statut calculé `EXPIRED`. Aucun rappel généré rétroactivement. Bandeau explicite. |
| EC-02 | Échéance à moins de 90 jours au moment de l'activation | Seuls les rappels encore dans le futur sont générés. Les autres sont créés en `SKIPPED_OBSOLETE` — tracés, non envoyés. Le silence n'est jamais une donnée. |
| EC-03 | Signataire remplacé en cours de signature (départ du dirigeant) | Nouveau signataire = nouvelle submission DocuSeal. L'ancienne est révoquée et archivée. Interdit de « réattribuer » un lien de signature : ce serait une atteinte à la non-répudiation. |
| EC-04 | DocuSeal indisponible à l'envoi | La transition passe en `PENDING_SIGNATURE` uniquement après confirmation du provider. En cas d'échec, retour en `APPROVED` + erreur affichée. Aucun état fantôme. |
| EC-05 | Webhook DocuSeal reçu deux fois | Idempotence par `provider_event_id` unique. Le second est ignoré et journalisé. |
| EC-06 | Webhook DocuSeal jamais reçu (perte réseau) | Job de réconciliation horaire : toute `signature_request` en cours et non mise à jour depuis 1 h est re-synchronisée via `GET /submissions/{id}`. Le webhook est une optimisation, pas la source de vérité. |
| EC-07 | Avenant demandé sur un contrat signé | Impossible d'éditer le signé. Un avenant est un **contrat à part entière** lié au parent, qui suit son propre cycle de signature. |
| EC-08 | Renouvellement refusé par le client | `renewal_request` → `REFUSED`. Le contrat parent suit son cours et expire à sa date. Pas de reconduction implicite. |
| EC-09 | Annulation après envoi mais avant signature | Révocation de la submission DocuSeal (archive), contrat → `CANCELLED`. Les signataires ayant déjà signé sont conservés en preuve. |
| EC-10 | Un signataire refuse (`form.declined`) | Contrat → `DECLINED`. Le motif est capté et affiché. Ni suppression ni réouverture silencieuse. |
| EC-11 | Pièce jointe obligatoire manquante à l'envoi | Blocage au moment de `submit_for_review`, pas à l'envoi. L'erreur doit arriver tôt. |
| EC-12 | Date de fin modifiée par un avenant | Les rappels en attente du parent sont invalidés et régénérés sur la nouvelle date. Un rappel obsolète est pire qu'aucun rappel. |
| EC-13 | Contrat sans date de fin (durée indéterminée) | Autorisé. Aucun rappel d'échéance ; à la place, rappel sur la date de préavis de résiliation si renseignée. |
| EC-14 | Client supprimé alors qu'il a des contrats signés | Suppression interdite. Archivage uniquement. Les obligations légales de conservation priment sur le confort de l'interface. |
| EC-15 | Le scheduler est resté en panne 3 jours | Les rappels dus sont matérialisés en base, pas calculés à la volée. Ils partent en retard avec un marqueur `late`. Rien n'est perdu. |
| EC-16 | Deux utilisateurs éditent le même brouillon | Verrouillage optimiste par numéro de version. Le second reçoit un `409 Conflict` explicite. |
| EC-17 | Un account manager perd un client de son portefeuille | Ses accès tombent à la seconde révocation de session (scope en session serveur, pas dans un JWT). Voir §10.5. |

---

## 5. Règles métier

Numérotées pour être référencées par les tests. Une règle sans test est une intention, pas une règle.

### 5.1 Cycle de vie et statuts

- **RM-01** — Un contrat a exactement un statut, issu de l'énumération §7.1. Toute transition non listée dans la matrice §7.2 est rejetée par le domaine (`InvalidTransitionError`), pas par l'interface.
- **RM-02** — `EXPIRING_SOON` **n'est pas un statut**. C'est une propriété dérivée de `end_date` et de la date du jour. Stocker un état que seul un job sait produire, c'est faire dépendre la vérité métier de la bonne santé du scheduler.
- **RM-03** — `archived_at` **n'est pas un statut** non plus. C'est un attribut orthogonal : un contrat `TERMINATED` peut être archivé ou non, et un contrat `ACTIVE` ne peut jamais l'être.
- **RM-04** — Le contenu d'un contrat n'est éditable qu'en `DRAFT` ou `CHANGES_REQUESTED`. Tout autre statut est en lecture seule sur le fond contractuel.
- **RM-05** — Un contrat signé est **immuable, définitivement**. Aucun rôle, y compris `MSP_ADMIN`, ne peut modifier son contenu ni son PDF. La seule évolution possible est un avenant.
- **RM-06** — Le passage à `ACTIVE` est automatique dès lors que le contrat est `SIGNED` **et** que `start_date <= aujourd'hui`. Un contrat signé dont la prise d'effet est future reste `SIGNED` jusqu'à sa date de début.
- **RM-07** — Le passage à `EXPIRED` est automatique le lendemain de `end_date`, sauf si un renouvellement a été signé (→ `RENEWED`).
- **RM-08** — Un contrat ne peut être `ACTIVE` que si `start_date <= end_date` ou `end_date IS NULL` (durée indéterminée).

### 5.2 Validation et signature

- **RM-09** — Un contrat ne peut être envoyé en signature que depuis `APPROVED`. Il n'existe aucun chemin `DRAFT` → `PENDING_SIGNATURE`, même pour un admin.
- **RM-10** — L'utilisateur qui a soumis un contrat à validation ne peut pas être celui qui le valide (séparation des tâches). Contrôlé en base par comparaison `submitted_by_user_id != approved_by_user_id`.
- **RM-11** — Toute modification du contenu après une validation invalide cette validation. Le contrat retourne en `DRAFT` et devra être revalidé. Une validation porte sur une **version précise**, jamais sur un contrat en général.
- **RM-12** — Un contrat doit avoir au moins un signataire côté client et un signataire côté LSI pour être envoyé.
- **RM-13** — L'ordre de signature est LSI d'abord, client ensuite, par défaut. Configurable par contrat.
- **RM-14** — Le statut de signature ne peut être modifié que par le `SYSTEM` sur la foi d'un webhook vérifié ou d'une réconciliation API. Aucun humain ne coche « signé » à la main.
- **RM-15** — Le PDF signé et sa piste d'audit sont récupérés et stockés côté LSI dès `form.completed`. On ne dépend jamais d'une URL DocuSeal à long terme pour produire une preuve.

### 5.3 Renouvellement, avenant, résiliation

- **RM-16** — Un renouvellement crée un **nouveau contrat** avec `predecessor_contract_id` pointant sur le parent. Le parent passe `RENEWED` à sa date de fin, pas avant.
- **RM-17** — Un avenant est un contrat de `type = AMENDMENT` avec `parent_contract_id`. Il suit le cycle complet, signature comprise. Un avenant non signé ne modifie rien.
- **RM-18** — À la signature d'un avenant, les champs qu'il modifie (`end_date`, montant, périmètre) sont reportés sur le contrat parent, et ses rappels sont régénérés (EC-12).
- **RM-19** — Il ne peut exister qu'un seul avenant en cours (non terminal) par contrat parent. Contrainte d'unicité partielle en base.
- **RM-20** — Une résiliation exige un motif et une date d'effet. Si le contrat impose un préavis, la date d'effet minimale est calculée et proposée ; la contourner exige le rôle `MSP_ADMIN` et une justification tracée.
- **RM-21** — Il n'y a **pas de reconduction tacite automatique** dans l'outil. Même si le contrat papier en prévoit une, l'application exige un acte explicite. Reconduire silencieusement une obligation contractuelle depuis un cron est un risque juridique que nous refusons de porter.
- **RM-22** — L'annulation n'est possible qu'avant `SIGNED`. Après, seule la résiliation existe.

### 5.4 Rappels

- **RM-23** — Les rappels sont **matérialisés en base** à l'activation du contrat, pas calculés au moment de l'envoi (EC-15).
- **RM-24** — Un rappel est unique par `(contract_id, offset_days, cycle)`. Contrainte d'unicité en base — la prévention des doublons ne repose pas sur la logique applicative.
- **RM-25** — Un rappel dont l'échéance de déclenchement est déjà passée au moment de sa création naît en `SKIPPED_OBSOLETE` (EC-02).
- **RM-26** — Un rappel dû mais non envoyé reste dû. Il part en retard avec `late = true`. Il n'est jamais silencieusement abandonné.
- **RM-27** — Les rappels client (email externe) ne partent qu'à J-60 et J-30, et seulement si le contrat est `ACTIVE` et non déjà en cours de renouvellement. J-90 est purement interne : à 90 jours, c'est à LSI de préparer sa proposition, pas au client de s'inquiéter.

### 5.5 Cloisonnement (règles opposables)

- **RM-28** — Tout objet métier porte `tenant_id` **et** `customer_id`. Sans exception. Une table métier sans ces colonnes est un défaut bloquant.
- **RM-29** — `tenant_id` et `customer_id` ne sont **jamais** lus depuis une entrée utilisateur (URL, body, query, header). Ils proviennent exclusivement de la session serveur.
- **RM-30** — Un accès à une ressource hors périmètre renvoie **404, jamais 403**. Un 403 confirme l'existence de la ressource et transforme l'API en oracle d'énumération.
- **RM-31** — Une session client est épinglée à un `customer_id` unique, fixé à l'authentification, non modifiable pendant la session.
- **RM-32** — Aucun compte ne peut appartenir simultanément à la famille INTERNE et à la famille CLIENT.
- **RM-33** — Toute lecture ou écriture passe par une connexion base dont le scope est positionné. Une requête sans scope échoue par exception PostgreSQL, pas en retournant zéro ligne.

### 5.6 Données et rétention

- **RM-34** — Aucune suppression physique d'un contrat ayant atteint `SIGNED`. Archivage uniquement (EC-14).
- **RM-35** — Les brouillons jamais soumis sont purgeables après 12 mois d'inactivité.
- **RM-36** — Les contrats et preuves de signature sont conservés 10 ans après leur fin, puis purgés (§13.6).
- **RM-37** — Une demande d'effacement RGPD portant sur un signataire n'efface pas le contrat signé : elle pseudonymise les données de contact **non probantes** et conserve les éléments de preuve. L'intérêt légitime et l'obligation légale priment sur l'effacement pour ces champs précis, et cet arbitrage est documenté au registre.

---

## 6. Modules fonctionnels

### 6.1 Tableau de bord

- **Objectif** : répondre en cinq secondes à « qu'est-ce qui va me tomber dessus ? ». C'est l'écran d'adoption de Sylvie.
- **Utilisateurs** : tous les rôles internes.
- **Actions** : filtrer, cliquer vers un contrat, lancer un renouvellement en un clic.
- **Données** : agrégats sur `contracts` restreints au portefeuille de l'utilisateur.
- **Règles** : les compteurs respectent strictement le scope. Un account manager voit « 12 contrats à renouveler » sur *ses* clients — jamais un total global qui fuiterait l'activité des autres.
- **Écrans** : `/dashboard`.

### 6.2 Gestion des clients

- **Objectif** : référentiel des clients et de leurs contacts.
- **Utilisateurs** : `MSP_ADMIN`, `ACCOUNT_MANAGER` (lecture sur son portefeuille), `TECHNICIAN` (lecture).
- **Actions** : créer, éditer, archiver un client ; gérer les contacts ; affecter les portefeuilles (admin seul).
- **Données** : `customers`, `customer_contacts`, `customer_access`.
- **Règles** : SIREN unique par tenant. Un client avec des contrats signés ne peut être supprimé (EC-14).
- **Écrans** : `/customers`, `/customers/:id`, `/customers/:id/contacts`, `/settings/access`.

### 6.3 Bibliothèque de modèles

- **Objectif** : industrialiser la rédaction et garantir que les clauses validées par le juriste sont réellement celles qui partent.
- **Utilisateurs** : `MSP_ADMIN`, `LEGAL_REVIEWER`.
- **Actions** : créer, versionner, publier, déprécier un modèle ; définir les variables.
- **Données** : `contract_templates`, `contract_template_versions`.
- **Règles** : les modèles sont au niveau **tenant** (H10) — ils ne portent pas de `customer_id`. Un modèle publié est immuable ; une correction crée une nouvelle version. Un contrat garde une référence figée vers la version de modèle utilisée : savoir « quel texte type a servi » est indispensable en litige.
- **Écrans** : `/templates`, `/templates/:id`, `/templates/:id/versions/:v`.

### 6.4 Éditeur / générateur de contrats

- **Objectif** : produire le texte contractuel à partir d'un modèle et de variables, ou sur mesure.
- **Utilisateurs** : `MSP_ADMIN`, `ACCOUNT_MANAGER`.
- **Actions** : instancier un modèle, renseigner les variables, éditer le corps, prévisualiser le PDF.
- **Données** : `contract_versions` (corps + variables), `contracts` (métadonnées).
- **Règles** : l'édition n'est possible qu'en `DRAFT`/`CHANGES_REQUESTED` (RM-04). Chaque enregistrement significatif crée une version. La prévisualisation PDF utilise exactement la même chaîne de rendu que la génération finale — un aperçu qui ment est pire que pas d'aperçu.
- **Écrans** : `/contracts/new`, `/contracts/:id/edit`.

### 6.5 Gestion des versions

- **Objectif** : savoir qui a écrit quoi, quand, et ce qui a changé.
- **Utilisateurs** : rôles internes.
- **Actions** : lister, comparer deux versions, consulter, restaurer un contenu dans un nouveau brouillon.
- **Données** : `contract_versions` (immuables).
- **Règles** : une version n'est jamais modifiée ni supprimée. « Restaurer » crée une nouvelle version au contenu identique à l'ancienne — l'historique est un journal, pas un espace de travail.
- **Écrans** : `/contracts/:id/versions`, `/contracts/:id/versions/compare`.

### 6.6 Workflow de validation interne

- **Objectif** : garantir qu'aucun engagement ne part sans relecture.
- **Utilisateurs** : `ACCOUNT_MANAGER` (soumet), `LEGAL_REVIEWER` / `MSP_ADMIN` (statue).
- **Actions** : soumettre, approuver, demander des modifications (avec motif obligatoire).
- **Données** : `contract_approvals`.
- **Règles** : RM-10 (séparation), RM-11 (validation liée à une version).
- **Écrans** : `/contracts/:id` (panneau de validation), `/reviews` (file d'attente du juriste).

### 6.7 Envoi en signature

- **Objectif** : transformer un contrat approuvé en demande de signature.
- **Utilisateurs** : `MSP_ADMIN`, `ACCOUNT_MANAGER`.
- **Actions** : définir les signataires et leur ordre, prévisualiser, envoyer, relancer, révoquer.
- **Données** : `contract_signers`, `signature_requests`.
- **Règles** : RM-09, RM-12, RM-13. La transition n'est actée qu'après acquittement de DocuSeal (EC-04).
- **Écrans** : `/contracts/:id/send` (assistant en 3 étapes).

### 6.8 Suivi des signatures

- **Objectif** : savoir où en est chaque signature sans appeler le client.
- **Utilisateurs** : rôles internes ; le client voit sa propre progression.
- **Actions** : consulter la progression par signataire, relancer, révoquer, télécharger le signé.
- **Données** : `signature_requests`, `signature_events`.
- **Règles** : statut piloté par le système uniquement (RM-14). Vue par signataire : envoyé / ouvert / signé / refusé, horodatée.
- **Écrans** : `/contracts/:id` (bloc signature), `/signatures`.

### 6.9 Journal d'activité

- **Objectif** : reconstituer l'histoire complète d'un contrat en cas de litige.
- **Utilisateurs** : `MSP_ADMIN`, `LEGAL_REVIEWER` pour le journal complet ; timeline lisible pour les autres.
- **Actions** : consulter, filtrer, exporter.
- **Données** : `audit_logs` (append-only, chaînés par hash).
- **Règles** : aucune modification ni suppression possible, y compris par un admin. Voir §13.4.
- **Écrans** : `/contracts/:id` (timeline), `/audit` (vue admin).

### 6.10 Commentaires et échanges

- **Objectif** : garder la discussion contractuelle attachée au contrat plutôt que dispersée dans les boîtes mail.
- **Utilisateurs** : tous, selon la visibilité.
- **Actions** : commenter, répondre, mentionner un collègue, résoudre un fil.
- **Données** : `comments`.
- **Règles** : deux visibilités, `INTERNAL` et `SHARED`. **Le défaut est `INTERNAL`.** Un commentaire interne n'est jamais visible du client, et le passage `INTERNAL` → `SHARED` est irréversible avec confirmation explicite. C'est le risque de fuite le plus banal et le plus probable de toute l'application : un juriste qui écrit « on peut descendre à 15 % si besoin » et qui coche la mauvaise case.
- **Écrans** : `/contracts/:id` (panneau latéral), avec code couleur non ambigu.

### 6.11 Rappels d'échéance

- **Objectif** : rendre structurellement impossible l'expiration silencieuse.
- **Utilisateurs** : internes (destinataires), système (émetteur).
- **Actions** : consulter, forcer un envoi, annuler un rappel, marquer traité.
- **Données** : `reminders`, `notifications`.
- **Règles** : RM-23 à RM-27.
- **Écrans** : `/dashboard` (widget), `/reminders`.

### 6.12 Renouvellements et avenants

- **Objectif** : gérer la suite de la vie du contrat sans jamais toucher au signé.
- **Utilisateurs** : `MSP_ADMIN`, `ACCOUNT_MANAGER`.
- **Actions** : initier un renouvellement (pré-rempli depuis le parent), initier un avenant, suivre l'acceptation ou le refus.
- **Données** : `renewal_requests`, `amendments`, `contracts`.
- **Règles** : RM-16 à RM-19, RM-21.
- **Écrans** : `/contracts/:id/renew`, `/contracts/:id/amend`.

### 6.13 Résiliations et annulations

- **Objectif** : sortir d'un contrat proprement et de façon traçable.
- **Utilisateurs** : `MSP_ADMIN`, `ACCOUNT_MANAGER`.
- **Actions** : résilier (motif + date d'effet + préavis), annuler avant signature.
- **Données** : `cancellations`.
- **Règles** : RM-20, RM-22, EC-09.
- **Écrans** : `/contracts/:id/terminate`, modale d'annulation.

### 6.14 Archivage et recherche

- **Objectif** : retrouver n'importe quel contrat en quelques secondes, actif ou clos.
- **Utilisateurs** : internes.
- **Actions** : rechercher (plein texte + facettes), filtrer, archiver, désarchiver, exporter.
- **Données** : `contracts`, `contract_versions`, index PostgreSQL `tsvector`.
- **Règles** : la recherche est soumise à RLS comme tout le reste. Un moteur de recherche externe non scopé serait le contournement le plus facile de tout le dispositif — d'où le choix d'un index dans la même base (§9.3).
- **Écrans** : `/contracts` (liste + recherche), `/archive`.

### 6.15 Espace client

- **Objectif** : offrir au client un accès sûr à ses seuls contrats, sans mot de passe à retenir.
- **Utilisateurs** : `CLIENT_SIGNER`, `CLIENT_VIEWER`.
- **Actions** : lister ses contrats, consulter, signer, télécharger, commenter en `SHARED`.
- **Données** : sous-ensemble strictement scopé.
- **Règles** : RM-31. Le portail est servi sur un chemin distinct (`/portal/*`), avec un cookie de session distinct et un middleware qui refuse par défaut tout ce qui n'est pas explicitement autorisé.
- **Écrans** : `/portal/login`, `/portal/contracts`, `/portal/contracts/:id`, `/portal/sign/:token`.

---

## 7. Workflow des contrats

### 7.1 Statuts

```
DRAFT                Brouillon éditable
IN_REVIEW            Soumis à la validation interne
CHANGES_REQUESTED    Le juriste demande des modifications — éditable
APPROVED             Validé en interne, prêt à partir
PENDING_SIGNATURE    Envoyé, aucune signature encore
PARTIALLY_SIGNED     Au moins un signataire a signé, pas tous
SIGNED               Tous les signataires ont signé
ACTIVE               Signé et en vigueur (start_date atteinte)
EXPIRED              Terminé par arrivée du terme
TERMINATED           Résilié avant terme
RENEWED              Remplacé par un contrat successeur
CANCELLED            Abandonné avant signature
DECLINED             Refusé par un signataire
```

Ne sont **pas** des statuts, et c'est délibéré :

| Notion | Traitement | Pourquoi |
|---|---|---|
| `EXPIRING_SOON` | Dérivé de `end_date` | RM-02 — sinon la vérité métier dépend du scheduler |
| `ARCHIVED` | Attribut `archived_at` | RM-03 — orthogonal au cycle de vie |
| `SUSPENDED` | Hors périmètre MVP | Aucun besoin exprimé (YAGNI) |

### 7.2 Matrice de transitions

Depuis (ligne) vers (colonne). `A` = acteur, `S` = système.

| De \ Vers | IN_REVIEW | CHANGES_REQ | APPROVED | PENDING_SIG | PART_SIGNED | SIGNED | ACTIVE | EXPIRED | TERMINATED | RENEWED | CANCELLED | DECLINED | DRAFT |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **DRAFT** | A | | | | | | | | | | A | | |
| **IN_REVIEW** | | A | A | | | | | | | | A | | |
| **CHANGES_REQUESTED** | A | | | | | | | | | | A | | |
| **APPROVED** | | | | A | | | | | | | A | | A¹ |
| **PENDING_SIGNATURE** | | | | | S | S | | | | | A | S | |
| **PARTIALLY_SIGNED** | | | | | | S | | | | | A | S | |
| **SIGNED** | | | | | | | S | | A | | | | |
| **ACTIVE** | | | | | | | | S | A | S | | | |
| **EXPIRED** | | | | | | | | | | S² | | | |
| **TERMINATED / RENEWED / CANCELLED / DECLINED** | — états terminaux — | | | | | | | | | | | | |

¹ RM-11 : toute édition d'un contrat `APPROVED` le renvoie en `DRAFT` et invalide la validation.
² Un contrat `EXPIRED` peut encore passer `RENEWED` si le renouvellement est signé après coup (cas fréquent : renouvellement tardif rétroactif).

### 7.3 Conditions de transition

| Transition | Garde | Effets de bord |
|---|---|---|
| `DRAFT → IN_REVIEW` | ≥ 1 signataire client ; ≥ 1 signataire LSI ; `start_date` renseignée ; pièces jointes obligatoires présentes (EC-11) ; version courante non vide | Fige la version soumise ; crée `contract_approvals` ; notifie les juristes |
| `IN_REVIEW → APPROVED` | Acteur ∈ {`LEGAL_REVIEWER`,`MSP_ADMIN`} ; `actor != submitted_by` (RM-10) | Enregistre `approved_version_id` ; notifie le soumettant |
| `IN_REVIEW → CHANGES_REQUESTED` | Idem + motif non vide | Notifie le soumettant avec le motif |
| `APPROVED → PENDING_SIGNATURE` | `approved_version_id == current_version_id` ; PDF généré ; DocuSeal a **acquitté** la submission | Crée `signature_requests` ; DocuSeal envoie les invitations. Sur échec provider → reste `APPROVED` + erreur (EC-04) |
| `PENDING_SIGNATURE → PARTIALLY_SIGNED` | Webhook `form.completed` vérifié, ≥ 1 signataire restant | Journalise `signature_events` |
| `→ SIGNED` | Tous les `contract_signers` ont `signed_at != null` | Télécharge PDF signé + audit trail, calcule le SHA-256, stocke (RM-15) |
| `SIGNED → ACTIVE` | `start_date <= today` (RM-06) | **Génère les rappels** (RM-23) ; notifie l'account manager |
| `ACTIVE → EXPIRED` | `end_date < today` et aucun successeur signé (RM-07) | Notifie ; annule les rappels en attente |
| `ACTIVE|EXPIRED → RENEWED` | Contrat successeur en statut `SIGNED`/`ACTIVE` | Renseigne `successor_contract_id` |
| `* → TERMINATED` | Statut ∈ {`SIGNED`,`ACTIVE`} ; motif + date d'effet ; préavis respecté ou dérogation admin (RM-20) | Crée `cancellations` ; annule les rappels |
| `* → CANCELLED` | Statut antérieur à `SIGNED` (RM-22) | Révoque la submission DocuSeal si elle existe (EC-09) |
| `* → DECLINED` | Webhook `form.declined` vérifié | Capte le motif ; notifie ; annule les autres invitations |

### 7.4 Workflow — création depuis modèle (UC-01)

```
1. Account manager choisit un client de SON portefeuille
   → la liste ne contient QUE ses clients (RM-29 : scope serveur)
2. Choisit un modèle publié (niveau tenant)
3. Le système instancie :
   - contract (DRAFT, tenant_id + customer_id issus de la session)
   - contract_version v1 (corps rendu + variables + template_version_id figé)
4. Renseigne variables métier, dates, montant, signataires
5. Enregistre → nouvelle version à chaque changement significatif
6. Soumet à validation → IN_REVIEW
```

### 7.5 Workflow — création from scratch (UC-02)

Identique à partir de l'étape 3, sans `template_version_id` et avec un corps vide. Ces deux parcours convergent immédiatement sur le même objet : il n'existe pas deux types de contrats dans le domaine, seulement deux façons d'amorcer la version 1.

### 7.6 Workflow — nominal complet

```
DRAFT ──soumet──> IN_REVIEW ──valide──> APPROVED ──envoie──> PENDING_SIGNATURE
                      │                     │                       │
              demande modifs         édition (RM-11)          webhooks DocuSeal
                      ↓                     ↓                       ↓
              CHANGES_REQUESTED  ────>   DRAFT            PARTIALLY_SIGNED
                                                                    ↓
                                                                 SIGNED
                                                                    ↓
                                                     (start_date atteinte, job quotidien)
                                                                    ↓
                                                                 ACTIVE
                                                                    ↓
                                                   génération des rappels J-90/60/30
```

### 7.7 Workflow — échéance et renouvellement (UC-08, UC-09)

```
Activation du contrat
   └─> matérialisation de 3 reminders (end_date − 90 / 60 / 30 j)
        │  si due_at déjà passé → SKIPPED_OBSOLETE (RM-25, EC-02)
        ↓
Job quotidien 06:00 : SELECT reminders WHERE status=PENDING AND due_at <= now()
        ↓
Pour chaque rappel : enqueue job (payload = {tenantId, customerId, reminderId})
        ↓
Envoi + reminder.status = SENT, sent_at, late = (now - due_at > 24h)
        ↓
J-90 : notification interne seule (RM-27)
J-60 : notification interne + email client (si ACTIVE et pas de renouvellement en cours)
J-30 : idem + escalade au MSP_ADMIN si aucun renewal_request n'existe
        ↓
Account manager clique « Renouveler »
        ↓
renewal_request (PENDING) + nouveau contrat DRAFT pré-rempli
   predecessor_contract_id = parent
        ↓
   ┌──── accepté : le nouveau contrat suit le cycle nominal
   │         └─> à sa signature, parent.successor_contract_id renseigné
   │             puis parent → RENEWED à end_date
   └──── refusé (EC-08) : renewal_request → REFUSED
             le parent expire normalement. AUCUNE reconduction tacite (RM-21).
```

### 7.8 Workflow — avenant (UC-10)

```
Contrat ACTIVE (immuable, RM-05)
   └─> « Créer un avenant »
        └─> nouveau contrat : type=AMENDMENT, parent_contract_id=parent
            statut DRAFT, hérite de customer_id
            (RM-19 : rejet si un avenant non terminal existe déjà)
             ↓
        cycle complet : DRAFT → IN_REVIEW → APPROVED → signature → SIGNED
             ↓
        à SIGNED (RM-18) :
          - application des deltas sur le parent (end_date, montant, périmètre)
          - régénération des rappels du parent (EC-12)
          - le parent RESTE ACTIVE — il n'est jamais remplacé
```

Le point important : le contrat parent n'est pas modifié « par un formulaire ». Il est modifié par un acte signé. C'est ce qui rend l'avenant opposable.

### 7.9 Workflow — résiliation (UC-11)

```
Contrat ACTIVE
   └─> « Résilier » : motif obligatoire + date d'effet
        ↓
   calcul du préavis : effective_date_min = today + notice_period_days
        ↓
   ┌── date >= minimum : OK
   └── date <  minimum : blocage.
         Dérogation possible pour MSP_ADMIN uniquement,
         avec justification tracée dans cancellations.override_reason (RM-20)
        ↓
   cancellations(type=TERMINATION) + contrat → TERMINATED à la date d'effet
   annulation des rappels PENDING
```

### 7.10 Workflow — annulation avant signature (UC-12, EC-09)

```
Contrat DRAFT / IN_REVIEW / APPROVED / PENDING_SIGNATURE / PARTIALLY_SIGNED
   └─> « Annuler » + motif
        ↓
   si une signature_request est active :
        DELETE /submissions/{id} sur DocuSeal (archivage)
        signature_request → REVOKED
        les signatures DÉJÀ apposées sont conservées en preuve
        ↓
   cancellations(type=CANCELLATION) + contrat → CANCELLED (terminal)
```

---

## 8. Modèle de données

### 8.1 Principe de scoping

Trois classes de tables, et c'est la distinction la plus importante du modèle :

| Classe | Colonnes de scope | Exemples | RLS |
|---|---|---|---|
| **Plateforme** | aucune | `tenants` | Politique dédiée, accès admin uniquement |
| **Tenant** | `tenant_id` | `users`, `roles`, `contract_templates`, `customers` | Filtrée sur le tenant |
| **Customer** | `tenant_id` + `customer_id` | `contracts`, `contract_versions`, `comments`, `attachments`, `reminders`, `signature_requests`, `audit_logs`… | Filtrée sur tenant **et** portefeuille |

**`customer_id` est dénormalisé sur toutes les tables filles**, y compris là où il serait dérivable via `contract_id`. C'est une redondance assumée : une politique RLS qui doit faire une jointure pour connaître le scope d'une ligne est une politique lente et, surtout, fragile. On veut que le scope soit lisible sur la ligne elle-même. La cohérence est garantie par des clés étrangères composites (§8.4).

### 8.2 MCD textuel

```
tenants (1) ──< (N) users
tenants (1) ──< (N) customers
tenants (1) ──< (N) contract_templates
tenants (1) ──< (N) roles

users (N) >──< (N) customers            via customer_access  [portefeuille interne]
users (1) ──< (N) user_tenant_memberships >── (1) tenants
users (1) ──o (1) customers             [users CLIENT : rattachement unique, RM-31]

customers (1) ──< (N) customer_contacts
customers (1) ──< (N) contracts

contract_templates (1) ──< (N) contract_template_versions
contract_template_versions (1) ──o (N) contracts        [référence figée]

contracts (1) ──< (N) contract_versions
contracts (1) ──< (N) contract_signers
contracts (1) ──< (N) contract_approvals
contracts (1) ──< (N) signature_requests
contracts (1) ──< (N) comments
contracts (1) ──< (N) attachments
contracts (1) ──< (N) reminders
contracts (1) ──o (N) cancellations
contracts (1) ──o (N) renewal_requests
contracts (1) ──o (1) contracts         [parent_contract_id     — avenant]
contracts (1) ──o (1) contracts         [predecessor/successor  — renouvellement]

signature_requests (1) ──< (N) signature_events
signature_requests (1) ──< (N) contract_signers   [via submitter mapping]

reminders (1) ──< (N) notifications
users (1) ──< (N) notifications

audit_logs                              [append-only, chaîné par hash, scopé]
```

Une remarque sur `amendments` et `cancellations`, que la demande listait comme entités distinctes. J'ai délibérément **fusionné `amendments` dans `contracts`** (`type = AMENDMENT` + `parent_contract_id`). Une table `amendments` séparée serait un piège : un avenant doit se rédiger, se versionner, se valider, se signer et se tracer exactement comme un contrat. Une table dédiée dupliquerait tout ce cycle, et le premier bug serait « on ne peut pas faire d'avenant à un avenant ». En revanche `cancellations` reste une table à part : une résiliation n'est pas un document à signer dans notre périmètre, c'est un acte de gestion avec motif, date d'effet et dérogation éventuelle.

### 8.3 Tables principales

Types : `id` = UUIDv7 (ordonné dans le temps → index performants, et non énumérable — voir RM-30).

#### `tenants`
| Colonne | Type | Contraintes |
|---|---|---|
| `id` | uuid | PK |
| `name` | text | NOT NULL |
| `slug` | text | UNIQUE, NOT NULL |
| `status` | enum | `ACTIVE`/`SUSPENDED` |
| `created_at`, `updated_at` | timestamptz | NOT NULL |

#### `users`
| Colonne | Type | Contraintes |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK → tenants, NOT NULL |
| `kind` | enum | `INTERNAL` / `CLIENT` — **immuable** (RM-32) |
| `customer_id` | uuid | FK → customers, NULL si INTERNAL, NOT NULL si CLIENT |
| `email` | citext | NOT NULL |
| `full_name` | text | NOT NULL |
| `status` | enum | `ACTIVE`/`DISABLED` |
| `external_idp_sub` | text | NULL — sujet OIDC Entra ID (H6) |
| `last_login_at` | timestamptz | |

Contraintes clés :
```sql
UNIQUE (tenant_id, email)
CHECK ((kind = 'CLIENT'   AND customer_id IS NOT NULL)
    OR (kind = 'INTERNAL' AND customer_id IS NULL))   -- RM-32, en base
```
Ce `CHECK` est la traduction en base de la règle « aucun compte hybride ». Il ne peut pas être oublié par un développeur pressé.

#### `roles` / `user_roles`
`roles` : `id`, `tenant_id`, `code` (enum §3.2), `label`. `user_roles` : `user_id`, `role_id`, PK composite. Modèle simple assumé : à moins de 20 utilisateurs internes (H5), un moteur de permissions à granularité fine serait du sur-mesure inutile.

#### `customer_access` — le portefeuille
| Colonne | Type | Contraintes |
|---|---|---|
| `tenant_id` | uuid | FK, NOT NULL |
| `user_id` | uuid | FK → users, NOT NULL |
| `customer_id` | uuid | FK → customers, NOT NULL |
| `granted_by_user_id` | uuid | FK → users |
| `granted_at` | timestamptz | NOT NULL |

PK `(user_id, customer_id)`. C'est la table la plus sensible de l'application : elle définit qui voit quoi côté interne. Toute écriture y est auditée, et seul `MSP_ADMIN` peut l'écrire. Les rôles `MSP_ADMIN` et `LEGAL_REVIEWER` n'y ont pas de lignes — ils portent un accès `all_customers` implicite, résolu à l'ouverture de session.

#### `customers`
`id`, `tenant_id`, `name`, `legal_name`, `siren` (9 car.), `vat_number`, `address_*`, `status` (`ACTIVE`/`ARCHIVED`), `notes`, traçabilité.
`UNIQUE (tenant_id, siren) WHERE siren IS NOT NULL`.

#### `customer_contacts`
`id`, `tenant_id`, `customer_id`, `first_name`, `last_name`, `email`, `phone`, `job_title`, `is_signatory` (bool), `is_primary` (bool).
`UNIQUE (customer_id, email)`.

#### `contract_templates` / `contract_template_versions`
`contract_templates` : `id`, `tenant_id`, `name`, `category` (enum `MAINTENANCE`/`SUPPORT`/`HOSTING`/`SLA`/`OTHER`), `status` (`DRAFT`/`PUBLISHED`/`DEPRECATED`), `current_version_id`.
Pas de `customer_id` — les modèles sont mutualisés (H10).

`contract_template_versions` : `id`, `tenant_id`, `template_id`, `version_number`, `body_html`, `variables_schema` (jsonb — JSON Schema des variables attendues), `docuseal_template_id` (int, NULL), `published_at`, `published_by_user_id`, `is_immutable` (bool).
`UNIQUE (template_id, version_number)`.

#### `contracts` — table centrale
| Colonne | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | NOT NULL |
| `customer_id` | uuid | NOT NULL — **frontière d'isolation** |
| `reference` | text | Ex. `LSI-2026-0042` |
| `title` | text | NOT NULL |
| `type` | enum | `MAIN` / `AMENDMENT` |
| `status` | enum | §7.1, NOT NULL |
| `category` | enum | |
| `template_version_id` | uuid | NULL si from scratch — **référence figée** |
| `current_version_id` | uuid | version courante |
| `approved_version_id` | uuid | RM-11 |
| `parent_contract_id` | uuid | avenant → parent |
| `predecessor_contract_id` | uuid | renouvellement |
| `successor_contract_id` | uuid | |
| `start_date` | date | |
| `end_date` | date | NULL = durée indéterminée (EC-13) |
| `notice_period_days` | int | préavis, RM-20 |
| `amount_cents` | bigint | **entier, jamais un float** |
| `currency` | char(3) | défaut `EUR` |
| `billing_frequency` | enum | `MONTHLY`/`QUARTERLY`/`YEARLY`/`ONE_OFF` |
| `auto_renew_intent` | bool | intention documentaire seulement — **ne déclenche aucune action** (RM-21) |
| `signed_at`, `activated_at`, `terminated_at`, `archived_at` | timestamptz | |
| `owner_user_id` | uuid | account manager responsable |
| `search_vector` | tsvector | généré, §9.3 |
| `created_at`, `updated_at`, `created_by_user_id`, `updated_by_user_id` | | traçabilité |

`reference` : `UNIQUE (tenant_id, reference)`.

#### `contract_versions` — immuables
`id`, `tenant_id`, `customer_id`, `contract_id`, `version_number`, `body_html`, `variables` (jsonb), `pdf_object_key` (text), `pdf_sha256` (char(64)), `change_summary`, `created_at`, `created_by_user_id`.
`UNIQUE (contract_id, version_number)`. **Aucun `updated_at`** : l'absence de cette colonne est la documentation de l'immuabilité. Pas de `UPDATE`/`DELETE` accordés sur cette table au rôle applicatif.

#### `contract_signers`
`id`, `tenant_id`, `customer_id`, `contract_id`, `party` (enum `LSI`/`CLIENT`), `contact_id` (NULL si interne), `user_id` (NULL), `full_name`, `email`, `role_label`, `signing_order` (int), `status` (`PENDING`/`SENT`/`VIEWED`/`SIGNED`/`DECLINED`), `signed_at`, `declined_at`, `decline_reason`, `provider_submitter_id` (text), `provider_submitter_slug` (text).
`UNIQUE (contract_id, email)`, `UNIQUE (provider_submitter_id) WHERE provider_submitter_id IS NOT NULL`.

#### `contract_approvals`
`id`, `tenant_id`, `customer_id`, `contract_id`, `version_id`, `submitted_by_user_id`, `decided_by_user_id`, `decision` (`PENDING`/`APPROVED`/`CHANGES_REQUESTED`), `reason`, `submitted_at`, `decided_at`.
```sql
CHECK (decided_by_user_id IS NULL OR decided_by_user_id <> submitted_by_user_id)  -- RM-10 en base
```

#### `signature_requests`
`id`, `tenant_id`, `customer_id`, `contract_id`, `version_id`, `provider` (enum `DOCUSEAL`), `provider_submission_id` (text), `status` (`CREATING`/`SENT`/`PARTIALLY_COMPLETED`/`COMPLETED`/`DECLINED`/`EXPIRED`/`REVOKED`/`FAILED`), `idempotency_key` (text), `expire_at`, `signed_pdf_object_key`, `signed_pdf_sha256`, `audit_trail_object_key`, `last_synced_at`, `error_message`, traçabilité.

`UNIQUE (provider, provider_submission_id)` ← **c'est cette contrainte qui permet de résoudre le tenant d'un webhook** (§11.4).
`UNIQUE (idempotency_key)`.
`UNIQUE (contract_id) WHERE status IN ('CREATING','SENT','PARTIALLY_COMPLETED')` — une seule demande active à la fois.

#### `signature_events` — journal provider
`id`, `tenant_id`, `customer_id`, `signature_request_id`, `provider_event_id` (text), `event_type` (`form.viewed`/`form.started`/`form.completed`/`form.declined`/`submission.completed`/`submission.expired`), `submitter_email`, `occurred_at`, `received_at`, `ip`, `user_agent`, `raw_payload` (jsonb), `processed_at`, `processing_error`.
`UNIQUE (provider_event_id)` ← **l'idempotence des webhooks (EC-05), garantie en base et non en code**.

#### `comments`
`id`, `tenant_id`, `customer_id`, `contract_id`, `parent_comment_id`, `author_user_id`, `visibility` (enum `INTERNAL`/`SHARED`, **défaut `INTERNAL`**), `body`, `resolved_at`, `resolved_by_user_id`, traçabilité.
```sql
-- Un utilisateur CLIENT ne peut créer que des commentaires SHARED.
-- Vérifié en service ET par la politique RLS WITH CHECK (§10.3).
```

#### `attachments`
`id`, `tenant_id`, `customer_id`, `contract_id`, `version_id` (NULL), `filename`, `content_type`, `size_bytes`, `object_key`, `sha256`, `visibility` (`INTERNAL`/`SHARED`), `uploaded_by_user_id`, `virus_scan_status` (`PENDING`/`CLEAN`/`INFECTED`), `created_at`.

#### `reminders`
`id`, `tenant_id`, `customer_id`, `contract_id`, `kind` (enum `EXPIRY`/`NOTICE_DEADLINE`), `offset_days` (int : 90/60/30), `cycle` (int — incrémenté à chaque régénération, EC-12), `due_at` (timestamptz), `status` (`PENDING`/`SENT`/`SKIPPED_OBSOLETE`/`CANCELLED`/`FAILED`), `sent_at`, `late` (bool), `attempts` (int), `last_error`, `created_at`.

```sql
UNIQUE (contract_id, kind, offset_days, cycle)   -- RM-24 : anti-doublon en base
```
La régénération après avenant incrémente `cycle`, ce qui permet de recréer des rappels aux mêmes offsets sans violer la contrainte — tout en conservant l'historique des anciens, passés en `CANCELLED`. L'historique des rappels est lui aussi une preuve.

#### `notifications`
`id`, `tenant_id`, `customer_id` (NULL pour une notif purement interne non liée à un client), `recipient_user_id`, `channel` (`IN_APP`/`EMAIL`), `type` (enum), `subject`, `body`, `related_contract_id`, `related_reminder_id`, `status` (`QUEUED`/`SENT`/`FAILED`/`READ`), `sent_at`, `read_at`, `dedup_key` (text), `error`.
`UNIQUE (dedup_key) WHERE dedup_key IS NOT NULL`.

#### `audit_logs` — append-only
| Colonne | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | NOT NULL |
| `customer_id` | uuid | NULL si action de niveau tenant |
| `actor_user_id` | uuid | NULL si `SYSTEM` |
| `actor_kind` | enum | `INTERNAL`/`CLIENT`/`SYSTEM` |
| `actor_ip`, `actor_user_agent` | text | |
| `action` | text | Ex. `contract.approved` |
| `resource_type`, `resource_id` | text/uuid | |
| `before`, `after` | jsonb | diff — jamais de secrets |
| `request_id` | text | corrélation trace ↔ log ↔ audit |
| `occurred_at` | timestamptz | |
| `prev_hash`, `hash` | char(64) | **chaîne de hash** — §13.4 |

Aucun `UPDATE`/`DELETE` n'est accordé sur cette table, à aucun rôle applicatif (§13.4).

#### `renewal_requests`
`id`, `tenant_id`, `customer_id`, `contract_id` (parent), `new_contract_id` (NULL au début), `status` (`PENDING`/`ACCEPTED`/`REFUSED`/`EXPIRED`), `initiated_by_user_id`, `initiated_at`, `decided_at`, `refusal_reason`.
`UNIQUE (contract_id) WHERE status = 'PENDING'`.

#### `cancellations`
`id`, `tenant_id`, `customer_id`, `contract_id`, `type` (`CANCELLATION`/`TERMINATION`), `reason` (NOT NULL), `initiated_by` (`LSI`/`CLIENT`), `effective_date`, `notice_respected` (bool), `override_reason` (text — RM-20), `override_by_user_id`, `created_by_user_id`, `created_at`.

### 8.4 Intégrité référentielle — clés composites

C'est le détail qui rend le cloisonnement **structurel** plutôt que déclaratif, et il est trop souvent omis.

Chaque table filles porte `customer_id`. Si les FK étaient naïves (`contract_id → contracts(id)`), rien n'empêcherait en base d'insérer un commentaire avec le `customer_id` du client A sur un contrat du client B. La ligne serait alors visible du client A **tout en parlant du contrat de B**. RLS ne verrait rien à redire : elle vérifie le scope de la ligne, pas sa cohérence.

La parade : des clés étrangères **composites**.

```sql
-- Cible : clé candidate composite sur contracts
ALTER TABLE contracts ADD CONSTRAINT contracts_scope_key
  UNIQUE (id, tenant_id, customer_id);

-- Source : la FK embarque le scope
ALTER TABLE comments ADD CONSTRAINT comments_contract_fk
  FOREIGN KEY (contract_id, tenant_id, customer_id)
  REFERENCES contracts (id, tenant_id, customer_id) ON DELETE RESTRICT;
```

Il devient alors **physiquement impossible** d'attacher un objet à un contrat d'un autre scope : PostgreSQL rejette l'insertion. Ce motif est appliqué à `contract_versions`, `contract_signers`, `contract_approvals`, `signature_requests`, `comments`, `attachments`, `reminders`, `renewal_requests`, `cancellations`. Même schéma pour `signature_events → signature_requests`.

C'est un coût réel — index composites supplémentaires, migrations plus verbeuses. À 2 000 contrats (H2), ce coût est nul en pratique, et il achète une garantie que ni un développeur distrait ni un ORM mal configuré ne peuvent contourner.

### 8.5 Index

```sql
-- Chemins d'accès : TOUJOURS préfixés par le scope, car RLS filtre dessus d'abord
CREATE INDEX ON contracts (tenant_id, customer_id, status);
CREATE INDEX ON contracts (tenant_id, customer_id, end_date)
  WHERE status IN ('ACTIVE','SIGNED');          -- widget « échéances »
CREATE INDEX ON contracts (tenant_id, owner_user_id, status);
CREATE INDEX ON contracts (tenant_id, customer_id, archived_at);
CREATE UNIQUE INDEX ON contracts (tenant_id, reference);

-- Une seule branche d'avenant en cours (RM-19)
CREATE UNIQUE INDEX ON contracts (parent_contract_id)
  WHERE type = 'AMENDMENT'
    AND status NOT IN ('CANCELLED','DECLINED','TERMINATED','EXPIRED','RENEWED');

-- Le job de rappels : requête la plus fréquente de l'application
CREATE INDEX ON reminders (status, due_at) WHERE status = 'PENDING';
CREATE UNIQUE INDEX ON reminders (contract_id, kind, offset_days, cycle);

-- Résolution du scope d'un webhook (§11.4) — chemin critique
CREATE UNIQUE INDEX ON signature_requests (provider, provider_submission_id);
CREATE UNIQUE INDEX ON signature_events (provider_event_id);

-- Réconciliation (EC-06)
CREATE INDEX ON signature_requests (status, last_synced_at)
  WHERE status IN ('SENT','PARTIALLY_COMPLETED');

-- Audit
CREATE INDEX ON audit_logs (tenant_id, customer_id, occurred_at DESC);
CREATE INDEX ON audit_logs (tenant_id, resource_type, resource_id, occurred_at DESC);

-- Recherche plein texte (§9.3)
CREATE INDEX ON contracts USING GIN (search_vector);

-- Portefeuille : lu à chaque ouverture de session
CREATE INDEX ON customer_access (user_id);
```

Note sur l'index `reminders (status, due_at)` : il n'est **pas** préfixé par `tenant_id`, parce que le job scheduler balaie légitimement tous les tenants pour découvrir le travail à faire. C'est la seule requête de l'application qui s'exécute hors scope, et elle est confinée à un rôle base dédié en lecture seule sur deux colonnes (§12.3). Toute exception au cloisonnement doit être nommée, justifiée et bornée — celle-ci l'est.

---

## 9. Architecture technique

### 9.1 Vue d'ensemble

```
                    ┌─────────────────────────────────────┐
                    │  Navigateur (interne / portail)     │
                    └──────────────┬──────────────────────┘
                                   │ HTTPS, cookie de session
                    ┌──────────────▼──────────────────────┐
                    │  Next.js 15 (App Router, RSC)       │
                    │  BFF : proxy + rendu. AUCUNE        │
                    │  logique métier, AUCUN accès DB.    │
                    └──────────────┬──────────────────────┘
                                   │ HTTP interne (VPC)
                    ┌──────────────▼──────────────────────┐
                    │  NestJS API                         │
                    │  Guards → Contexte de scope         │
                    │  Services domaine (purs)            │
                    │  Repositories scopés                │
                    └───┬─────────┬─────────┬─────────────┘
                        │         │         │
              ┌─────────▼──┐  ┌───▼────┐  ┌─▼──────────┐
              │ PostgreSQL │  │ Redis  │  │ S3 (Paris) │
              │ 16 + RLS   │  │ BullMQ │  │ SSE-KMS    │
              │            │  │ session│  │            │
              └────────────┘  └───┬────┘  └────────────┘
                                  │
                    ┌─────────────▼───────────────────────┐
                    │  Worker NestJS (même code, sans HTTP)│
                    │  rappels · sync signature · PDF     │
                    └──────────────┬──────────────────────┘
                                   │
              ┌────────────────────▼─────────────────┐
              │  DocuSeal (auto-hébergé, VPC privé)  │
              │  + Gotenberg (rendu PDF)             │
              └──────────────────────────────────────┘
```

### 9.2 Décisions de stack

| Couche | Choix | Alternatives écartées | Justification |
|---|---|---|---|
| Frontend | Next.js 15 + TS + Tailwind + shadcn/ui | Vite SPA, Remix | RSC = pas de données non scopées dans un bundle client. shadcn = on possède le code des composants. |
| Backend | **NestJS séparé** | Next.js route handlers, Express | Voir ci-dessous — décision structurante. |
| Base | PostgreSQL 16 (RDS, eu-west-3) | MySQL, Mongo | **RLS**. Seul PostgreSQL offre le filtrage au niveau ligne dont dépend §10.3. Ce point à lui seul décide. |
| ORM | Prisma 5 + client extension | Drizzle, TypeORM | Voir ci-dessous. |
| Auth interne | OIDC Entra ID (H6) | mot de passe local | MSP sous M365 : MFA, offboarding et conditional access déjà en place. |
| Auth client | Magic link / OTP email | mot de passe | Nathalie se connecte 3×/an. Un mot de passe serait réinitialisé à chaque fois. |
| Session | **Cookie opaque + session serveur Redis** | JWT | Voir ci-dessous — décision de sécurité. |
| Jobs | BullMQ + Redis | pg-boss, Temporal | Suffisant, opéré simplement. Temporal = sur-dimensionné à cette volumétrie. |
| Stockage | S3 eu-west-3, SSE-KMS | disque, MinIO | Encryption context (§10.7). |
| Rendu PDF | **Gotenberg** (Chromium en conteneur) | Puppeteer intégré, LaTeX, react-pdf | Isole Chromium du process API. Un moteur de rendu est une surface d'attaque : on le met dans sa propre boîte. |
| Signature | DocuSeal auto-hébergé | Yousign, DocuSign | H4. Abstrait derrière `ESignatureProvider`. |
| Emails | Amazon SES | Postmark, Resend | Même région, même IAM. |
| Observabilité | OpenTelemetry + Grafana Cloud + Sentry | Datadog | Coût. |
| Déploiement | Docker → ECS Fargate, Terraform | Kubernetes | K8s pour 4 conteneurs, ce serait de la dette d'exploitation gratuite. |
| Monorepo | pnpm workspaces + Turborepo | polyrepo | Domaine partagé entre API et worker. |

#### Pourquoi NestJS séparé plutôt que Next.js full-stack

C'est le choix que je défends le plus fermement, et l'argument est entièrement lié à l'exigence non négociable.

Avec les route handlers Next.js, le scoping est une **convention** : chaque handler doit penser à appeler `getScope()`. Trente-cinq handlers, trente-cinq occasions d'oublier. L'oubli ne casse rien — il élargit silencieusement le périmètre. C'est le pire mode de défaillance possible : invisible, et exactement dans la direction de la fuite.

Avec NestJS, le scoping est une **structure** : un `APP_GUARD` global s'applique à toutes les routes, et la seule façon de s'y soustraire est un décorateur `@Public()` explicite, cherchable en revue et testable en CI. On passe d'un modèle « sécurisé si on n'oublie pas » à un modèle « sécurisé sauf si on désactive délibérément ». Pour une contrainte non négociable, c'est la seule posture tenable.

Bénéfice secondaire : le worker doit tourner en process séparé de toute façon. Avec NestJS, il partage le conteneur d'injection, les services et les repositories scopés — donc les mêmes garanties. Avec Next.js, le worker aurait été un second chemin d'accès aux données, avec ses propres règles à réimplémenter. Un second chemin, c'est une seconde chance de se tromper.

Coût assumé : deux déploiements, un contrat d'API à maintenir. Compensé par la génération de types depuis OpenAPI (§14.1).

#### Prisma malgré RLS

Prisma ne gère pas RLS nativement, ce qui est un vrai point faible ici. Drizzle serait plus transparent. Je retiens quand même Prisma pour ses migrations, son typage et sa maturité, **à condition** d'encapsuler l'accès dans une extension client qui rend l'appel non scopé impossible (§10.3). Sans cette extension, Prisma serait le mauvais choix : un `prisma.contract.findMany()` sur une connexion sans GUC positionné produirait une erreur PostgreSQL en développement — et c'est précisément ce que l'on veut, mais on ne veut pas le découvrir en production.

Le garde-fou : une règle ESLint interdit l'import du `PrismaClient` brut hors du module `persistence`, vérifiée en CI (§16.4).

#### Session serveur plutôt que JWT

Un JWT embarque le scope. Le scope change (EC-17 : un account manager perd un client). Un JWT valide 15 minutes, c'est 15 minutes d'accès à des données qu'on vient de lui retirer. On peut raccourcir la durée, ajouter une liste de révocation, consulter un cache à chaque requête — mais alors on a reconstruit une session serveur, en moins fiable.

À moins de 20 utilisateurs internes (H5), le seul argument en faveur du JWT — l'absence d'état — n'achète rien. Le cookie opaque + Redis donne la révocation immédiate et un scope toujours frais. Cookie `httpOnly`, `Secure`, `SameSite=Strict`, `__Host-` prefix.

### 9.3 Recherche

La recherche plein texte se fait dans PostgreSQL (`tsvector` généré, dictionnaire `french`, index GIN), pas dans Elasticsearch ou Meilisearch.

La raison est le cloisonnement, pas la volumétrie. Un moteur externe est un **second magasin de données** avec son propre modèle de sécurité : il faut y répliquer le scope, filtrer chaque requête, gérer la dérive d'index. Le jour où l'on oublie un filtre côté moteur, l'autocomplétion de la barre de recherche affiche les titres de contrats d'un autre client. C'est le contournement le plus facile de tout le dispositif RLS, et il ne coûterait qu'une ligne oubliée.

Dans PostgreSQL, la recherche est **soumise à RLS comme n'importe quelle autre requête**. La garantie est gratuite et automatique.

```sql
ALTER TABLE contracts ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('french', coalesce(reference,'')), 'A') ||
    setweight(to_tsvector('french', coalesce(title,'')), 'A')
  ) STORED;
```

À 2 000 contrats (H2), PostgreSQL répond en quelques millisecondes. Réévaluer au-delà de 100 000 — et seulement alors.

### 9.4 Environnements

| Env | Infra | Données |
|---|---|---|
| `local` | docker-compose : Postgres, Redis, DocuSeal, Gotenberg, MinIO, Mailpit | Jeu de démo (seed, ticket S-01) |
| `staging` | ECS, ressources réduites | Anonymisées |
| `production` | ECS multi-AZ, RDS avec PITR | Réelles |

Contrainte : **jamais de copie de production vers staging sans anonymisation**. Le script d'anonymisation fait partie du livrable, pas d'une bonne intention (phase 5, §17).

---

## 10. Architecture multi-tenant et cloisonnement

### 10.1 Comparaison des modèles

| Critère | Base partagée + `tenant_id` (+RLS) | Schéma par tenant | Base par tenant | Hybride (pool + silo) |
|---|---|---|---|---|
| **Isolation** | Bonne si RLS + `FORCE` + rôle non propriétaire. Faible si le filtrage est seulement applicatif. | Bonne. Erreur de `search_path` = fuite. | Maximale. Physique. | Variable |
| **Exploitation** | Simple : 1 base, 1 migration | Lourde : N schémas à migrer, échec partiel possible | Très lourde : N bases, N sauvegardes, N restaurations | La plus lourde : deux chemins à maintenir |
| **Coût (100 clients)** | ~1 RDS | ~1 RDS, connexions ↗ | ~100 instances ou N conteneurs | Élevé |
| **Maintenance** | 1 migration | N migrations, transactionnalité fragile | N migrations, dérive de schéma quasi inévitable | Double |
| **Scalabilité** | Excellente jusqu'à ~10⁷ lignes | Se dégrade > ~200 schémas (catalogue) | Linéaire mais coûteuse | Bonne |
| **Sécurité** | Dépend de RLS. Défaillance = fuite silencieuse. | Défaillance = fuite | Défaillance = indisponibilité, pas fuite | Mixte |
| **Audit** | Un journal, requêtable, chaînable | Éclaté | Très éclaté — audit transverse difficile | Éclaté |
| **Restauration ciblée** | Difficile (PITR = tout ou rien) | Moyenne | Facile | Moyenne |
| **RGPD / effacement** | Delete ciblé | Drop schema | Drop database | — |

Le critère décisif est souvent mal identifié. Ce n'est pas la sécurité en régime nominal — les trois modèles peuvent être sûrs. C'est le **mode de défaillance** :

- Base partagée : un bug de scope = **fuite silencieuse**. Grave, mais RLS transforme le bug applicatif en erreur SQL bruyante.
- Base par tenant : un bug de connexion = **indisponibilité**. Bruyant, non silencieux. C'est objectivement le meilleur mode de défaillance.

Ce qui plaide pour base-par-tenant… jusqu'à ce qu'on regarde H2 et le fait que **LSI n'a qu'un seul tenant**.

### 10.2 Recommandation

> **Base PostgreSQL unique partagée, avec `tenant_id` + `customer_id` sur chaque table métier, et Row-Level Security en `FORCE`, appliquée sur les deux dimensions.**

Justification pour ce contexte précis :

1. **H1 rend la question du multi-tenant partiellement théorique.** Il y a un tenant : LSI. Une « base par tenant » signifierait une base pour toute l'application. La vraie frontière est le **customer**, et personne ne provisionne 100 bases PostgreSQL pour 2 000 contrats.
2. **H2 tue tout argument de scalabilité.** 2 000 contrats, c'est une table que PostgreSQL garde en cache. La complexité opérationnelle du silo n'achèterait rigoureusement rien.
3. **Le tableau de bord de Marc est une exigence produit.** « Quel est mon récurrent total, quels contrats expirent ce trimestre » se répond par un `GROUP BY` sur une base partagée. En base-par-tenant, c'est un fan-out sur 100 connexions ou un entrepôt de données à construire. On paierait la complexité deux fois.
4. **L'audit transverse est une exigence explicite.** Un journal unique chaîné par hash est simple ici, et pénible à répartir.
5. **RLS déplace la garantie hors du code applicatif.** C'est ce qui rend la promesse crédible : même un `findMany` sans `where` ne peut pas franchir la frontière.
6. **`tenants` reste dans le modèle** pour la revente en marque blanche à d'autres MSP. Le coût aujourd'hui est de deux colonnes et deux prédicats. Le coût de l'ajouter après coup, sur une base peuplée, serait une migration à haut risque sur des données contractuelles. C'est l'une des rares options qu'il est rationnel d'acheter d'avance.

**Conditions non négociables sans lesquelles cette recommandation ne tient pas** :
- `FORCE ROW LEVEL SECURITY` sur toutes les tables métier
- rôle applicatif **non propriétaire** des tables et **sans** `BYPASSRLS`
- scope positionné par `SET LOCAL` dans chaque transaction, **échec par exception** si absent
- test CI qui refuse toute table métier sans RLS (§16.4)

Si l'une de ces quatre conditions saute, le modèle redevient « du filtrage applicatif avec des étapes en plus », ce que la demande rejette explicitement.

**Réévaluation** : au-delà de ~500 clients, ou à la première revente en marque blanche à un MSP concurrent (où l'isolation devient un argument commercial et non plus seulement technique), reconsidérer l'hybride — pool par défaut, silo pour les comptes qui l'exigent contractuellement.

### 10.3 Row-Level Security — mise en œuvre

**Rôles PostgreSQL**

```sql
CREATE ROLE lsi_owner  NOINHERIT;              -- propriétaire, migrations uniquement
CREATE ROLE lsi_app    LOGIN NOINHERIT;        -- application. PAS propriétaire. PAS de BYPASSRLS.
CREATE ROLE lsi_scheduler LOGIN NOINHERIT;     -- découverte des rappels (§8.5)
CREATE ROLE lsi_readonly  LOGIN NOINHERIT;     -- analytique, RLS active
```

`lsi_app` n'est pas propriétaire — sans quoi il contournerait RLS par défaut. `FORCE ROW LEVEL SECURITY` couvre le cas où l'on se tromperait quand même.

**Variables de session (GUC)**

| GUC | Contenu |
|---|---|
| `app.tenant_id` | uuid — toujours présent |
| `app.customer_ids` | uuid[] sérialisé — périmètre autorisé |
| `app.all_customers` | `'on'` si `MSP_ADMIN`/`LEGAL_REVIEWER` |
| `app.user_id` | uuid ou `'system'` |
| `app.actor_kind` | `INTERNAL`/`CLIENT`/`SYSTEM` |

**Politique type (tables de classe « customer »)**

```sql
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts FORCE ROW LEVEL SECURITY;   -- s'applique aussi au propriétaire

CREATE POLICY contracts_scope ON contracts
  USING (
    tenant_id = current_setting('app.tenant_id')::uuid
    AND (
      current_setting('app.all_customers', true) = 'on'
      OR customer_id = ANY (current_setting('app.customer_ids')::uuid[])
    )
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id')::uuid
    AND (
      current_setting('app.all_customers', true) = 'on'
      OR customer_id = ANY (current_setting('app.customer_ids')::uuid[])
    )
  );
```

Deux détails qui portent l'essentiel de la garantie :

- **Les prédicats refusent explicitement un scope absent**, via une fonction qui `RAISE EXCEPTION` (`ERRCODE = insufficient_privilege`). Une requête sans scope ne renvoie donc pas « zéro ligne » : elle **plante**. La différence est capitale — zéro ligne est un bug qui passe la revue et se réveille en production, une exception casse le test dès la première exécution.

  > **Correction issue du prototype (2026-07-16).** La version initiale de ce dossier reposait sur `current_setting('app.tenant_id')` **sans** `missing_ok`, en supposant que PostgreSQL lèverait si le GUC n'était pas positionné. C'est vrai sur une connexion **neuve** seulement. Dès qu'un `set_config(..., true)` a eu lieu, le GUC devient connu de la **session** ; après le commit il ne redevient pas « inconnu », il retombe à la **chaîne vide**. Sur une connexion recyclée du pool, l'échec provenait alors d'un cast (`''::uuid[]` → `22P02 malformed array literal`) — donc **par accident**, et non par décision. La garantie tenait, mais elle aurait disparu silencieusement au premier changement de type de colonne. Les prédicats lèvent désormais explicitement. Détecté par `tests/isolation/scope-enforcement.test.ts`, corrigé par la migration `00000000000003_fail_closed`.
- **`WITH CHECK` en plus de `USING`.** Sans lui, on peut lire son scope mais **écrire** dans celui d'un autre. Un `UPDATE contracts SET customer_id = <autre>` passerait. `WITH CHECK` l'interdit. Cet oubli est l'erreur classique des implémentations RLS.

**Tables de classe « tenant »** : même politique sans le prédicat customer.

**Politique renforcée pour `comments`** — traduction de RM-32 en base :

```sql
CREATE POLICY comments_client_shared_only ON comments
  FOR ALL TO lsi_app
  USING (
    tenant_id = current_setting('app.tenant_id')::uuid
    AND (current_setting('app.all_customers', true) = 'on'
         OR customer_id = ANY (current_setting('app.customer_ids')::uuid[]))
    -- un CLIENT ne VOIT jamais un commentaire INTERNAL (§6.10)
    AND (current_setting('app.actor_kind') <> 'CLIENT' OR visibility = 'SHARED')
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id')::uuid
    AND (current_setting('app.all_customers', true) = 'on'
         OR customer_id = ANY (current_setting('app.customer_ids')::uuid[]))
    -- et n'en ÉCRIT jamais un
    AND (current_setting('app.actor_kind') <> 'CLIENT' OR visibility = 'SHARED')
  );
```

Le risque de fuite le plus probable de l'application (§6.10) est ainsi traité en base, pas seulement par un `if` dans un service.

**Table `audit_logs` — append-only physique**

```sql
REVOKE UPDATE, DELETE ON audit_logs FROM lsi_app, lsi_owner;
GRANT INSERT, SELECT ON audit_logs TO lsi_app;
```
Un journal d'audit qu'un administrateur applicatif peut réécrire n'est pas un journal d'audit. Le droit est retiré au niveau du SGBD, y compris au propriétaire.

**Positionnement du scope — le seul chemin d'accès**

```ts
// packages/persistence/src/scoped-client.ts
export async function withScope<T>(
  scope: Scope,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // SET LOCAL : portée = la transaction. Compatible pgBouncer en mode transaction.
    await tx.$executeRaw`SELECT set_config('app.tenant_id',     ${scope.tenantId},        true)`;
    await tx.$executeRaw`SELECT set_config('app.customer_ids',  ${toPgArray(scope.customerIds)}, true)`;
    await tx.$executeRaw`SELECT set_config('app.all_customers', ${scope.allCustomers ? 'on' : 'off'}, true)`;
    await tx.$executeRaw`SELECT set_config('app.user_id',       ${scope.userId},          true)`;
    await tx.$executeRaw`SELECT set_config('app.actor_kind',    ${scope.actorKind},       true)`;
    return fn(tx);
  });
}
```

`set_config(..., true)` = portée transaction, remise à zéro au commit. Le GUC ne peut pas survivre à la transaction et polluer la requête suivante d'un autre utilisateur sur une connexion recyclée du pool — c'est le bug qui rendrait tout le dispositif inopérant, et c'est le `true` qui l'empêche.

**Interdiction structurelle du client non scopé**

```ts
// L'export d'un PrismaClient brut est INTERDIT hors de ce module.
// Règle ESLint no-restricted-imports + test CI (§16.4).
```

### 10.4 Résolution du scope

À l'ouverture de session, une fois et une seule :

```
Utilisateur authentifié
   ├── kind = INTERNAL
   │     ├── rôle MSP_ADMIN | LEGAL_REVIEWER
   │     │      → { tenantId, allCustomers: true,  customerIds: [] }
   │     └── rôle ACCOUNT_MANAGER | TECHNICIAN
   │            → { tenantId, allCustomers: false,
   │                customerIds: SELECT customer_id FROM customer_access WHERE user_id = ? }
   │
   └── kind = CLIENT
         → { tenantId, allCustomers: false, customerIds: [user.customer_id] }   // RM-31
            ^ TOUJOURS un singleton. Jamais alimenté depuis la requête.
```

Le scope est calculé côté serveur, stocké dans la session Redis, **jamais transmis par le client ni dérivé d'un paramètre de requête** (RM-29).

### 10.5 Cloisonnement, couche par couche

| Couche | Mécanisme | Mode de défaillance |
|---|---|---|
| **Authentification** | OIDC (interne) / magic link (client). `kind` immuable, `CHECK` en base (RM-32). | Compte hybride impossible |
| **Session** | Cookie opaque → Redis. Scope résolu au login. Révocation immédiate (EC-17). | Changement de droits effectif à la seconde |
| **RBAC** | `APP_GUARD` global NestJS. Opt-out par `@Public()` explicite, testé en CI. | Route non annotée = refusée par défaut |
| **API** | Aucun endpoint n'accepte `tenant_id`/`customer_id` en entrée (RM-29). Test CI sur les DTO. | Un champ de scope dans un DTO = build cassé |
| **Services métier** | Reçoivent un `Scope` en premier argument. Aucun service ne peut construire un scope. | Non compilable sans scope |
| **Persistance** | `withScope()` obligatoire. Client brut interdit par lint. | Exception SQL si scope absent |
| **Base** | RLS `FORCE`, `USING` + `WITH CHECK`, FK composites (§8.4) | Dernière ligne : refus SQL |
| **Stockage** | Préfixe d'objet + encryption context KMS (§10.7) | `AccessDenied` KMS |
| **DocuSeal** | `external_id` + résolution du scope par `provider_submission_id` (§11.4) | Webhook non rattaché = rejeté |
| **Logs** | `tenant_id`/`customer_id` injectés par le logger. Redaction des secrets. | — |
| **Notifications** | Destinataire résolu dans le scope. Jamais d'email issu du payload d'un job. | — |
| **Jobs** | Payload = `{tenantId, customerId, entityId}`. Le handler entre dans `withScope()` avant toute lecture. | Pas de scope ambiant |
| **Recherche** | PostgreSQL FTS, soumise à RLS (§9.3) | Aucun contournement possible |
| **Exports** | Générés par un job scopé. Fichier écrit sous le préfixe du scope. URL signée à durée courte. | — |
| **UX** | Bandeau client permanent, code couleur des commentaires, confirmations (§15.5) | Erreur humaine réduite |

**Défense en profondeur** : sept couches. Une seule est indispensable — RLS. Les six autres existent pour que la défaillance soit détectée **avant** d'atteindre la septième, et parce qu'une garantie unique est une garantie qu'on ne teste jamais.

### 10.6 Protection contre les IDOR

1. **UUIDv7 partout.** Aucun identifiant séquentiel exposé. Non énumérable.
2. **404, jamais 403** (RM-30). Avec RLS, c'est automatique : la ligne n'existe simplement pas pour cette session, `findUnique` renvoie `null`, le service lève `NotFoundError`. Le comportement sûr est le comportement par défaut — on n'a pas à y penser.
3. **Aucun identifiant de scope en entrée.** `GET /contracts/:id` — pas de `customerId` dans l'URL. L'appartenance est déduite, jamais déclarée.
4. **Page de signature non énumérable.** `/portal/sign/:signerToken` avec un jeton aléatoire à usage unique, jamais `/contracts/:id/sign` (recommandation explicite de la doc DocuSeal — voir §11.7).
5. **Test matriciel systématique** (§16.4) : pour chaque endpoint, un acteur du client A tente d'atteindre chaque ressource du client B → 404 attendu, sur **tous** les endpoints, sans exception.

### 10.7 Isolation du stockage documentaire

**Convention de clés**

```
s3://lsi-contrats-{env}/
  t/{tenant_id}/
    c/{customer_id}/
      contracts/{contract_id}/
        versions/{version_id}/draft.pdf
        signed/{signature_request_id}/document.pdf
        signed/{signature_request_id}/audit-trail.pdf
        attachments/{attachment_id}/{filename}
  exports/{tenant_id}/{user_id}/{export_id}.csv
```

Le scope est dans le chemin, ce qui rend les politiques IAM et les inventaires triviaux.

**Encryption context KMS — le point clé**

Une CMK par tenant. Chaque `PutObject`/`GetObject` passe un encryption context :

```json
{ "tenant_id": "...", "customer_id": "..." }
```

L'encryption context est **authentifié cryptographiquement** : il fait partie des données additionnelles du chiffrement AES-GCM. Un objet chiffré avec `customer_id = A` ne peut **pas** être déchiffré en présentant `customer_id = B` — KMS refuse, mathématiquement, pas par politique.

Conséquence : même si un bug applicatif construisait la mauvaise clé S3 et parvenait à lire l'octet chiffré d'un autre client, le déchiffrement échouerait. C'est une garantie qui survit à une erreur de code, ce qu'une politique de préfixe ne fait pas.

Et cela évite 100 CMK à 1 $/mois : une clé par tenant, l'isolation par client venant du contexte.

```json
{
  "Effect": "Allow",
  "Action": ["kms:Decrypt", "kms:GenerateDataKey"],
  "Resource": "arn:aws:kms:eu-west-3:...:key/...",
  "Condition": {
    "StringEquals": { "kms:EncryptionContext:tenant_id": "${aws:PrincipalTag/tenant_id}" }
  }
}
```

**Accès aux fichiers** : jamais de bucket public, jamais d'URL S3 directe en base. Toute lecture passe par `GET /v1/contracts/:id/versions/:vid/pdf` → le service vérifie le scope (RLS) → génère une URL présignée valable **5 minutes** → redirection 302. L'URL présignée est un secret porteur : sa durée de vie doit être de l'ordre du temps de téléchargement, pas de la session.

**Versioning S3 + Object Lock** en mode gouvernance sur le préfixe `signed/` : les PDF signés ne peuvent être ni écrasés ni supprimés avant expiration de la rétention, y compris par un administrateur AWS. La preuve doit survivre à l'erreur humaine et à la compromission d'un compte.

---

## 11. Intégration DocuSeal

### 11.1 Principe d'architecture

DocuSeal n'apparaît **nulle part** dans le domaine. Le domaine connaît une interface :

```ts
// packages/domain/src/signature/e-signature-provider.port.ts
export interface ESignatureProvider {
  readonly name: 'DOCUSEAL';
  createSubmission(cmd: CreateSubmissionCommand): Promise<ProviderSubmission>;
  getSubmission(providerSubmissionId: string): Promise<ProviderSubmission>;
  revokeSubmission(providerSubmissionId: string): Promise<void>;
  downloadDocuments(providerSubmissionId: string): Promise<ProviderDocument[]>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): WebhookVerification;
}
```

L'adaptateur `DocusealAdapter` vit dans `infrastructure/`. Aucun type DocuSeal ne traverse la frontière du domaine : ni `template_id`, ni `slug`, ni la forme du payload webhook. Le jour où LSI passe à Yousign — parce qu'un client grand compte exige une signature avancée eIDAS — on écrit un second adaptateur et le domaine ne bouge pas.

Corollaire : `signature_requests.provider` est une énumération dès le MVP, alors qu'il n'y a qu'une valeur. C'est deux caractères aujourd'hui contre une migration de données demain.

### 11.2 Génération du document à signer

```
Contrat APPROVED
   ↓
contract_versions.body_html (rendu depuis le modèle + variables)
   ↓
Gotenberg : HTML → PDF/A-2b       (conteneur isolé, pas de Chromium dans l'API)
   ↓
SHA-256 calculé et stocké → contract_versions.pdf_sha256
   ↓
S3 : t/{tenant}/c/{customer}/contracts/{id}/versions/{vid}/draft.pdf
   ↓
POST /submissions/pdf sur DocuSeal (le PDF, pas une URL)
```

Deux décisions :

**PDF/A-2b, pas PDF classique.** Format d'archivage normalisé : polices embarquées, pas de contenu externe. Un contrat qui ne s'affiche plus dans 8 ans n'est pas une preuve.

**Le hash est calculé avant l'envoi.** C'est ce qui permet d'affirmer plus tard « le document envoyé est exactement celui-ci ». Sans hash pré-envoi, on ne prouve que ce que DocuSeal veut bien nous dire.

On envoie le PDF par `POST /submissions/pdf` plutôt que de créer un template DocuSeal par contrat : chaque contrat est unique, un template par contrat polluerait DocuSeal de milliers d'objets à usage unique. Les templates DocuSeal restent réservés aux formulaires réellement récurrents.

### 11.3 Création de la demande de signature

```ts
const submission = await docuseal.createSubmission({
  template_id: templateId,
  send_email: true,
  order: 'preserved',              // RM-13 : LSI puis client
  expire_at: '2026-08-15 23:59:59 UTC',
  completed_redirect_url: `${PORTAL_URL}/portal/signature-complete`,
  message: {
    subject: `Contrat ${contract.reference} — signature requise`,
    body: 'Bonjour,\n\nVeuillez signer : {{submitter.link}}',
  },
  submitters: [
    {
      role: 'LSI Maintenance',
      email: 'direction@lsi-maintenance.fr',
      name: 'Marc D.',
      order: 0,
      external_id: signerLsiId,     // ← notre contract_signers.id
      metadata: { tenant_id, customer_id, contract_id, signature_request_id },
      fields: [
        { name: 'Référence', default_value: contract.reference, readonly: true },
        { name: 'Montant',   default_value: formatAmount(contract), readonly: true },
      ],
    },
    {
      role: 'Client',
      email: clientSigner.email,
      name: clientSigner.fullName,
      order: 1,
      external_id: signerClientId,
      require_email_2fa: true,      // §11.7
      metadata: { tenant_id, customer_id, contract_id, signature_request_id },
      fields: [
        { name: 'Référence', default_value: contract.reference, readonly: true },
      ],
    },
  ],
});
```

Points précis :

- **`readonly: true` est indispensable.** La doc DocuSeal est explicite : `default_value` seul est modifiable par le signataire depuis les devtools. Un montant contractuel pré-rempli mais éditable côté client serait une faille béante. L'immuabilité n'est garantie que si le champ est marqué readonly **côté serveur**.
- **`external_id`** porte notre `contract_signers.id`. C'est le point de rattachement pour rapprocher un submitter DocuSeal d'un signataire local.
- **`metadata`** porte le scope complet. Attention : cette metadata sert au **diagnostic**, jamais à l'autorisation. Voir §11.4.
- **`order: 'preserved'`** : le client ne reçoit son invitation qu'une fois LSI signataire. On ne demande jamais au client de signer un document que LSI n'a pas encore engagé.
- **`expire_at`** évite les demandes de signature zombies. Défaut : 30 jours.

### 11.4 Rattachement d'un webhook à son tenant — le point critique

Un webhook arrive **sans session**. C'est le seul endpoint de l'application où le scope ne peut pas venir d'un cookie. C'est donc là que se joue la sécurité de toute l'intégration.

**La règle absolue : le scope n'est JAMAIS lu dans le payload.**

Le payload contient bien `metadata.tenant_id` et `metadata.customer_id` (§11.3). C'est un piège. Ces valeurs viennent du réseau. Les utiliser pour décider du scope reviendrait à laisser un appelant externe choisir dans quel client écrire.

Le scope est **résolu depuis notre propre base** :

```ts
async handleWebhook(rawBody: Buffer, headers: Headers) {
  // 1. Vérification HMAC AVANT tout parsing (§11.7)
  const verification = provider.verifyWebhook(rawBody, headers);
  if (!verification.valid) throw new UnauthorizedException();

  const payload = JSON.parse(rawBody.toString());

  // 2. Idempotence — contrainte d'unicité en base, pas un `if` (EC-05)
  const eventId = buildEventId(payload);
  const inserted = await insertEventIfAbsent(eventId, payload);
  if (!inserted) return { status: 'duplicate_ignored' };

  // 3. RÉSOLUTION DU SCOPE DEPUIS NOTRE BASE — le cœur du dispositif
  const submissionId = String(payload.data.submission.id);
  const sigReq = await lookupByProviderSubmissionId('DOCUSEAL', submissionId);
  if (!sigReq) {
    logger.warn({ submissionId }, 'webhook orphelin — rejeté');
    return { status: 'unknown_submission' };   // 200 : pas de réessai inutile
  }

  // 4. Le scope vient de NOTRE ligne, pas du payload
  const scope = systemScope(sigReq.tenantId, sigReq.customerId);

  // 5. Contrôle de cohérence : divergence = incident de sécurité
  if (payload.data.metadata?.tenant_id &&
      payload.data.metadata.tenant_id !== sigReq.tenantId) {
    logger.error({ submissionId }, 'ALERTE : metadata webhook incohérente avec la base');
    await raiseSecurityAlert('webhook_scope_mismatch', { submissionId });
    return { status: 'rejected' };
  }

  // 6. Traitement dans le scope résolu
  await withScope(scope, (tx) => applySignatureEvent(tx, sigReq, payload));
}
```

L'étape 3 est la seule source de vérité. `signature_requests.provider_submission_id` est `UNIQUE` (§8.3) : elle mappe de façon déterministe une submission externe vers un couple (tenant, customer) que **nous** avons écrit au moment de la création. Un attaquant qui forgerait un payload avec un `metadata.tenant_id` arbitraire n'obtiendrait rien : soit sa submission n'existe pas chez nous (rejet), soit elle existe et le scope est celui que nous avons enregistré.

L'étape 5 n'est pas nécessaire à la sécurité — elle est une **sonde**. Si elle se déclenche un jour, c'est qu'il se passe quelque chose qui mérite un humain.

### 11.5 Événements et synchronisation d'état

| Événement DocuSeal | Effet local |
|---|---|
| `form.viewed` | `contract_signers.status = VIEWED` + `signature_events` |
| `form.started` | `signature_events` seulement |
| `form.completed` | `contract_signers.signed_at`. Si tous signés → `SIGNED` + téléchargement (§11.6). Sinon → `PARTIALLY_SIGNED` |
| `form.declined` | `contract_signers.status = DECLINED` + motif → contrat `DECLINED` (EC-10) |
| `submission.completed` | Confirmation globale — déclenche le téléchargement si `form.completed` a été perdu |
| `submission.expired` | `signature_requests.status = EXPIRED`, contrat revient `APPROVED`, notification |

Le rapprochement d'un submitter vers un signataire local se fait par `external_id` (notre `contract_signers.id`), avec repli sur `provider_submitter_id`. Jamais par email : deux signataires peuvent partager une adresse (assistante), et l'email est modifiable côté DocuSeal.

### 11.6 Récupération du document signé et des preuves

Dès `SIGNED`, un job **asynchrone** (jamais dans la requête webhook — DocuSeal réessaie en cas de timeout, et un timeout provoquerait un double traitement) :

```
1. GET /submissions/{id}/documents
2. Téléchargement du PDF combiné signé
3. Téléchargement de l'audit trail PDF (data.submission.audit_log_url)
4. SHA-256 des deux
5. S3 → signed/{signature_request_id}/{document,audit-trail}.pdf   (Object Lock actif)
6. signature_requests.signed_pdf_object_key / _sha256 / audit_trail_object_key
7. contracts.signed_at
8. audit_logs : contract.signed avec les deux hashes
```

**Le dossier de preuve**, constitué à ce moment et conservé 10 ans (RM-36) :

| Élément | Origine |
|---|---|
| PDF signé | DocuSeal |
| Audit trail DocuSeal (IP, UA, horodatages, consentement) | DocuSeal |
| SHA-256 du PDF pré-envoi | Nous (§11.2) |
| SHA-256 du PDF signé | Nous |
| `signature_events` bruts | Nous |
| Chaîne d'audit locale (hash chain) | Nous |
| Identité du signataire + preuve 2FA email | DocuSeal + nous |

Redondance délibérée : on ne dépend jamais de la disponibilité de DocuSeal pour produire une preuve. Un fournisseur peut disparaître ; l'obligation de preuve dure 10 ans.

**Horodatage qualifié (V2)** : un jeton RFC 3161 sur le hash du PDF signé, auprès d'une TSA qualifiée. C'est ce qui transforme « nous affirmons que ce document existait à cette date » en « un tiers de confiance l'atteste ». Hors MVP, mais la colonne `timestamp_token` est prévue au schéma.

### 11.7 Sécurité de l'intégration

| Risque | Mesure |
|---|---|
| Webhook forgé | HMAC vérifié sur le **corps brut** avant parsing. Comparaison à temps constant. Secret ≠ clé API. |
| Rejeu | `UNIQUE (provider_event_id)` (EC-05) |
| Écriture inter-client | Scope résolu en base, jamais dans le payload (§11.4) |
| Énumération des URL de signature | `/portal/sign/:token` avec jeton aléatoire — jamais `/contracts/:id/sign`. Recommandation explicite de la doc DocuSeal. |
| Signataire usurpé | `require_email_2fa: true` sur les signataires client |
| Falsification de valeurs | `readonly: true` côté serveur (§11.3) |
| Événements client forgés | Les callbacks JS de `<docuseal-form>` sont des **indices d'interface**. Aucune écriture ne s'y appuie — seuls les webhooks vérifiés font foi. Point explicitement souligné par la doc DocuSeal. |
| Fuite de la clé API | Secrets Manager, rotation trimestrielle. La clé API est **aussi** le secret de signature JWT : la divulguer compromet les deux. |
| Open redirect | `completed_redirect_url` construit côté serveur depuis une constante, jamais depuis une entrée. |
| DocuSeal exposé | Instance dans un sous-réseau **privé**. Aucune entrée publique hormis le chemin webhook via l'ALB, restreint par WAF. |

**À vérifier au déploiement** : le nom exact de l'en-tête de signature HMAC de l'instance DocuSeal auto-hébergée (et la présence du secret webhook dans sa configuration). La documentation consultée impose la vérification HMAC sans nommer l'en-tête. `DocusealAdapter.verifyWebhook()` isole ce détail : c'est le seul endroit à ajuster, et un test d'intégration contre l'instance réelle le validera (ticket W-04, phase 3). Je préfère le signaler que l'inventer.

### 11.8 Gestion des erreurs et reprise

| Incident | Traitement |
|---|---|
| DocuSeal HS à la création | `signature_requests.status = FAILED`, contrat reste `APPROVED` (EC-04). Message actionnable. Réessai manuel. |
| Timeout à la création | `idempotency_key` sur `signature_requests`. Avant tout réessai, `GET /submissions?external_id=` pour vérifier si la submission a été créée malgré le timeout. Sans cela : double envoi au client. |
| Webhook perdu (EC-06) | **Job de réconciliation horaire** : toute `signature_request` en `SENT`/`PARTIALLY_COMPLETED` non synchronisée depuis 1 h → `GET /submissions/{id}` → application du delta. Le webhook est une optimisation de latence, la réconciliation est le filet. |
| Webhook en erreur de traitement | DocuSeal réessaie en backoff exponentiel pendant 48 h. On répond 200 aux erreurs métier définitives (webhook orphelin) pour ne pas déclencher de réessais inutiles, et 5xx aux erreurs transitoires. |
| Téléchargement du signé en échec | Job avec 5 réessais en backoff. Alerte au-delà. Le contrat reste `SIGNED` — l'absence de PDF local est un incident d'exploitation, jamais une régression d'état métier. |
| DocuSeal perd un document | Le PDF pré-envoi et son hash sont chez nous (§11.2). Reconstruction possible. |

---

## 12. Notifications et scheduler

### 12.1 Matérialisation plutôt que calcul

Le choix structurant : les rappels sont **des lignes en base**, créées à l'activation du contrat, pas le résultat d'une requête `WHERE end_date - now() = 90` exécutée chaque nuit.

La différence n'est pas cosmétique.

| | Calculé à la volée | Matérialisé |
|---|---|---|
| Job en panne 3 j | Les rappels de ces 3 j **n'existent jamais** | Ils sont dus, ils partent en retard (RM-26) |
| Anti-doublon | Logique applicative fragile | `UNIQUE` en base (RM-24) |
| Traçabilité | « On aurait dû envoyer » | Ligne datée, statut, tentatives |
| Rappel obsolète | Invisible | `SKIPPED_OBSOLETE`, tracé (RM-25) |
| Test | Manipuler l'horloge | Insérer une ligne |
| Audit client | Impossible à produire | Requête directe |

Un contrat perdu parce qu'un cron a échoué pendant un week-end, c'est un revenu récurrent perdu — le problème n°1 identifié en §1. Le calcul à la volée ne survit pas à cette exigence.

### 12.2 Génération

À `SIGNED → ACTIVE` :

```ts
function planReminders(contract: Contract, now: Date): ReminderDraft[] {
  if (!contract.endDate) {                          // EC-13
    return contract.noticePeriodDays
      ? [draft('NOTICE_DEADLINE', contract.noticeDeadline())]
      : [];
  }
  return [90, 60, 30].map((offset) => {
    const dueAt = subDays(contract.endDate, offset);
    return {
      kind: 'EXPIRY',
      offsetDays: offset,
      cycle: contract.reminderCycle,
      dueAt,
      // RM-25 / EC-02 : on crée la ligne MÊME si elle est déjà dépassée.
      // Le silence n'est jamais une donnée : on veut pouvoir prouver
      // qu'un rappel n'est pas parti, et pourquoi.
      status: dueAt <= now ? 'SKIPPED_OBSOLETE' : 'PENDING',
    };
  });
}
```

Régénération après avenant (EC-12) : `cycle++`, les `PENDING` de l'ancien cycle passent `CANCELLED`, le nouveau cycle est planifié. La contrainte `UNIQUE (contract_id, kind, offset_days, cycle)` autorise la coexistence des cycles tout en interdisant le doublon dans un cycle donné.

### 12.3 Exécution

```
EventBridge cron (06:00 Europe/Paris)
   ↓
Job `reminders.scan`  — rôle base lsi_scheduler, HORS scope (exception §8.5)
   SELECT id, tenant_id, customer_id FROM reminders
   WHERE status = 'PENDING' AND due_at <= now()
   LIMIT 500 FOR UPDATE SKIP LOCKED
   ↓
Pour chaque : enqueue BullMQ `reminders.send`
   payload = { tenantId, customerId, reminderId }     ← scope explicite
   jobId   = `reminder:${reminderId}`                 ← idempotence BullMQ
   ↓
Worker `reminders.send`
   withScope(systemScope(tenantId, customerId), async (tx) => {
     // ↑ RETOUR DANS LE SCOPE. Tout le reste est protégé par RLS.
     ...
   })
```

`lsi_scheduler` est le seul rôle autorisé hors scope, et il est borné à `SELECT` sur trois colonnes de `reminders`. Il ne peut lire ni un contrat, ni un contenu, ni une adresse. Il découvre du travail et des identifiants de scope — rien d'autre. Une exception au cloisonnement doit être aussi étroite que sa raison d'être.

`FOR UPDATE SKIP LOCKED` autorise plusieurs workers sans double envoi. `jobId` déterministe : BullMQ déduplique même si le scan est rejoué.

### 12.4 Envoi

```
Worker, dans le scope :
  1. Charger le rappel + contrat (RLS garantit l'appartenance)
  2. Vérifier la pertinence :
       contrat ACTIVE ?           sinon → CANCELLED
       renouvellement en cours ?  → pas d'email client (RM-27)
       end_date modifiée ?        → CANCELLED (cycle obsolète)
  3. Résoudre les destinataires DANS LE SCOPE :
       interne : owner + MSP_ADMIN (+ escalade si J-30 sans renewal_request)
       client  : customer_contacts WHERE is_primary  — jamais une adresse du payload
  4. Créer les `notifications` avec
       dedup_key = `reminder:${reminderId}:${recipientUserId}:${channel}`
  5. Envoyer via SES
  6. reminder.status = SENT, sent_at, late = (now - due_at > 24h)
  7. audit_logs : reminder.sent
```

Étape 3, point important : les destinataires sont **résolus**, jamais transportés. Un payload de job qui contiendrait une adresse email serait un chemin d'écriture hors scope — un job corrompu, rejoué ou mal construit enverrait un contrat au mauvais destinataire. Le payload ne porte que des identifiants ; les données sensibles sont relues sous RLS.

### 12.5 Autres traitements planifiés

| Job | Fréquence | Rôle |
|---|---|---|
| `reminders.scan` | 06:00 quotidien | Rappels dus |
| `contracts.activate` | 00:30 quotidien | `SIGNED` → `ACTIVE` (RM-06) |
| `contracts.expire` | 00:30 quotidien | `ACTIVE` → `EXPIRED` / `RENEWED` (RM-07) |
| `signatures.reconcile` | horaire | Filet anti-webhook perdu (EC-06) |
| `signatures.expire` | quotidien | Submissions dépassant `expire_at` |
| `attachments.scan` | à l'upload | Antivirus |
| `audit.verify_chain` | hebdomadaire | Vérification de la chaîne de hash (§13.4) |
| `drafts.purge` | mensuel | Brouillons inactifs > 12 mois (RM-35) |
| `retention.purge` | mensuel | Rétention 10 ans (RM-36) |

Chaque job scoppé suit le même motif : découverte hors scope minimale → traitement dans `withScope()`. Le motif est implémenté **une fois** dans une classe de base `ScopedJob`, et les handlers ne peuvent pas y déroger : ils reçoivent un `tx` déjà scopé et n'ont jamais accès au client Prisma brut. On ne demande pas aux développeurs de se souvenir de la règle — on leur retire la possibilité de l'enfreindre.

### 12.6 Files et cloisonnement

Une seule file BullMQ par type de job, **pas une file par tenant**. À un tenant et 2 000 contrats (H1, H2), une file par tenant serait de la complexité sans contrepartie : Redis n'isole rien qu'un scope de payload n'isole déjà.

L'isolation vient de trois propriétés du handler, pas de la topologie :
1. le payload ne porte que des identifiants de scope ;
2. le handler entre dans `withScope()` avant toute lecture ;
3. RLS s'applique exactement comme en HTTP.

À réévaluer si un tenant tiers apparaît (marque blanche) : la file partagée deviendrait alors un canal de contention entre clients — un problème de qualité de service, pas de sécurité.

---

## 13. Sécurité et conformité

### 13.1 Authentification

| Population | Mécanisme |
|---|---|
| Interne | OIDC Entra ID (H6). MFA délégué à M365. Pas de mot de passe local. Offboarding M365 = perte d'accès immédiate. |
| Client | Magic link : jeton aléatoire 32 o, usage unique, TTL 15 min, haché en base (un vol de la table ne donne aucun lien utilisable). |
| Repli interne | Argon2id + TOTP obligatoire, si H6 est fausse. |
| Système | IAM de tâche ECS. Aucun secret longue durée. |

Session : cookie `__Host-lsi_sess`, `httpOnly`, `Secure`, `SameSite=Strict`, opaque, TTL glissant 8 h (interne) / 30 min (client). Rotation de l'identifiant à chaque élévation de privilège.

Limitation de débit : 5 magic links / adresse / heure, 10 tentatives de connexion / IP / minute, 100 req/min/session côté API.

### 13.2 Autorisation

Trois contrôles indépendants sur chaque requête :

1. **Rôle** — `@RequiresRole(...)` sur le handler, guard global
2. **Scope** — RLS (§10.3)
3. **État** — la machine à états du domaine (§7.2)

Ils sont orthogonaux et doivent le rester. Un `MSP_ADMIN` a le rôle pour envoyer en signature, le scope sur tous les clients, mais ne peut pas envoyer un contrat en `DRAFT` : le contrôle d'état le refuse. Trois questions distinctes — qui, sur quoi, dans quel état — trois réponses distinctes. Les mélanger produit les bugs d'autorisation les plus difficiles à voir.

### 13.3 Protections web

| Vecteur | Mesure |
|---|---|
| **XSS** | Le corps des contrats est du HTML **rédigé par LSI** — donc dangereux par nature. Assainissement DOMPurify côté serveur avec une liste blanche stricte à l'écriture **et** à l'affichage. CSP `script-src 'self'` sans `unsafe-inline`, avec nonce. |
| **XSS dans le PDF** | Gotenberg tourne sans réseau (`--disable-network`) : une balise `<script>` ou une image externe injectée dans un corps de contrat ne peut ni exfiltrer ni charger. |
| **CSRF** | `SameSite=Strict` + double-submit token sur les mutations. Le webhook DocuSeal est exempté (pas de cookie) mais protégé par HMAC. |
| **IDOR** | §10.6 |
| **SQLi** | Requêtes paramétrées Prisma. `$queryRawUnsafe` interdit par lint. |
| **SSRF** | Aucune URL fournie par l'utilisateur n'est appelée côté serveur. Egress restreint par security group. |
| **Upload** | Type MIME vérifié par contenu (magic bytes), pas par extension. Max 25 Mo. ClamAV avant mise à disposition. Servis en `Content-Disposition: attachment` depuis un domaine distinct — un HTML malveillant uploadé ne s'exécute pas dans l'origine de l'application. |
| **Clickjacking** | `frame-ancestors 'none'` |
| **En-têtes** | HSTS preload, `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` restrictive |
| **Énumération de comptes** | Réponse et délai identiques que l'adresse existe ou non |

### 13.4 Journal d'audit

**Cloisonné** : `audit_logs` porte `tenant_id` + `customer_id`, RLS active. Un account manager consultant l'audit ne voit que ses clients.

**Inaltérable** : `UPDATE`/`DELETE` révoqués au niveau SGBD, y compris pour le propriétaire (§10.3).

**Chaîné** :

```
hash_n = SHA256(prev_hash || tenant_id || occurred_at || actor || action || resource || before || after)
```

Une entrée supprimée ou modifiée casse la chaîne. Le job hebdomadaire `audit.verify_chain` la vérifie et alerte. La chaîne ne rend pas la falsification impossible — elle la rend **détectable**, ce qui est l'objectif réel d'une piste d'audit. Le hash de tête est archivé quotidiennement dans un compte AWS séparé, en écriture seule : un attaquant qui compromettrait la base et recalculerait toute la chaîne serait démasqué par la divergence avec les têtes archivées.

**Événements journalisés** : toute mutation métier, toute transition d'état, tout accès en lecture à un document signé, toute connexion (réussie ou non), toute modification de `customer_access`, tout événement de signature, tout envoi de notification, toute action `SYSTEM`, tout export.

**Point d'attention** : les lectures de contrat ne sont **pas** journalisées, sauf pour les documents signés. Journaliser chaque `GET` produirait des millions de lignes dont personne ne se servirait, et noierait les événements qui comptent. Un journal que personne ne lit n'est pas un contrôle.

### 13.5 Chiffrement et secrets

| Donnée | En transit | Au repos |
|---|---|---|
| App ↔ DB | TLS 1.3, `verify-full` | RDS chiffré, CMK dédiée |
| App ↔ S3 | TLS 1.3 | SSE-KMS + encryption context (§10.7) |
| App ↔ DocuSeal | TLS, VPC privé | Volume EBS chiffré |
| Sessions | TLS | Redis chiffré, TLS in-transit |
| Sauvegardes | — | Chiffrées, CMK distincte, compte séparé |

Secrets : AWS Secrets Manager, injection à l'exécution, jamais de secret en variable d'environnement dans une image ni dans le dépôt. Rotation : clé API DocuSeal et secret webhook trimestriels, identifiants base annuels. Détection de fuite : gitleaks en pre-commit **et** en CI — le pre-commit se contourne, la CI non.

### 13.6 RGPD

| Sujet | Traitement |
|---|---|
| **Rôle** | LSI est **responsable de traitement** pour ses contrats. Ses clients sont des tiers contractants, pas des sous-traitants. |
| **Base légale** | Exécution du contrat (art. 6.1.b) pour les signataires. Obligation légale (art. 6.1.c) pour la conservation. |
| **Données personnelles** | Nom, email, téléphone, fonction des contacts et signataires. IP et UA dans les preuves de signature. |
| **Minimisation** | Aucune donnée sensible au sens de l'art. 9. Pas de date de naissance, pas de pièce d'identité. |
| **Durées** | Contrats + preuves : 10 ans après fin (prescription commerciale + marge). Brouillons non soumis : 12 mois. Journaux techniques : 12 mois. Piste d'audit : 10 ans. Sessions : 8 h. |
| **Droit d'accès** | Export JSON par personne, scopé, via `/v1/admin/gdpr/export`. |
| **Droit à l'effacement** | **Limité** (RM-37). Un contrat signé ne s'efface pas : obligation légale et intérêt légitime de LSI en cas de litige. On pseudonymise les contacts **non probants** (téléphone, fonction, contacts hors signataires) et on conserve les éléments de preuve. Cet arbitrage est documenté au registre et communiqué à la personne. |
| **Sous-traitants** | AWS (hébergement). SES (emails). DocuSeal auto-hébergé n'est **pas** un sous-traitant — c'est du logiciel sur notre infra. Argument H4 : c'est précisément ce qui rend ce point simple. |
| **Transferts hors UE** | **Voir §19-R1.** Région `eu-west-3` (Paris), mais AWS est une entreprise américaine soumise au CLOUD Act. AIPD requise, DPA + CCT signés, chiffrement KMS avec clés gérées par LSI. Ce risque est réel et documenté, pas éludé. |
| **Registre** | Tenu par LSI. Une fiche par traitement. |
| **Violation** | Procédure de notification CNIL sous 72 h. La détection est outillée : alerte `webhook_scope_mismatch`, chaîne d'audit, tests anti-fuite en CI. |

### 13.7 Valeur juridique de la signature

DocuSeal produit une **signature électronique simple (SES)** au sens du règlement eIDAS (H7). Points à assumer explicitement :

- Elle est **recevable** en justice : eIDAS art. 25.1 interdit d'écarter une signature électronique au seul motif de sa forme.
- Mais la **charge de la preuve pèse sur LSI**. Contrairement à la signature qualifiée, il n'y a pas de présomption de fiabilité. En cas de contestation, c'est à LSI de démontrer l'intégrité du document et l'identité du signataire.
- D'où le dossier de preuve de §11.6, le 2FA email, l'horodatage et la chaîne d'audit. Chacun de ces éléments existe pour supporter cette charge.

Pour des contrats de maintenance informatique de PME (quelques milliers d'euros par an), la SES est le standard du marché et le rapport coût/risque est bon. Pour un engagement à fort enjeu, il faudrait une signature avancée avec vérification d'identité — d'où l'abstraction `ESignatureProvider` (§11.1) qui laisse la porte ouverte.

**Cette analyse doit être validée par le conseil juridique de LSI. Elle est une position technique argumentée, pas un avis juridique.**

---

## 14. API

### 14.1 Conventions

- Base : `/v1`. Version dans le chemin.
- REST orienté ressources, avec des **sous-ressources d'action** pour les transitions d'état (`POST /contracts/:id/submit`). Un `PATCH {status: 'APPROVED'}` serait une erreur de conception : les transitions ne sont pas des affectations de champ, elles ont des gardes, des effets de bord et des acteurs distincts. L'URL doit dire l'intention.
- `snake_case` en JSON, `camelCase` en TypeScript, conversion à la frontière.
- Dates ISO 8601 UTC. Montants en **centimes entiers**.
- Pagination par curseur (`?cursor=&limit=`), défaut 25, max 100. L'offset dérive quand les données bougent, et une liste de contrats bouge.
- OpenAPI 3.1 généré depuis les DTO. Le client TypeScript du frontend est **généré**, jamais écrit à la main.
- `Idempotency-Key` sur toutes les mutations non idempotentes.

**Aucun endpoint n'accepte `tenant_id` ni `customer_id` en entrée** (RM-29). `customer_id` apparaît dans les **réponses** et comme **filtre de liste** (`?customer_id=` — qui restreint dans le scope, mais ne peut jamais l'élargir : le filtre est intersecté avec le scope de session, jamais substitué à lui). Un test CI inspecte les DTO d'entrée et échoue si un champ de scope y apparaît (§16.4).

### 14.2 Codes de réponse

| Code | Usage |
|---|---|
| 200 / 201 / 202 | Succès / création / accepté (job) |
| 204 | Suppression |
| 400 | Corps invalide |
| 401 | Non authentifié |
| 403 | Authentifié, rôle insuffisant — **jamais pour un problème de scope** |
| **404** | Inexistant **ou hors scope** (RM-30) — indiscernable, délibérément |
| 409 | Conflit : transition invalide, verrou optimiste (EC-16) |
| 410 | Magic link expiré |
| 422 | Règle métier violée |
| 429 | Débit dépassé |
| 500 / 502 | Erreur interne / provider indisponible |

Le 403 est réservé au rôle. Le scope produit un 404. Cette distinction n'est pas cosmétique : si le scope produisait un 403, `GET /v1/contracts/{uuid}` deviendrait un oracle permettant de tester l'existence d'un contrat chez un concurrent.

### 14.3 Format d'erreur (RFC 9457)

```json
{
  "type": "https://api.lsi.fr/errors/invalid-transition",
  "title": "Transition d'état invalide",
  "status": 409,
  "detail": "Un contrat en statut DRAFT ne peut pas être envoyé en signature. Il doit d'abord être approuvé.",
  "instance": "/v1/contracts/0192f8.../send",
  "code": "CONTRACT_INVALID_TRANSITION",
  "current_status": "DRAFT",
  "allowed_transitions": ["IN_REVIEW", "CANCELLED"],
  "request_id": "01JQ8X..."
}
```

`allowed_transitions` permet à l'interface de désactiver les mauvais boutons sans recoder la machine à états côté client. Le domaine reste la seule source de vérité.

### 14.4 Endpoints

#### Création de contrat

```http
POST /v1/contracts
Idempotency-Key: 01JQ8X...

{
  "customer_id": "0192f8a1-...",          // ← FILTRE, PAS SCOPE : doit être DANS le scope, sinon 404
  "title": "Contrat de maintenance 2026",
  "type": "MAIN",
  "category": "MAINTENANCE",
  "template_version_id": "0192f8b2-...",  // null = from scratch
  "variables": { "nb_postes": 42, "sla": "4h", "montant_mensuel": 129000 },
  "start_date": "2026-09-01",
  "end_date": "2027-08-31",
  "notice_period_days": 90,
  "amount_cents": 1548000,
  "currency": "EUR",
  "billing_frequency": "MONTHLY"
}
```

`customer_id` est ici légitime : il désigne **pour quel client** on crée le contrat. Mais il ne définit pas le scope — il est **vérifié contre** lui. Si le client n'appartient pas au périmètre de la session, RLS ne trouve pas la ligne `customers` et l'API répond 404. On ne peut pas créer un contrat chez un client qu'on ne voit pas.

```http
201 Created
Location: /v1/contracts/0192f8c3-...

{ "id": "0192f8c3-...", "reference": "LSI-2026-0042", "status": "DRAFT",
  "current_version": { "id": "...", "version_number": 1 }, ... }
```

#### Récupération / liste

```http
GET /v1/contracts/{id}          → 200 | 404 (inexistant OU hors scope)

GET /v1/contracts?status=ACTIVE&customer_id=...&expiring_within_days=90
                 &owner_user_id=me&q=maintenance&sort=-end_date&limit=25&cursor=...
```

```json
{
  "data": [{
    "id": "0192f8c3-...", "reference": "LSI-2026-0042",
    "title": "Contrat de maintenance 2026", "status": "ACTIVE",
    "customer": { "id": "0192f8a1-...", "name": "Dupont SAS" },
    "end_date": "2027-08-31",
    "days_until_expiry": 411,           // dérivé — RM-02
    "is_expiring_soon": false,          // dérivé, jamais stocké
    "amount_cents": 1548000, "currency": "EUR",
    "signature_progress": { "signed": 2, "total": 2 }
  }],
  "pagination": { "next_cursor": "01JQ...", "has_more": true }
}
```

#### Nouvelle version

```http
POST /v1/contracts/{id}/versions
If-Match: "3"                            // verrou optimiste — EC-16

{ "body_html": "<h1>...</h1>", "variables": {...}, "change_summary": "Ajout clause RGPD" }

201 | 409 Conflict (version obsolète) | 422 (contrat non éditable — RM-04)
```

#### Transitions

```http
POST /v1/contracts/{id}/submit      { "note": "..." }              → IN_REVIEW
POST /v1/contracts/{id}/approve     { "note": "..." }              → APPROVED  (403 si RM-10 violée)
POST /v1/contracts/{id}/request-changes { "reason": "..." }        → CHANGES_REQUESTED
POST /v1/contracts/{id}/cancel      { "reason": "..." }            → CANCELLED
POST /v1/contracts/{id}/terminate   { "reason": "...", "effective_date": "...", "override_reason": null }
POST /v1/contracts/{id}/renew       { "start_date": "...", "end_date": "..." }  → 201 nouveau contrat
POST /v1/contracts/{id}/amend       { "title": "..." }                          → 201 avenant
```

#### Envoi en signature

```http
POST /v1/contracts/{id}/send-for-signature
Idempotency-Key: 01JQ8Y...

{
  "signers": [
    { "party": "LSI",    "user_id": "...",    "signing_order": 0 },
    { "party": "CLIENT", "contact_id": "...", "signing_order": 1, "require_email_2fa": true }
  ],
  "expire_at": "2026-08-15T23:59:59Z",
  "message": { "subject": "...", "body": "..." }
}

202 Accepted
{ "signature_request_id": "...", "status": "CREATING" }
```

202, pas 201 : la création chez DocuSeal est asynchrone. Le contrat ne passe `PENDING_SIGNATURE` qu'après acquittement du provider (EC-04). Répondre 201 ferait mentir l'API sur un état qui n'existe pas encore.

Réponse en cas d'échec provider :
```json
502 { "type": ".../provider-unavailable", "code": "SIGNATURE_PROVIDER_ERROR",
      "detail": "Le service de signature est indisponible. Le contrat reste approuvé, vous pouvez réessayer.",
      "retryable": true }
```

#### Webhook DocuSeal

```http
POST /v1/webhooks/docuseal          // @Public() — pas de session (§11.4)
X-Docuseal-Signature: <hmac>        // ← nom à confirmer au déploiement (§11.7)

{ "event_type": "form.completed", "timestamp": "...", "data": { ... } }

200 { "status": "processed" | "duplicate_ignored" | "unknown_submission" }
401 signature HMAC invalide
```

Toujours 200 sur une erreur métier définitive (submission inconnue) : DocuSeal réessaie 48 h sur les 4xx/5xx, et faire réessayer un événement définitivement non traitable est du bruit. 5xx réservé aux échecs transitoires, où le réessai est utile.

#### Rappels

```http
GET  /v1/reminders?status=PENDING&due_before=2026-09-01
GET  /v1/contracts/{id}/reminders
POST /v1/reminders/{id}/send-now      → 202  (forçage manuel, audité)
POST /v1/reminders/{id}/dismiss       { "reason": "..." }
```

#### Commentaires

```http
POST /v1/contracts/{id}/comments

{ "body": "Le client demande un SLA 2h.",
  "visibility": "INTERNAL",            // ← DÉFAUT si omis (§6.10)
  "parent_comment_id": null }

201 | 403 (un CLIENT tentant INTERNAL — refusé en service ET par RLS §10.3)
```

#### Upload

```http
POST /v1/contracts/{id}/attachments        # multipart, max 25 Mo
{ "file": <binary>, "visibility": "INTERNAL" }
201 { "id": "...", "virus_scan_status": "PENDING", "download_url": null }
```

`download_url` reste `null` tant que l'antivirus n'a pas rendu `CLEAN`. Un fichier non scanné n'est pas téléchargeable — l'état par défaut est le refus.

```http
GET /v1/contracts/{id}/attachments/{aid}/download
302 → URL S3 présignée, TTL 5 min (§10.7)
```

#### Documents signés

```http
GET /v1/contracts/{id}/signed-document       → 302, audité (§13.4)
GET /v1/contracts/{id}/audit-trail           → 302, audité
GET /v1/contracts/{id}/evidence-package      → 202, job → ZIP (§11.6)
```

### 14.5 API du portail client

Namespace **distinct**, `/v1/portal/*`, servi par un module NestJS séparé avec son propre guard.

```http
GET  /v1/portal/contracts                        // uniquement son customer (RM-31)
GET  /v1/portal/contracts/{id}
GET  /v1/portal/contracts/{id}/signed-document
POST /v1/portal/contracts/{id}/comments          // visibility forcée à SHARED, non négociable
GET  /v1/portal/sign/{token}                     // → embed DocuSeal
```

Deux espaces d'API séparés plutôt qu'un seul avec des conditions de rôle. C'est plus de code, et c'est le but : un endpoint interne ne peut pas être atteint par erreur depuis une session client, parce qu'il n'est pas monté dans le même module. Le portail n'expose que ce qu'il déclare — un ajout de fonctionnalité côté interne n'élargit jamais la surface côté client par effet de bord. La séparation physique est plus fiable qu'un `if (user.kind === 'CLIENT')` répété quarante fois.

---

## 15. UX / Écrans

### 15.1 Principes

Application métier, pas vitrine. Sylvie y passe deux heures par jour : la densité d'information prime sur l'élégance, la prévisibilité prime sur l'originalité. Sobre, dense, rapide, sans animation gratuite. Raccourcis clavier sur les actions fréquentes. Responsive utile — les tableaux fonctionnent sur un écran de bureau, les écrans de **consultation et de signature** fonctionnent sur mobile parce que Marc valide dans le train et Nathalie signe depuis son téléphone. On ne cherche pas à rendre l'éditeur de contrat utilisable sur mobile : personne ne rédige un contrat sur un téléphone.

### 15.2 Arborescence

```
INTERNE  (/)
├── /dashboard
├── /contracts
│   ├── /new
│   └── /:id            ├── (aperçu + timeline + signature + commentaires)
│                       ├── /edit  /versions  /versions/compare
│                       ├── /send  /renew  /amend  /terminate
├── /reviews                        (file du juriste — badge de compteur)
├── /signatures                     (suivi transverse)
├── /reminders
├── /customers  →  /:id  →  /contacts
├── /templates  →  /:id  →  /versions/:v
├── /archive
├── /audit                          (MSP_ADMIN, LEGAL_REVIEWER)
└── /settings   →  /users  /access  /notifications  /integrations

PORTAIL CLIENT  (/portal)
├── /login
├── /contracts  →  /:id
└── /sign/:token
```

### 15.3 Wireframes

#### Tableau de bord

```
┌────────────────────────────────────────────────────────────────────────┐
│ LSI Contrats    [🔍 Rechercher…  ⌘K]              Sylvie M. ▾  🔔 3    │
├──────────┬─────────────────────────────────────────────────────────────┤
│          │  Tableau de bord                                            │
│ ▸Tableau │                                                             │
│  Contrats│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  Revues 2│  │    47    │ │    8     │ │    3     │ │  184 k€  │        │
│  Signat. │  │ Actifs   │ │ Échéance │ │ À signer │ │ Récurrent│        │
│  Rappels │  │          │ │ < 90 j ⚠ │ │          │ │ annuel   │        │
│  Clients │  └──────────┘ └──────────┘ └──────────┘ └──────────┘        │
│  Modèles │                                                             │
│  Archive │  Échéances à venir                          [Tout voir →]   │
│  Audit   │  ┌───────────────────────────────────────────────────────┐  │
│ ─────────│  │ ⚠ J-12  Dupont SAS    LSI-2025-0031  12 000 €  [Renou]│  │
│ Réglages │  │ ⚠ J-28  Martin SARL   LSI-2025-0044   8 400 €  [Renou]│  │
│          │  │ ● J-57  Bernard SA    LSI-2025-0052  24 000 €  [Renou]│  │
│          │  │ ● J-84  Legrand SAS   LSI-2025-0061  15 600 €  [Renou]│  │
│          │  └───────────────────────────────────────────────────────┘  │
│          │                                                             │
│          │  En attente de signature                                    │
│          │  ┌───────────────────────────────────────────────────────┐  │
│          │  │ Petit SARL   LSI-2026-0002  Envoyé il y a 6 j  [Relan]│  │
│          │  │  ├ ✓ LSI Maintenance    signé le 10/07                 │  │
│          │  │  └ ○ N. Petit           ouvert le 12/07, non signé     │  │
│          │  └───────────────────────────────────────────────────────┘  │
│          │                                                             │
│          │  Mes revues (2)                                             │
│          │  ┌───────────────────────────────────────────────────────┐  │
│          │  │ Roux SAS  LSI-2026-0003  soumis par M. Dubois  [Ouvrir]│ │
│          │  └───────────────────────────────────────────────────────┘  │
└──────────┴─────────────────────────────────────────────────────────────┘
```

Les compteurs respectent le scope (§6.1). Sylvie voit « 47 actifs » sur *son* portefeuille — pas un total global qui divulguerait le volume d'activité des autres account managers.

#### Détail d'un contrat

```
┌────────────────────────────────────────────────────────────────────────┐
│ ← Contrats /  LSI-2026-0042                                            │
│                                                                        │
│ Contrat de maintenance 2026          ┌──────────────────────────────┐  │
│ 🏢 Dupont SAS · Sylvie M.            │ ● ACTIF                      │  │
│                                      │ 01/09/26 → 31/08/27          │  │
│ [Avenant] [Renouveler] [Résilier] ⋯  │ Expire dans 411 j            │  │
│                                      │ 1 290 €/mois · 15 480 €/an   │  │
│ ┌─ Aperçu ─ Versions(3) ─ Pièces(2) ─ Journal ────────────────────┐   │
│ │                                                                  │   │
│ │  ┌─ Document ──────────────────┐  ┌─ Signature ───────────────┐  │   │
│ │  │                             │  │ ✓ Signé le 28/08/2026     │  │   │
│ │  │  [aperçu PDF v3]            │  │                           │  │   │
│ │  │                             │  │ ✓ M. Durand (LSI)         │  │   │
│ │  │                             │  │   28/08 09:12             │  │   │
│ │  │                             │  │ ✓ J. Dupont (Dupont SAS)  │  │   │
│ │  │  [⬇ PDF signé]              │  │   28/08 14:33             │  │   │
│ │  │  [⬇ Piste d'audit]          │  │                           │  │   │
│ │  │  [⬇ Dossier de preuve]      │  │ [Voir les preuves]        │  │   │
│ │  └─────────────────────────────┘  └───────────────────────────┘  │   │
│ │                                                                  │   │
│ │  ┌─ Échéances ─────────────────────────────────────────────────┐ │   │
│ │  │ ○ J-90  03/06/2027   interne                                │ │   │
│ │  │ ○ J-60  02/07/2027   interne + client                       │ │   │
│ │  │ ○ J-30  01/08/2027   interne + client + escalade            │ │   │
│ │  └─────────────────────────────────────────────────────────────┘ │   │
│ └──────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│ ┌─ Échanges ───────────────────────────────────────────────────────┐   │
│ │ [🔒 Interne (4)] [👥 Partagé avec le client (1)]                 │   │
│ │                                                                  │   │
│ │ 🔒 ZONE INTERNE — invisible du client              (fond ambre)  │   │
│ │ ┌──────────────────────────────────────────────────────────────┐ │   │
│ │ │ M. Dubois · 10/07                                            │ │   │
│ │ │ Marge à 32 %, on peut descendre à 28 % si blocage.           │ │   │
│ │ └──────────────────────────────────────────────────────────────┘ │   │
│ │                                                                  │   │
│ │ [Écrire…]           Visibilité : (•) 🔒 Interne  ( ) 👥 Client  │   │
│ └──────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

Le fond ambre sur la zone interne est un choix délibéré, pas de la décoration : c'est la protection contre la fuite la plus probable de l'application (§6.10). Le message ci-dessus est exactement le type de contenu qui ne doit jamais arriver chez le client. La distinction doit être visible sans la lire.

#### Assistant d'envoi en signature

```
┌────────────────────────────────────────────────────────────────────────┐
│ Envoyer en signature — LSI-2026-0042                            [✕]    │
│                                                                        │
│  ①  Signataires  ───  ②  Message  ───  ③  Vérification                 │
│                                                                        │
│  Côté LSI Maintenance                                                  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ 1. [M. Durand — Gérant                  ▾]  direction@lsi…    ✕  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  Côté Dupont SAS                                                       │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ 2. [J. Dupont — Président               ▾]  j.dupont@dupont…  ✕  │  │
│  │    ☑ Vérification par code email avant accès au document         │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  [+ Ajouter un signataire]                                             │
│                                                                        │
│  Ordre : (•) LSI puis client (recommandé)   ( ) Simultané              │
│  Expiration de la demande : [30 jours ▾]                               │
│                                                                        │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ ⚠ Après envoi, le contrat ne sera plus modifiable.             │    │
│  │   Toute évolution devra passer par un avenant.                 │    │
│  └────────────────────────────────────────────────────────────────┘    │
│                                                    [Annuler] [Suivant] │
└────────────────────────────────────────────────────────────────────────┘
```

L'avertissement est à l'étape 1, pas à la dernière : on prévient avant l'effort, pas au moment de l'irréversible.

#### Portail client

```
┌────────────────────────────────────────────────────────────────────────┐
│  LSI Maintenance                              Dupont SAS · J. Dupont ▾ │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Vos contrats                                                          │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ ⚡ SIGNATURE REQUISE                                              │  │
│  │ Contrat de maintenance 2026 — LSI-2026-0042                      │  │
│  │ 1 290 €/mois · 01/09/26 → 31/08/27                                │  │
│  │                                        [Lire et signer →]         │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ ● ACTIF   Contrat de maintenance 2025 — LSI-2025-0031            │  │
│  │ 1 000 €/mois · jusqu'au 31/08/26      [Consulter] [⬇ PDF signé]  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ ○ EXPIRÉ  Contrat de maintenance 2024 — LSI-2024-0018            │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

Le portail n'a **pas** de sélecteur de client. Il n'y a rien à sélectionner : la session est épinglée (RM-31). L'absence de ce contrôle est une propriété de sécurité — un sélecteur impliquerait un endpoint de bascule, donc une surface d'attaque.

### 15.4 Composants récurrents

| Composant | Rôle |
|---|---|
| `<StatusBadge>` | Couleur + libellé par statut. Une seule implémentation, alimentée par l'enum du domaine. |
| `<ContractTable>` | Tri, filtres, colonnes configurables, sélection multiple, pagination curseur |
| `<Timeline>` | Journal d'activité normalisé |
| `<SignatureProgress>` | Progression par signataire |
| `<VisibilityToggle>` | Interne / Partagé, avec avertissement — composant de sécurité |
| `<CustomerBadge>` | Nom du client, omniprésent |
| `<ConfirmDialog>` | Confirmation ; saisie du nom du client pour les actions irréversibles |
| `<EmptyState>` | Vide utile, avec action |
| `<DiffViewer>` | Comparaison de versions |

### 15.5 Protections UX contre les erreurs de périmètre

Le cloisonnement technique empêche l'accès non autorisé. Il n'empêche pas Sylvie, qui a légitimement accès à 30 clients, d'envoyer le contrat de Dupont à Martin. C'est une **erreur humaine dans le périmètre autorisé** — RLS n'y peut rien, et c'est probablement l'incident le plus probable de toute l'application.

| Mesure | Détail |
|---|---|
| **Client omniprésent** | Nom du client dans l'en-tête de chaque écran contractuel. Jamais une page où l'on ignore chez qui l'on est. |
| **Couleur d'accent par client** | Dérivée du hash du `customer_id`. Fine bande colorée en haut. Le cerveau détecte le changement de couleur avant de lire le nom — c'est ce qui déclenche le doute au bon moment. |
| **Confirmation nommée** | Envoi en signature, résiliation : saisir le nom du client pour confirmer. Friction volontaire, proportionnée à l'irréversibilité. |
| **Récapitulatif d'envoi** | Étape 3 : nom du client et adresses des destinataires en gras, taille supérieure. |
| **Pas de bascule de client silencieuse** | Changer de client = navigation explicite. Aucun sélecteur global qui reconfigurerait la page en place. |
| **Zone interne colorée** | §15.3 |
| **Bandeau d'impersonation** | Si un support technique consulte au nom d'un autre (V2) : bandeau rouge permanent, session limitée à 30 min, audit renforcé. |

---

## 16. Stratégie de tests

### 16.1 Pyramide

| Niveau | Périmètre | Outil | Cible |
|---|---|---|---|
| Unitaires | Machine à états, calcul de rappels, règles métier. **Sans base.** | Vitest | > 90 % sur `domain/` |
| Intégration | Repositories + RLS + services, **base réelle** | Vitest + Testcontainers | Tous les chemins critiques |
| Contrat | Adaptateur DocuSeal contre un simulateur | Vitest + MSW | Tous les appels provider |
| E2E | Parcours complets | Playwright | 8 parcours |
| **Anti-fuite** | **Cloisonnement** | Vitest + Testcontainers | **Exhaustif — §16.4** |
| Sécurité | SAST, dépendances, secrets | CodeQL, Snyk, gitleaks | CI |
| Charge | Endpoints de liste, job de rappels | k6 | Ciblé |

Le domaine est testable **sans base ni HTTP** — c'est le bénéfice concret de l'architecture en couches. Si tester une transition d'état exige de démarrer PostgreSQL, c'est que la logique métier a fui dans la persistance.

### 16.2 Tests unitaires — exemples

```
✓ DRAFT → IN_REVIEW échoue sans signataire client (RM-12)
✓ IN_REVIEW → APPROVED échoue si approbateur == soumettant (RM-10)
✓ APPROVED → PENDING_SIGNATURE échoue si version modifiée depuis validation (RM-11)
✓ SIGNED → toute édition rejetée (RM-05)
✓ EXPIRED → RENEWED autorisé (renouvellement rétroactif, §7.2 note 2)
✓ CANCELLED → toute transition rejetée (état terminal)
✓ planReminders : end_date à J+45 → 90 et 60 en SKIPPED_OBSOLETE, 30 en PENDING (EC-02)
✓ planReminders : end_date null sans préavis → aucun rappel (EC-13)
✓ planReminders : end_date null avec préavis → 1 rappel NOTICE_DEADLINE
✓ planReminders : régénération après avenant → cycle++, anciens CANCELLED (EC-12)
✓ terminate : date d'effet < préavis → rejet sauf override MSP_ADMIN (RM-20)
✓ amend : deuxième avenant en cours → rejet (RM-19)
```

### 16.3 Tests d'intégration — exemples

```
✓ withScope positionne les GUC et les libère au commit
✓ Requête HORS withScope → exception PostgreSQL (PAS zéro ligne)   ← test clé
✓ INSERT avec un customer_id hors scope → violation WITH CHECK
✓ UPDATE déplaçant un contrat vers un autre customer → rejeté
✓ FK composite : comment(customer=A) sur contract(customer=B) → violation FK (§8.4)
✓ UPDATE sur audit_logs → permission denied
✓ DELETE sur contract_versions → permission denied
✓ Webhook rejoué → un seul signature_event (EC-05)
✓ Webhook orphelin → 200 unknown_submission, aucune écriture
✓ Webhook dont metadata.tenant_id ≠ base → rejeté + alerte (§11.4)
✓ Timeout création DocuSeal + retry → une seule submission (idempotency)
✓ Réconciliation : webhook perdu → statut rattrapé (EC-06)
✓ Job reminders.send : payload correct mais contrat d'un autre client → RLS bloque
```

### 16.4 Tests anti-fuite inter-tenant

Le cœur du dispositif. Quatre familles, chacune répondant à un mode de défaillance distinct.

#### A. Test structurel — le plus important

```ts
// Échoue dès qu'un développeur ajoute une table métier sans RLS.
// Aucune revue humaine ne peut garantir cela dans la durée.
test('toute table métier a RLS + FORCE + une politique', async () => {
  const tables = await sql`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname NOT IN ('_prisma_migrations', 'tenants')`;

  for (const t of tables) {
    expect(t.relrowsecurity,      `${t.relname} : RLS désactivée`).toBe(true);
    expect(t.relforcerowsecurity, `${t.relname} : FORCE manquant`).toBe(true);
    expect(Number(t.policies),    `${t.relname} : aucune politique`).toBeGreaterThan(0);
  }
});

test('toute table métier porte tenant_id et customer_id', async () => { /* RM-28 */ });

test('lsi_app n’est ni propriétaire ni BYPASSRLS', async () => {
  const [r] = await sql`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'lsi_app'`;
  expect(r.rolbypassrls).toBe(false);
});

test('lsi_app n’a ni UPDATE ni DELETE sur audit_logs', async () => { /* §13.4 */ });
```

Ces tests-là valent plus que tous les autres réunis : ils rendent le cloisonnement **impossible à oublier**. Une nouvelle table sans RLS casse la CI le jour même, pas six mois plus tard en production.

#### B. Test matriciel — chaque endpoint, chaque paire

```ts
// Généré depuis l'OpenAPI : un endpoint ajouté est AUTOMATIQUEMENT couvert.
// Un test écrit à la main serait oublié pour le 36e endpoint.
describe.each(allEndpointsFromOpenApi())('IDOR : %s', (endpoint) => {
  test('acteur du client A → ressource du client B = 404', async () => {
    const { actorA, resourceB } = await seedTwoCustomers();
    const res = await call(endpoint, { as: actorA, id: resourceB.id });
    expect(res.status).toBe(404);      // RM-30 : 404, jamais 403
    expect(res.body).not.toContain(resourceB.title);
  });
});
```

#### C. Tests de scénarios de fuite

```
✓ Session client A + UUID de contrat du client B          → 404
✓ Account manager hors portefeuille → contrat de ce client → 404
✓ Client → GET /v1/contracts (API interne)                 → 404 (route non montée)
✓ Client → commentaire INTERNAL du client A                → invisible (RLS §10.3)
✓ Client → POST comment visibility=INTERNAL                → 403
✓ Recherche « Dupont » par un AM sans Dupont au portefeuille → 0 résultat, aucune fuite de titre
✓ Export CSV → uniquement les lignes du scope
✓ Notifications : un job du client A ne notifie jamais un utilisateur du client B
✓ URL S3 présignée du client A + session du client B       → 404 avant même S3
✓ Objet S3 du client A déchiffré avec le contexte du client B → KMS AccessDenied (§10.7)
✓ Compte hybride INTERNAL+CLIENT                           → violation CHECK (RM-32)
✓ Retrait d'un client du portefeuille → accès perdu à la requête suivante (EC-17)
✓ GUC résiduel : deux withScope successifs sur la même connexion poolée → pas de fuite
```

Le dernier mérite attention : c'est le test qui valide `set_config(..., true)` (§10.3). Sans la portée transactionnelle, une connexion recyclée du pool conserverait le scope de l'utilisateur précédent, et l'utilisateur suivant lirait ses données. Ce serait la fuite la plus grave possible, et la plus silencieuse — elle ne se manifesterait que sous charge, en production, de façon intermittente.

#### D. Analyse statique

```
✓ Aucun import de PrismaClient hors de packages/persistence
✓ Aucun DTO d'entrée ne contient tenant_id ou customer_id  (RM-29)
✓ Toute route a un guard OU un @Public() explicite
✓ Aucun $queryRawUnsafe
✓ Toute méthode de service exportée prend Scope en 1er argument
```

Ces règles ESLint personnalisées sont bloquantes en CI. C'est de l'automatisation de revue de code : le jour où un développeur pressé oublie, la machine s'en souvient.

### 16.5 E2E (Playwright)

```
1. Créer depuis modèle → valider → envoyer → signer (DocuSeal réel en Docker) → actif
2. Refus du juriste → correction → nouvelle soumission → validation
3. Renouvellement complet depuis un rappel J-30
4. Avenant sur contrat actif → signature → report sur le parent
5. Résiliation avec préavis non respecté → blocage → override admin
6. Annulation après envoi → révocation DocuSeal
7. Portail client : magic link → consultation → signature
8. Isolation : deux navigateurs, deux clients, aucune donnée croisée
```

Le n°1 tourne contre une **vraie instance DocuSeal** en Docker, pas contre un simulateur. Un simulateur teste notre compréhension de DocuSeal, pas DocuSeal. C'est précisément là que se cachent les surprises — dont le nom de l'en-tête HMAC (§11.7).

### 16.6 Tests de charge (k6)

Ciblés, pas exhaustifs. À cette volumétrie, le risque n'est pas le débit :

```
✓ GET /v1/contracts, 2 000 contrats, 20 utilisateurs simultanés → p95 < 300 ms
✓ reminders.scan avec 2 000 rappels dus → < 30 s
✓ RLS : surcoût du prédicat customer_ids avec 100 UUID dans le GUC   ← à mesurer
✓ Génération PDF : 10 simultanées → pas d'épuisement de Gotenberg
```

La troisième ligne est la seule qui m'inquiète réellement : `customer_id = ANY(current_setting(...)::uuid[])` est réévalué par ligne. À 100 UUID et 2 000 lignes, c'est négligeable. À 10 000 clients, il faudrait basculer sur une table temporaire ou une jointure. Mesurer plutôt que supposer — et c'est la première limite que ce design rencontrera.

---

## 17. Plan d'implémentation

### Phase 0 — Cadrage (1 semaine)

- **Objectifs** : valider ce dossier, confirmer les hypothèses, arbitrer §18.
- **Dépendances** : disponibilité de Sylvie et Marc.
- **Livrables** : dossier validé, maquettes des 4 écrans majeurs, décision sur R1 (Cloud Act), validation juridique de §13.7.
- **Risques** : arbitrage juridique long → paralléliser avec la phase 1.
- **Acceptation** : hypothèses H1–H12 confirmées ou corrigées ; questions ouvertes tranchées.

### Phase 1 — Socle technique (3 semaines)

- **Objectifs** : le squelette avec le cloisonnement **prouvé**, avant toute fonctionnalité.
- **Dépendances** : phase 0.
- **Livrables** : monorepo ; docker-compose ; schéma Prisma complet ; migrations RLS ; `withScope()` ; guards ; auth OIDC + magic link ; audit log chaîné ; CI ; **suite anti-fuite §16.4 verte** ; Terraform staging.
- **Risques** : RLS + Prisma est le point technique le plus délicat → à prototyper en jour 1, pas en semaine 3.
- **Acceptation** :
  - `pnpm test:isolation` vert
  - une requête hors `withScope()` lève une exception
  - une table sans RLS casse la CI
  - un utilisateur se connecte et voit son scope
  - l'audit log est inaltérable, chaîne vérifiée

**Aucune fonctionnalité métier en phase 1.** C'est délibéré et c'est le pari central du plan : le cloisonnement est une propriété d'architecture. Ajouté après, il exige de revisiter chaque ligne écrite entre-temps. Ajouté avant, il est gratuit pour tout ce qui suit. Trois semaines sans démo visible, c'est un coût politique réel — mais c'est le seul ordre qui tienne la contrainte non négociable.

### Phase 2 — Contrats et modèles (4 semaines)

- **Objectifs** : CRUD, versions, modèles, génération PDF.
- **Dépendances** : phase 1.
- **Livrables** : clients + contacts ; bibliothèque de modèles ; éditeur ; versions immuables ; Gotenberg → PDF/A ; liste + recherche FTS ; tableau de bord v1.
- **Risques** : l'éditeur HTML est un puits sans fond → périmètre gelé (texte riche + variables, rien d'autre).
- **Acceptation** : créer un contrat depuis un modèle en < 3 min ; PDF conforme ; versions immuables en base ; recherche scopée prouvée.

### Phase 3 — Workflow et signature (4 semaines)

- **Objectifs** : le cycle complet jusqu'à `ACTIVE`.
- **Dépendances** : phase 2 ; DocuSeal déployé.
- **Livrables** : machine à états ; validation interne ; `DocusealAdapter` ; webhooks + idempotence ; réconciliation ; dossier de preuve ; suivi des signatures ; timeline.
- **Risques** : dépendance à un système tiers → **le simulateur DocuSeal est un livrable de phase 3**, pas un outil de test bricolé plus tard.
- **Acceptation** : parcours E2E complet contre DocuSeal réel ; webhook rejoué = un seul événement ; webhook perdu rattrapé par réconciliation ; scope d'un webhook résolu depuis la base ; PDF signé + audit trail stockés avec hash.

### Phase 4 — Rappels et notifications (2 semaines)

- **Objectifs** : rendre l'expiration silencieuse impossible.
- **Dépendances** : phase 3.
- **Livrables** : matérialisation ; scan + envoi ; jobs `activate`/`expire` ; notifications in-app + SES ; écran rappels ; renouvellements et avenants ; résiliations.
- **Risques** : délivrabilité email → SPF/DKIM/DMARC dès le début.
- **Acceptation** : 90/60/30 partent une seule fois ; scheduler arrêté 48 h → rappels partent en retard, marqués `late` ; échéance < 90 j → `SKIPPED_OBSOLETE` tracé ; avenant → régénération.

### Phase 5 — Portail client et finalisation (3 semaines)

- **Objectifs** : livrer.
- **Dépendances** : phase 4.
- **Livrables** : portail ; magic link ; signature embarquée ; commentaires partagés ; exports ; RGPD ; observabilité ; runbooks ; **test d'intrusion** ; reprise de l'existant ; formation.
- **Risques** : le pentest peut révéler du structurel → le planifier en semaine 1 de la phase 5, pas la veille de la mise en production.
- **Acceptation** : pentest sans faille critique ni majeure ; parcours client < 5 min sur mobile ; export RGPD fonctionnel ; runbooks écrits ; Sylvie autonome.

**Total : 17 semaines** (~4 mois) pour deux développeurs. Marge non incluse : compter 20 semaines.

---

## 18. Backlog MVP

### Épopée 1 — Socle (phase 1)

| # | User story | Critères d'acceptation |
|---|---|---|
| S-01 | En tant que dev, je veux un monorepo et docker-compose pour démarrer en une commande | `docker compose up` + `pnpm dev` → app, API, DB, Redis, DocuSeal, Gotenberg, MinIO, Mailpit ; README suffisant pour un nouvel arrivant |
| S-02 | En tant qu'architecte, je veux le schéma Prisma complet avec scope | Toutes les tables de §8 ; `tenant_id`+`customer_id` partout ; FK composites (§8.4) ; migration passante |
| S-03 | En tant qu'architecte, je veux RLS active et forcée | Toutes tables `ENABLE`+`FORCE` ; `USING`+`WITH CHECK` ; `lsi_app` non propriétaire, non BYPASSRLS ; **test structurel §16.4-A vert** |
| S-04 | En tant que dev, je veux `withScope()` comme seul chemin d'accès | GUC transactionnels ; requête hors scope → exception ; lint interdit Prisma brut ; test de non-fuite de GUC entre transactions |
| S-05 | En tant qu'employé LSI, je veux me connecter via M365 | OIDC ; scope résolu au login ; session Redis ; cookie `__Host-`, `SameSite=Strict` |
| S-06 | En tant que client, je veux me connecter par lien email | Magic link haché, usage unique, TTL 15 min ; session épinglée à un customer (RM-31) ; 410 si expiré |
| S-07 | En tant qu'admin, je veux un journal d'audit inaltérable | Chaîne de hash ; `UPDATE`/`DELETE` révoqués ; job de vérification ; scopé |
| S-08 | En tant qu'architecte, je veux la suite anti-fuite en CI | §16.4 A+B+C+D verts ; bloquants ; test matriciel généré depuis l'OpenAPI |

### Épopée 2 — Contrats (phase 2)

| # | User story | Critères d'acceptation |
|---|---|---|
| C-01 | En tant qu'AM, je veux gérer les clients de mon portefeuille | CRUD ; SIREN unique ; un client hors portefeuille → 404 ; suppression bloquée si contrats signés (EC-14) |
| C-02 | En tant qu'admin, je veux une bibliothèque de modèles versionnés | CRUD ; publication fige la version ; modèle déprécié non instanciable ; variables décrites en JSON Schema |
| C-03 | En tant qu'AM, je veux créer un contrat depuis un modèle | Sélection limitée à mon portefeuille ; variables validées ; v1 créée ; `template_version_id` figé ; référence auto |
| C-04 | En tant qu'AM, je veux créer un contrat from scratch | Même objet, sans modèle |
| C-05 | En tant qu'AM, je veux éditer un brouillon | Édition en `DRAFT`/`CHANGES_REQUESTED` uniquement ; nouvelle version ; `409` si conflit (EC-16) |
| C-06 | En tant qu'utilisateur, je veux comparer deux versions | Diff lisible ; versions immuables ; « restaurer » crée une nouvelle version |
| C-07 | En tant qu'utilisateur, je veux prévisualiser le PDF | Même chaîne de rendu que le final ; PDF/A-2b ; < 5 s |
| C-08 | En tant qu'utilisateur, je veux chercher un contrat | FTS français ; facettes ; **scopée** ; p95 < 300 ms |
| C-09 | En tant que Sylvie, je veux un tableau de bord | 4 compteurs scopés ; échéances < 90 j ; en attente de signature ; mes revues |

### Épopée 3 — Workflow et signature (phase 3)

| # | User story | Critères d'acceptation |
|---|---|---|
| W-01 | En tant qu'AM, je veux soumettre à validation | Gardes §7.3 ; pièces obligatoires vérifiées (EC-11) ; version figée ; juristes notifiés |
| W-02 | En tant que juriste, je veux valider ou demander des modifications | RM-10 vérifiée en base ; motif obligatoire ; validation liée à une version (RM-11) |
| W-03 | En tant qu'AM, je veux envoyer en signature | Depuis `APPROVED` seulement (RM-09) ; ≥1 signataire par partie ; `PENDING_SIGNATURE` uniquement après acquittement (EC-04) ; échec → reste `APPROVED` |
| W-04 | En tant que système, je veux traiter les webhooks | HMAC vérifié sur corps brut ; idempotence en base (EC-05) ; **scope résolu depuis la base** (§11.4) ; orphelin → 200 ; divergence → alerte |
| W-05 | En tant que système, je veux récupérer le signé et les preuves | Job asynchrone ; PDF + audit trail ; SHA-256 ; Object Lock ; audit |
| W-06 | En tant que système, je veux rattraper un webhook perdu | Réconciliation horaire (EC-06) ; delta appliqué ; idempotent |
| W-07 | En tant qu'AM, je veux suivre la progression | Par signataire, horodaté ; relance ; révocation |
| W-08 | En tant que signataire, je veux signer | 2FA email ; URL non énumérable ; embed DocuSeal ; mobile OK |
| W-09 | En tant que système, je veux gérer refus et expiration | `form.declined` → `DECLINED` + motif (EC-10) ; `expire_at` dépassé → `APPROVED` + notification |
| W-10 | En tant qu'utilisateur, je veux la timeline | Chronologie complète, lisible, scopée |
| W-11 | En tant qu'utilisateur, je veux commenter | Défaut `INTERNAL` ; `INTERNAL`→`SHARED` irréversible avec confirmation ; client ne voit ni n'écrit d'`INTERNAL` (RLS) |

### Épopée 4 — Rappels et cycle de vie (phase 4)

| # | User story | Critères d'acceptation |
|---|---|---|
| R-01 | En tant que système, je veux matérialiser les rappels | À `ACTIVE` : 3 lignes ; `UNIQUE` anti-doublon ; déjà dus → `SKIPPED_OBSOLETE` (EC-02) ; pas d'`end_date` → préavis ou rien (EC-13) |
| R-02 | En tant que système, je veux envoyer les rappels | Scan 06:00 ; `SKIP LOCKED` ; `jobId` déterministe ; destinataires résolus dans le scope ; `late` si > 24 h (EC-15) |
| R-03 | En tant que Sylvie, je veux être prévenue à J-90/60/30 | J-90 interne ; J-60 +client ; J-30 +escalade (RM-27) ; in-app + email |
| R-04 | En tant que système, je veux activer et expirer automatiquement | `SIGNED`→`ACTIVE` à `start_date` ; `ACTIVE`→`EXPIRED` à J+1 ; `RENEWED` si successeur signé |
| R-05 | En tant qu'AM, je veux renouveler | Pré-rempli ; `predecessor_contract_id` ; refus → parent expire normalement (EC-08) ; **aucune reconduction tacite** (RM-21) |
| R-06 | En tant qu'AM, je veux créer un avenant | Contrat lié (RM-17) ; un seul en cours (RM-19) ; à la signature → report + régénération des rappels (EC-12) |
| R-07 | En tant qu'AM, je veux résilier | Motif + date ; préavis calculé ; override admin tracé (RM-20) ; rappels annulés |
| R-08 | En tant qu'AM, je veux annuler avant signature | Impossible après `SIGNED` (RM-22) ; révocation DocuSeal (EC-09) ; signatures existantes conservées |

### Épopée 5 — Portail et finalisation (phase 5)

| # | User story | Critères d'acceptation |
|---|---|---|
| P-01 | En tant que client, je veux voir mes contrats | Uniquement mon customer ; pas de sélecteur ; mobile |
| P-02 | En tant que client, je veux télécharger mon PDF signé | URL présignée 5 min ; accès audité |
| P-03 | En tant que client, je veux échanger avec LSI | `SHARED` forcé ; jamais d'`INTERNAL` visible |
| P-04 | En tant qu'AM, je veux exporter mon portefeuille | CSV/XLSX ; scopé ; job asynchrone ; audité |
| P-05 | En tant qu'admin, je veux traiter une demande RGPD | Export JSON ; pseudonymisation partielle (RM-37) ; contrat signé préservé ; tracé |
| P-06 | En tant qu'exploitant, je veux de l'observabilité | Traces OTel avec `tenant_id`/`customer_id` ; alertes ; tableau de bord ; runbooks |
| P-07 | En tant que RSSI, je veux un pentest | Aucune faille critique ni majeure ; **cloisonnement testé explicitement** ; rapport archivé |

### Hors MVP — V2

Espace de négociation client · signature avancée eIDAS · horodatage RFC 3161 · impersonation support · connecteur comptable · rapports avancés · modèles par client · workflow d'approbation multi-niveaux · application mobile · marque blanche multi-MSP · IA d'analyse de clauses.

L'ordre n'est pas arbitraire : la V2 commence par ce qui manquera le plus vite (négociation, signature avancée), pas par ce qui démontre le mieux.

---

## 19. Risques et points de vigilance

| # | Risque | P | I | Mitigation |
|---|---|---|---|---|
| **R1** | **Cloud Act.** AWS eu-west-3 est en France, mais AWS est une société américaine : les autorités US peuvent exiger des données. Argument commercial retourné contre LSI par un concurrent souverain, ou point bloquant chez un client sensible. | M | **É** | AIPD documentée ; CCT + DPA ; chiffrement KMS avec clés LSI ; **décision consciente à acter en phase 0**. Alternative Scaleway/OVH chiffrable à 3-4 semaines si le sujet devient bloquant. Le design n'a aucune dépendance à un service AWS propriétaire hormis KMS et SES, tous deux substituables. |
| **R2** | ~~**Prisma + RLS**. Pas de support natif.~~ **LEVÉ** — prototype validé le 2026-07-16 : `withScope()` fonctionne, une requête hors scope lève, 19 tests d'isolation verts. Repli Drizzle inutile. | — | — | Reste à surveiller : le lint interdisant le client brut n'est pas encore écrit (ticket S-04). |
| **R3** | **Erreur humaine de périmètre** — Sylvie envoie le contrat de Dupont à Martin. RLS n'y peut rien : c'est dans son scope. | **É** | É | §15.5 : couleur par client, confirmation nommée, récapitulatif. **Le risque résiduel le plus élevé de l'application** : aucune mesure technique ne le supprime, seulement des frictions bien placées. |
| **R4** | **Fuite via commentaire interne** passé en partagé. | M | É | Défaut `INTERNAL` ; RLS (§10.3) ; irréversibilité avec confirmation ; zone colorée. |
| **R5** | **DocuSeal auto-hébergé** : c'est LSI qui l'exploite. Panne = signatures bloquées. | M | É | Sauvegardes ; runbook ; supervision ; abstraction `ESignatureProvider` ; réconciliation. Les PDF et hash pré-envoi sont chez nous. |
| **R6** | **En-tête HMAC DocuSeal non confirmé** (§11.7). | É | F | Isolé dans `verifyWebhook()` ; test d'intégration contre l'instance réelle en phase 3. Signalé plutôt qu'inventé. |
| **R7** | **Valeur juridique SES** contestée en litige. | F | **É** | §13.7 ; dossier de preuve ; 2FA ; **validation par le conseil juridique en phase 0** ; horodatage RFC 3161 en V2. |
| **R8** | **Non-adoption par Sylvie** — retour à Excel. Le risque le plus sous-estimé. | M | **É** | L'impliquer dès la phase 0 ; le tableau de bord est prioritaire ; reprise de l'existant incluse ; formation. Un outil non utilisé n'a aucune propriété de sécurité. |
| **R9** | **Reprise de l'existant** : contrats papier/PDF hétérogènes, dates de fin absentes. | É | M | Import CSV + PDF en pièce ; `EXPIRED` accepté (EC-01) ; **chiffrer la charge en phase 0** — c'est le poste le plus souvent sous-estimé. |
| **R10** | **Éditeur HTML** : puits sans fond. | É | M | Périmètre gelé ; pas de mise en page libre. |
| **R11** | **Délivrabilité email** : le rappel J-30 en spam = objectif n°1 manqué. | M | É | SPF/DKIM/DMARC ; SES en production ; supervision des bounces ; **le rappel interne ne dépend pas de l'email** (in-app). |
| **R12** | **GUC résiduel** sur connexion poolée = fuite inter-client silencieuse et intermittente. | F | **CRIT** | `set_config(..., true)` transactionnel ; test dédié (§16.4-C) ; pgBouncer en mode transaction. |
| **R13** | **Coût RLS** avec 100 UUID dans le GUC. | F | M | Mesure k6 (§16.6) ; repli sur table temporaire. Premier mur que ce design rencontrera. |
| **R14** | **Dérive du scope** : un développeur ajoute une table sans RLS. | **É** | CRIT | Test structurel §16.4-A. C'est *le* test qui protège dans la durée : la revue humaine ne tient pas 3 ans. |

P = probabilité, I = impact. F/M/É = faible/moyen/élevé.

**Les trois à surveiller réellement** : R3 (erreur humaine — le seul que l'architecture ne peut pas résoudre), R14 (dérive dans le temps — traité par la CI) et R8 (adoption — un outil non adopté ne protège rien).

---

## 20. Questions ouvertes

1. **R1 / Cloud Act** — LSI assume-t-il l'hébergement AWS pour des contrats de clients potentiellement sensibles (collectivités, santé, défense) ? Un client peut-il exiger contractuellement un hébergement souverain ? *Arbitrage phase 0 — c'est la seule décision difficilement réversible du dossier.*
2. **Validation juridique de §13.7** — le conseil de LSI confirme-t-il que la SES suffit pour ces contrats ? Existe-t-il un seuil de montant au-delà duquel une signature avancée s'impose ?
3. **Reprise de l'existant** — combien de contrats actifs à reprendre, sous quel format, avec quelle qualité de données ? *Chiffrage phase 0 (R9).*
4. **H6 / Entra ID** — LSI est-il bien sous M365 avec MFA activé ? Le tenant Entra peut-il émettre des applications OIDC ?
5. **Signataire LSI** — une seule personne signe-t-elle tous les contrats, ou faut-il une délégation par montant ?
6. **Préavis** — les préavis sont-ils homogènes (90 j) ou variables par contrat ? Faut-il un rappel dédié à l'échéance de préavis en plus des rappels d'expiration ?
7. **Destinataires client** — le contact principal, ou tous les contacts ? Le signataire est-il toujours le contact principal ?
8. **Numérotation** — `LSI-{année}-{séquence}` convient-il ? Faut-il un préfixe par catégorie ?
9. **Portefeuilles** — combien de clients par account manager ? Un client peut-il en avoir deux (titulaire + suppléant) ? *Impacte `customer_access`.*
10. **Marque blanche** — la revente à d'autres MSP est-elle une perspective réelle à 3 ans ? *Si non, `tenants` reste une assurance peu coûteuse. Si oui, réévaluer l'hybride (§10.2).*
11. **PRA** — quel RTO/RPO acceptable ? Le PITR RDS (RPO 5 min) suffit-il ?
12. **Ressources** — deux développeurs sur 4-5 mois, est-ce l'hypothèse de charge retenue ?

