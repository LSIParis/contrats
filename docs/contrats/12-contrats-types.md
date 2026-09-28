# 12 — Contrats types des propositions

> Les quatre contrats types vers lesquels une proposition signée est convertie
> (11-propositions §10). Texte source : `packages/persistence/src/seed/contract-templates-data.ts`.
> Installation : `pnpm seed:contract-templates` (idempotente, en **brouillon**).
> **Projets à faire relire par un juriste avant publication.**

## 1. Les quatre contrats

| Slug | Nom | Offre (modèle de proposition) | Annexes |
|---|---|---|---|
| `infogerance` | Contrat d'infogérance TPE-PME | Modèle 1 | Niveaux de service, grille tarifaire, accord de traitement (art. 28) |
| `supervision` | Contrat de supervision et de contrôle des sauvegardes | Modèle 2 | idem |
| `rssi-externalise` | Contrat de RSSI externalisé | Modèle 3 | Lettre de mission, grille tarifaire, accord de traitement |
| `sauvegarde-en-ligne` | Contrat de sauvegarde en ligne | Modèle 4 | Niveaux de service, grille tarifaire, accord de traitement |

Chaque contrat = **clauses propres à l'offre** (objet, périmètre, niveaux de service,
exclusions…) + **socle commun** (parties, définitions, documents contractuels, durée et
reconduction, prix et ajustement au parc réel, révision Syntec, paiement, obligations des
parties, responsabilité, assurance, confidentialité, RGPD, sous-traitance, propriété
intellectuelle, réversibilité, résiliation, force majeure, non-sollicitation, droit applicable).

Les clauses sont dans la **bibliothèque** (codes `CT-…`) : corriger une clause (nouvelle
version) puis mettre à jour les modèles concernés, qui sont ensuite republiés.

## 2. Variables

| Remplies automatiquement à la conversion | À compléter sur chaque contrat |
|---|---|
| `client.raisonSociale`, `client.siren`, `client.adresse`, `contrat.reference`, `contrat.dateEffet`, `contrat.dureeMois`, `contrat.preavis` (si le préavis est renseigné) | `client.representant` ; pour la supervision : `sla.plageHoraire`, `sla.delaiIntervention` |

Le **Prestataire** est écrit en toutes lettres dans la clause `CT-PARTIES` (version 2,
2026-09-28) : LSI, SAS au capital de 5 000 €, SIREN 821 439 379, siège 849 rue de la
Gare, 13770 Venelles, RCS d’Aix-en-Provence (source : Registre national des
entreprises ; RCS confirmé sur le Kbis le 2026-09-28).

Modifier une clause des contrats types : corriger son texte dans
`contract-templates-data.ts`, puis `pnpm seed:contract-templates --upgrade CODE`
(nouvelle version de la clause, contrats types **non publiés** recomposés — texte et
variables ; les publiés ne sont jamais touchés et sont signalés). Ou, sans code :
Bibliothèque de clauses → nouvelle version, puis éditeur de chaque modèle.

La **grille tarifaire** n'est pas à rédiger : elle est générée depuis la configuration
acceptée dans la proposition (prix figés, 11-propositions §5).

## 3. Points à valider (juriste / direction)

**Valeurs reprises du brief comme indicatives (`TO_VALIDATE`)**
- Infogérance : prise en charge en 4 h ouvrées (incident bloquant) et 8 h ouvrées (autres) ; heures ouvrées lun.–ven., 9 h–18 h.
- Sauvegarde : conservation 30 quotidiennes / 8 hebdomadaires / 12 mensuelles ; verrouillage 30 jours ; Microsoft 365 conservé 12 mois ; restauration urgente prise en charge sous 4 h ouvrées.
- RSSI : volume de référence ETI (5 jours RSSI, 2 jours DPO par mois) ; tarifs journaliers additionnels 1 100 € / 800 € HT.
- Supervision : délai de notification d'une alerte critique et plage de surveillance **laissés en variables** (aucune valeur dans le brief).

**Clauses juridiquement sensibles**
- **Responsabilité** (`CT-RESPONSABILITE`) : plafond égal aux sommes facturées sur 12 mois, exclusion des dommages indirects. Vérifier l'articulation avec l'obligation essentielle (art. 1170 C. civ.), en particulier pour la sauvegarde en ligne (perte de données).
- **Résiliation anticipée** (`CT-RESILIATION`) : exigibilité des redevances restant dues jusqu'au terme de l'engagement — qualifiable de clause pénale (réductible par le juge, art. 1231-5 C. civ.).
- **Reconduction** (`CT-DUREE`) : périodes de 12 mois après l'engagement initial ; préavis repris du contrat. Pour un client **consommateur ou non-professionnel**, l'information Chatel s'applique (02-cycle-de-vie §5).
- **Non-sollicitation** (`CT-NON-SOLLICITATION`) : 12 mois, indemnité de 6 mois de salaire brut.
- **Juridiction** (`CT-LOI`) : tribunal de commerce du ressort du siège du Prestataire.
- **Accord de traitement** (annexe art. 28) : notification des violations sous 48 h ; audits avec préavis de 30 jours ; liste des sous-traitants ultérieurs à tenir à jour (hébergement, stockage Impossible Cloud pour la sauvegarde).
- **RSSI** : le rôle de conseil (`CT-RSSI-ROLE`) et la désignation du DPO auprès de la CNIL par le Client (`CT-RSSI-DPO`).
- **CGV** : le contrat renvoie aux CGV en vigueur à l'acceptation de la proposition (`CT-DOCUMENTS`) — elles doivent être publiées dans l'administration des propositions.

## 4. Mise en service

1. `pnpm seed:contract-templates` (rôle propriétaire de la base, `SEED_TENANT_SLUG`) : crée les
   clauses et les quatre contrats types **en brouillon**, avec leur slug. Relancer ne modifie
   jamais un contrat type ou une clause existants.
2. Relecture juridique : **Modèles** → contrat type → export Word pour annotation, corrections
   dans la **Bibliothèque de clauses** et l'éditeur du modèle.
3. **Publier** chaque contrat type (Modèles → Publier).
4. Vérifier dans **Administration des propositions → Contrats types** que les quatre slugs
   sont associés à un contrat type publié.
