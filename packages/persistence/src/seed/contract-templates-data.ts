/**
 * Contrats types associés aux quatre modèles de propositions (brief §12.11) :
 * `infogerance`, `supervision`, `rssi-externalise`, `sauvegarde-en-ligne`.
 *
 * PROJETS à faire relire par un juriste avant publication : ils sont installés
 * en BROUILLON (voir contract-templates.ts) et ne servent à la conversion d'une
 * proposition qu'une fois publiés. Les valeurs reprises du brief et marquées
 * `TO_VALIDATE` y sont signalées (docs/contrats/12-contrats-types.md).
 *
 * Variables : uniquement celles du registre (packages/domain templates/variables.ts).
 * Pré-remplies à la conversion : client.*, prestataire.raisonSociale,
 * contrat.reference, contrat.dateEffet, contrat.dureeMois, contrat.preavis.
 * À compléter sur le contrat : prestataire.siren, prestataire.adresse,
 * client.representant, et les sla.* du contrat de supervision.
 */

export type ClauseCategory =
  | 'OBJET' | 'DUREE' | 'PRIX' | 'SLA' | 'RESPONSABILITE' | 'RGPD' | 'CONFIDENTIALITE'
  | 'PROPRIETE_INTELLECTUELLE' | 'ASSURANCE' | 'RESILIATION' | 'DIVERS';

export interface ClauseDef {
  readonly code: string;
  readonly category: ClauseCategory;
  readonly title: string;
  readonly bodyHtml: string;
}

export interface AnnexDef {
  readonly kind: 'SLA' | 'ASSETS' | 'PRICING_GRID' | 'DPA_ART28' | 'OTHER';
  readonly title: string;
  readonly bodyHtml: string | null;
}

export interface ContractTemplateDef {
  readonly slug: string;
  readonly name: string;
  readonly category: 'MAINTENANCE' | 'SUPPORT' | 'HOSTING' | 'SLA' | 'OTHER';
  /** Codes de clauses, dans l'ordre du contrat. */
  readonly clauses: readonly string[];
  readonly annexes: readonly AnnexDef[];
}

const p = (...lines: string[]) => lines.map((l) => `<p>${l}</p>`).join('');
const ul = (...items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;

// ---------------------------------------------------------------------------
// Socle commun
// ---------------------------------------------------------------------------

const PARTIES = p(
  // Prestataire : LSI SAS (RNE, 2026-09-28 ; RCS d’Aix-en-Provence confirmé sur le Kbis).
  '<strong>Entre</strong> LSI, société par actions simplifiée au capital de 5 000 €, immatriculée au RCS d’Aix-en-Provence sous le numéro 821 439 379, dont le siège social est situé 849 rue de la Gare, 13770 Venelles, ci-après « le Prestataire »,',
  '<strong>et</strong> {{client.raisonSociale}}, SIREN {{client.siren}}, dont le siège est situé {{client.adresse}}, représentée par {{client.representant}}, ci-après « le Client »,',
  'ensemble « les Parties ». Contrat n° {{contrat.reference}}.',
);

export const COMMON_CLAUSES: readonly ClauseDef[] = [
  { code: 'CT-PARTIES', category: 'DIVERS', title: 'Parties', bodyHtml: PARTIES },
  {
    code: 'CT-DEFINITIONS', category: 'DIVERS', title: 'Définitions',
    bodyHtml: p('Dans le présent contrat, les termes suivants ont le sens ci-dessous :') + ul(
      '<strong>Services</strong> : les prestations décrites au contrat et dans ses annexes ;',
      '<strong>Parc</strong> : les équipements, logiciels et comptes du Client couverts par les Services, tels qu’inventoriés à la mise en service puis mis à jour ;',
      '<strong>Heures ouvrées</strong> : du lundi au vendredi, de 9 h à 18 h, heure de Paris, hors jours fériés en France métropolitaine ;',
      '<strong>Incident</strong> : tout dysfonctionnement affectant un élément du Parc ; <strong>Incident bloquant</strong> : incident empêchant l’activité d’un ensemble d’utilisateurs ou d’un service essentiel du Client, sans solution de contournement ;',
      '<strong>Demande</strong> : toute sollicitation du Client qui n’est pas un Incident.',
    ),
  },
  {
    code: 'CT-DOCUMENTS', category: 'DIVERS', title: 'Documents contractuels',
    bodyHtml: p(
      'Le contrat est constitué, par ordre de priorité décroissant : (1) le présent document ; (2) ses annexes ; (3) la proposition commerciale acceptée par le Client, pour la description des Services et les quantités ; (4) les conditions générales de vente du Prestataire en vigueur à la date d’acceptation de la proposition.',
      'En cas de contradiction, le document de rang supérieur prévaut. Les conditions générales du Client ne s’appliquent pas.',
    ),
  },
  {
    code: 'CT-DUREE', category: 'DUREE', title: 'Durée et renouvellement',
    bodyHtml: p(
      'Le contrat prend effet le {{contrat.dateEffet}} pour une durée initiale ferme de {{contrat.dureeMois}} mois (la « période d’engagement »).',
      'À son terme, il est reconduit tacitement par périodes successives de douze (12) mois, sauf dénonciation par l’une des Parties, par lettre recommandée avec avis de réception ou tout écrit dont la réception est prouvée, au moins {{contrat.preavis}} avant l’échéance de la période en cours.',
    ),
  },
  {
    code: 'CT-PRIX', category: 'PRIX', title: 'Prix et ajustement au parc réel',
    bodyHtml: p(
      'Les prix, quantités et frais de mise en service figurent à l’annexe « Grille tarifaire », établie à partir de la configuration acceptée par le Client. Ils s’entendent hors taxes ; la TVA au taux en vigueur s’y ajoute.',
      'Pour les lignes facturées à l’unité, la quantité facturée suit le Parc réellement administré, constaté chaque mois par les outils du Prestataire ; le Client en est informé par le rapport mensuel et peut en contester le décompte dans les quinze (15) jours. Lorsque la grille prévoit un minimum mensuel de facturation, le montant facturé est le plus élevé des deux.',
      'Les prestations hors forfait sont facturées aux tarifs rappelés au contrat, sur devis ou bon d’intervention préalablement accepté par le Client.',
    ),
  },
  {
    code: 'CT-REVISION', category: 'PRIX', title: 'Révision des prix',
    bodyHtml: p(
      'Les prix sont révisés à chaque date anniversaire de la date d’effet selon la formule : P1 = P0 × (0,15 + 0,85 × S1 / S0), où P1 est le prix révisé, P0 le prix en vigueur, S0 la valeur de l’indice Syntec publiée à la date d’effet ou à la précédente révision, et S1 la dernière valeur publiée à la date de révision.',
      'En cas de disparition de l’indice, il est remplacé par l’indice que l’organisme de publication lui aura substitué ou, à défaut, par un indice équivalent choisi d’un commun accord.',
    ),
  },
  {
    code: 'CT-PAIEMENT', category: 'PRIX', title: 'Facturation et paiement',
    bodyHtml: p(
      'Les redevances récurrentes sont facturées mensuellement, terme à échoir ; les frais de mise en service à la signature ; les prestations hors forfait après exécution. Les factures sont payables à trente (30) jours date de facture, par prélèvement ou virement.',
      'Tout retard de paiement entraîne de plein droit, sans rappel, l’application de pénalités au taux d’intérêt appliqué par la Banque centrale européenne à son opération de refinancement la plus récente majoré de dix (10) points, ainsi qu’une indemnité forfaitaire pour frais de recouvrement de quarante (40) euros (article L. 441-10 du Code de commerce).',
      'Quinze (15) jours après une mise en demeure restée sans effet, le Prestataire peut suspendre les Services, sans préjudice de ses autres droits.',
    ),
  },
  {
    code: 'CT-OBLIG-PRESTATAIRE', category: 'DIVERS', title: 'Obligations du Prestataire',
    bodyHtml: p('Le Prestataire exécute les Services avec diligence, conformément aux règles de l’art, dans le cadre d’une obligation de moyens. Il désigne un interlocuteur nommé, affecte un personnel qualifié, respecte les niveaux de service convenus et informe le Client de tout événement susceptible d’affecter la sécurité ou la disponibilité de son système d’information.'),
  },
  {
    code: 'CT-OBLIG-CLIENT', category: 'DIVERS', title: 'Obligations du Client',
    bodyHtml: p('Le Client collabore activement à l’exécution des Services. Il s’engage notamment à :') + ul(
      'désigner un référent et informer le Prestataire de tout changement du Parc ou de son organisation ;',
      'donner au Prestataire les accès distants et physiques nécessaires, et lui communiquer toute information utile ;',
      'disposer de licences régulières et à jour pour les logiciels utilisés ;',
      'ne pas intervenir, ni faire intervenir un tiers, sur les éléments administrés par le Prestataire sans l’en avertir ;',
      'régler les sommes dues aux échéances convenues.',
    ),
  },
  {
    code: 'CT-RESPONSABILITE', category: 'RESPONSABILITE', title: 'Responsabilité',
    bodyHtml: p(
      'Chaque Partie répond des dommages directs et prouvés causés à l’autre par un manquement à ses obligations. Ne sont pas indemnisés les dommages indirects, tels que les pertes d’exploitation, de chiffre d’affaires, de clientèle ou d’image.',
      'La responsabilité totale du Prestataire, toutes causes confondues, est limitée au montant hors taxes des sommes facturées au titre du contrat pendant les douze (12) mois précédant le fait générateur. Cette limitation ne s’applique pas en cas de faute lourde ou dolosive, ni aux dommages corporels.',
      'Le Prestataire n’est pas responsable des dommages résultant d’un manquement du Client à ses obligations, d’une intervention non autorisée d’un tiers, ou d’un élément exclu des Services.',
    ),
  },
  {
    code: 'CT-ASSURANCE', category: 'ASSURANCE', title: 'Assurance',
    bodyHtml: p('Le Prestataire déclare être titulaire d’une police d’assurance de responsabilité civile professionnelle couvrant les conséquences de son activité, et en fournit l’attestation sur demande.'),
  },
  {
    code: 'CT-CONFIDENTIALITE', category: 'CONFIDENTIALITE', title: 'Confidentialité',
    bodyHtml: p('Chaque Partie garde strictement confidentielles les informations de toute nature reçues de l’autre à l’occasion du contrat, ne les utilise que pour son exécution et ne les communique qu’aux personnes qui ont besoin d’en connaître, tenues aux mêmes obligations. Cette obligation dure pendant le contrat et cinq (5) ans après sa fin, sauf pour les informations publiques ou légitimement reçues d’un tiers.'),
  },
  {
    code: 'CT-RGPD', category: 'RGPD', title: 'Protection des données personnelles',
    bodyHtml: p(
      'Pour les traitements de données personnelles réalisés pour le compte du Client dans le cadre des Services, le Client agit en qualité de responsable de traitement et le Prestataire en qualité de sous-traitant, au sens du règlement (UE) 2016/679 (RGPD).',
      'Les conditions de ces traitements sont définies à l’annexe « Accord de traitement des données (article 28 du RGPD) », qui fait partie intégrante du contrat. Les données sont hébergées dans l’Union européenne.',
    ),
  },
  {
    code: 'CT-SOUS-TRAITANCE', category: 'DIVERS', title: 'Sous-traitance',
    bodyHtml: p('Le Prestataire peut confier une partie des Services à des sous-traitants de son choix, notamment pour l’hébergement et le stockage, en restant seul responsable envers le Client. Pour les traitements de données personnelles, les conditions de l’annexe relative au RGPD s’appliquent.'),
  },
  {
    code: 'CT-PROPRIETE', category: 'PROPRIETE_INTELLECTUELLE', title: 'Propriété intellectuelle',
    bodyHtml: p('Le Client reste seul propriétaire de ses données. Le Prestataire reste titulaire de ses outils, méthodes, savoir-faire et logiciels, dont il concède au Client un droit d’usage limité à la durée et aux besoins du contrat. Les documents produits spécifiquement pour le Client lui sont cédés à compter de leur complet paiement.'),
  },
  {
    code: 'CT-REVERSIBILITE', category: 'RESILIATION', title: 'Réversibilité',
    bodyHtml: p(
      'À la fin du contrat, pour quelque cause que ce soit, le Prestataire remet au Client ou au prestataire qu’il désigne les éléments nécessaires à la continuité de son système d’information : inventaire, documentation, identifiants et accès administrés, configurations.',
      'Les prestations d’accompagnement de la réversibilité au-delà de cette remise sont facturées aux tarifs hors forfait. Les données personnelles sont restituées puis supprimées dans les conditions de l’annexe relative au RGPD.',
    ),
  },
  {
    code: 'CT-RESILIATION', category: 'RESILIATION', title: 'Résiliation',
    bodyHtml: p(
      'En cas de manquement grave d’une Partie à ses obligations, non réparé dans les trente (30) jours d’une mise en demeure adressée par lettre recommandée avec avis de réception, l’autre Partie peut résilier le contrat de plein droit, sans préjudice de dommages et intérêts.',
      'Si le Client met fin au contrat avant le terme de la période d’engagement hors ce cas, les redevances mensuelles restant à courir jusqu’à ce terme deviennent immédiatement exigibles.',
    ),
  },
  {
    code: 'CT-FORCE-MAJEURE', category: 'DIVERS', title: 'Force majeure',
    bodyHtml: p('Aucune Partie n’est responsable d’un manquement causé par un cas de force majeure au sens de l’article 1218 du Code civil. Les obligations concernées sont suspendues pendant sa durée ; si elle excède soixante (60) jours, chaque Partie peut résilier le contrat par lettre recommandée, sans indemnité.'),
  },
  {
    code: 'CT-NON-SOLLICITATION', category: 'DIVERS', title: 'Non-sollicitation',
    bodyHtml: p('Pendant le contrat et douze (12) mois après sa fin, le Client s’interdit de solliciter ou d’embaucher, directement ou indirectement, un salarié du Prestataire ayant participé aux Services, sauf accord écrit du Prestataire. En cas de manquement, il verse au Prestataire une indemnité égale à six (6) mois de la dernière rémunération brute du salarié concerné.'),
  },
  {
    code: 'CT-LOI', category: 'DIVERS', title: 'Droit applicable et litiges',
    bodyHtml: p(
      'Le contrat est soumis au droit français.',
      'Les Parties recherchent d’abord une solution amiable pendant trente (30) jours à compter de la notification écrite du différend. À défaut, tout litige relatif au contrat est porté devant le tribunal de commerce du ressort du siège du Prestataire, y compris en cas de pluralité de défendeurs ou d’appel en garantie.',
    ),
  },
];

// ---------------------------------------------------------------------------
// Clauses propres à chaque offre
// ---------------------------------------------------------------------------

const TARIFS_HORS_FORFAIT = 'quatre-vingt-quinze euros (95 €) HT de l’heure à distance ou en projet, et cent dix euros (110 €) HT de l’heure sur site, frais de déplacement en sus, révisables comme les prix du contrat';

export const OFFER_CLAUSES: readonly ClauseDef[] = [
  // --- Infogérance --------------------------------------------------------
  {
    code: 'CT-INFO-OBJET', category: 'OBJET', title: 'Objet',
    bodyHtml: p('Le contrat a pour objet l’infogérance du Parc du Client par le Prestataire : maintenir les postes, serveurs et équipements dans un état opérationnel, sécurisé et suivi au quotidien, et réduire les interruptions par la détection proactive des anomalies.'),
  },
  {
    code: 'CT-INFO-PERIMETRE', category: 'SLA', title: 'Périmètre des Services',
    bodyHtml: p('Les Services comprennent, pour les éléments du Parc désignés dans la grille tarifaire :') + ul(
      'la supervision quotidienne des postes, serveurs et agents ;',
      'la gestion des mises à jour système et applicatives ;',
      'le suivi de l’antivirus et l’identification des postes non protégés ou non à jour ;',
      'le support des utilisateurs, sans limitation du nombre de demandes, pour le poste de travail, les périphériques et les applications bureautiques usuelles ;',
      'la tenue de l’inventaire technique du Parc ;',
      'un rapport d’activité mensuel.',
    ) + p('Lorsque le Client a souscrit les options correspondantes, les Services comprennent en outre la gestion de son tenant Microsoft 365, l’administration et l’assistance de ses utilisateurs Microsoft 365, et la gestion Intune / Defender de ses postes.'),
  },
  {
    code: 'CT-INFO-MISE-EN-SERVICE', category: 'DIVERS', title: 'Mise en service',
    bodyHtml: p('La mise en service comprend l’audit initial du Parc, l’intégration des équipements, le déploiement des agents, le paramétrage des alertes, la collecte de l’inventaire et l’initialisation du reporting. Elle est facturée selon la grille tarifaire et réalisée dans un délai convenu avec le Client ; les Services récurrents commencent à courir à la date d’effet.'),
  },
  {
    code: 'CT-INFO-EXCLUSIONS', category: 'DIVERS', title: 'Exclusions et prestations hors forfait',
    bodyHtml: p('Sont exclus du forfait et facturés en sus : les projets, migrations et interventions lourdes (réinstallation complète, changement d’infrastructure), la fourniture de matériel et de licences (notamment Microsoft), et les interventions rendues nécessaires par un manquement du Client ou d’un tiers. Aucune licence n’est incluse dans les Services.') +
      p(`Ces prestations sont réalisées sur devis ou bon d’intervention accepté, aux tarifs de ${TARIFS_HORS_FORFAIT}.`),
  },

  // --- Supervision et sauvegarde ------------------------------------------
  {
    code: 'CT-SUP-OBJET', category: 'OBJET', title: 'Objet',
    bodyHtml: p('Le contrat a pour objet la supervision proactive de l’infrastructure du Client et le contrôle de ses sauvegardes par le Prestataire. Le support des utilisateurs n’en fait pas partie : il reste assuré par le Client ou le prestataire qu’il désigne, que le Prestataire alerte.'),
  },
  {
    code: 'CT-SUP-PERIMETRE', category: 'SLA', title: 'Éléments supervisés',
    bodyHtml: p('Le Prestataire supervise, pour les éléments désignés dans la grille tarifaire, leur disponibilité et leur état de santé :') + ul(
      'serveurs et postes supervisés ;',
      'hyperviseurs Proxmox VE ;',
      'pare-feu pfSense / Netgate et équipements réseau UniFi ;',
      'NAS Synology et QNAP (volumes, disques, état SMART) ;',
      'services critiques, certificats et espace disque.',
    ) + p('La supervision de l’infrastructure passe par un collecteur installé sur le site du Client, sans agent sur les équipements d’infrastructure.'),
  },
  {
    code: 'CT-SUP-SAUVEGARDES', category: 'SLA', title: 'Contrôle des sauvegardes',
    bodyHtml: p('Le Prestataire contrôle chaque jour le résultat des sauvegardes du Client, signale les machines virtuelles non couvertes et alerte le Client en cas d’échec ou d’absence de sauvegarde. Lorsque l’option est souscrite, il réalise chaque trimestre un test de restauration donnant lieu à un procès-verbal, et héberge une sauvegarde externalisée en France.') +
      p('Le contrôle porte sur l’exécution et le résultat des sauvegardes : il ne rend pas le Prestataire responsable du contenu sauvegardé ni de la solution de sauvegarde du Client, sauf si celle-ci est fournie par le Prestataire.'),
  },
  {
    code: 'CT-SUP-ALERTES', category: 'SLA', title: 'Alertes, escalade et reporting',
    bodyHtml: p(
      'Le Prestataire qualifie les alertes et notifie le Client ou le prestataire qu’il désigne selon les canaux et délais de l’annexe « Niveaux de service ». La correction des incidents relève du Client, sauf souscription de l’option « Intervention corrective », dans la limite du volume d’heures mensuel convenu ; au-delà, les interventions sont facturées aux tarifs hors forfait.',
      'Le Prestataire remet chaque mois un rapport : disponibilité, incidents, état des sauvegardes, équipements hors support ou en fin de vie.',
    ),
  },
  {
    code: 'CT-SUP-HORS-FORFAIT', category: 'DIVERS', title: 'Prestations hors forfait',
    bodyHtml: p(`Les interventions non comprises dans les Services sont réalisées sur devis ou bon d’intervention accepté, aux tarifs de ${TARIFS_HORS_FORFAIT}.`),
  },

  // --- RSSI externalisé ----------------------------------------------------
  {
    code: 'CT-RSSI-OBJET', category: 'OBJET', title: 'Objet',
    bodyHtml: p('Le contrat a pour objet une mission de responsable de la sécurité des systèmes d’information externalisé (« RSSI externalisé ») confiée au Prestataire, selon la formule et, le cas échéant, l’option de délégué à la protection des données retenues dans la grille tarifaire. Ses modalités pratiques sont précisées dans la lettre de mission annexée.'),
  },
  {
    code: 'CT-RSSI-MISSION', category: 'SLA', title: 'Contenu de la mission',
    bodyHtml: p('La mission comprend :') + ul(
      'la gouvernance de la sécurité et le pilotage de son amélioration ;',
      'l’élaboration et la tenue à jour de la politique de sécurité (PSSI) ;',
      'une analyse de risques inspirée de la méthode EBIOS Risk Manager ;',
      'le suivi des mesures d’hygiène recommandées par l’ANSSI et d’un plan d’action priorisé ;',
      'des revues périodiques et la préparation aux audits ;',
      'l’aide à la réponse aux questionnaires sécurité des clients et donneurs d’ordre du Client ;',
      'des actions de sensibilisation ;',
      'l’accompagnement du Client en cas d’incident de sécurité.',
    ),
  },
  {
    code: 'CT-RSSI-LIVRABLES', category: 'DIVERS', title: 'Livrables et organisation',
    bodyHtml: p(
      'Le Prestataire remet : un diagnostic de maturité à la mise en place, une PSSI, une cartographie des risques, un plan d’action, un tableau de bord trimestriel et un rapport annuel.',
      'Il désigne un RSSI nommé. Le volume de jours mensuel, les comités de pilotage et les canaux d’escalade sont précisés dans la lettre de mission ; les jours au-delà de ce volume sont facturés sur devis au tarif journalier de mille cent euros (1 100 €) HT pour le RSSI et de huit cents euros (800 €) HT pour le délégué à la protection des données.',
    ),
  },
  {
    code: 'CT-RSSI-ROLE', category: 'RESPONSABILITE', title: 'Rôle du RSSI externalisé',
    bodyHtml: p(
      'Le Prestataire conseille, recommande et pilote ; les décisions et leur mise en œuvre appartiennent au Client, qui reste seul responsable de la sécurité de son système d’information et du respect des obligations légales et réglementaires qui lui incombent, notamment au titre de la directive NIS 2 lorsqu’elle lui est applicable.',
      'Le Client désigne au sein de sa direction un sponsor de la mission et donne au Prestataire accès aux informations et aux personnes nécessaires.',
    ),
  },
  {
    code: 'CT-RSSI-DPO', category: 'RGPD', title: 'Délégué à la protection des données (option)',
    bodyHtml: p(
      'Lorsque l’option est souscrite, le Prestataire exerce les missions de délégué à la protection des données prévues par l’article 39 du RGPD : tenue du registre des traitements, conseil sur la conformité, point de contact de la CNIL, traitement des demandes d’exercice des droits et des violations de données. Le Client procède à la désignation auprès de la CNIL et garantit l’indépendance du délégué dans l’exercice de ses missions.',
      'Lorsque les deux fonctions sont souscrites, la remise « offre combinée » prévue à la grille tarifaire s’applique aux forfaits mensuels RSSI et DPO.',
    ),
  },
  {
    code: 'CT-RSSI-CLOISONNEMENT', category: 'CONFIDENTIALITE', title: 'Cloisonnement et confidentialité renforcée',
    bodyHtml: p('Les informations traitées dans le cadre de la mission de RSSI ou de DPO sont conservées dans un espace strictement séparé de celui des équipes d’exploitation du Prestataire, et accessibles aux seuls intervenants de la mission. Les livrables sont confidentiels et réservés au Client.'),
  },

  // --- Sauvegarde en ligne -----------------------------------------------
  {
    code: 'CT-SAV-OBJET', category: 'OBJET', title: 'Objet',
    bodyHtml: p('Le contrat a pour objet la sauvegarde en ligne, par le Prestataire, des éléments du Client désignés dans la grille tarifaire, sur un stockage hébergé en France et protégé contre la modification et la suppression, ainsi que leur restauration à la demande du Client.'),
  },
  {
    code: 'CT-SAV-PERIMETRE', category: 'SLA', title: 'Éléments protégés et moyens techniques',
    bodyHtml: p('Selon les quantités retenues, les Services couvrent : les fichiers et dossiers des postes (Windows, macOS, Linux) ; les serveurs (fichiers, image disque, état système, bases de données) ; les machines virtuelles des hyperviseurs Proxmox VE, Hyper-V ou VMware ; les NAS Synology ; les comptes Microsoft 365. Seuls les éléments déclarés et installés lors de la mise en service sont protégés.') +
      p('Les données sont compressées, chiffrées côté Client (AES-256) avant leur transfert et dédupliquées. Elles sont stockées chez un hébergeur de stockage objet certifié ISO/IEC 27001, en région Paris, et verrouillées en mode conformité (« Object Lock ») pendant la durée de verrouillage prévue à l’annexe « Niveaux de service ». Une seconde copie à Francfort peut être souscrite en option.'),
  },
  {
    code: 'CT-SAV-CONSERVATION', category: 'SLA', title: 'Planification, conservation et restauration',
    bodyHtml: p(
      'La fréquence des sauvegardes, les durées de conservation et le délai de prise en charge d’une restauration urgente sont définis à l’annexe « Niveaux de service ».',
      'Le Prestataire contrôle chaque jour le résultat des sauvegardes et remet un rapport mensuel. Les restaurations liées à un incident couvert sont comprises dans les Services ; les autres sont facturées aux tarifs de ' + TARIFS_HORS_FORFAIT + '.',
    ),
  },
  {
    code: 'CT-SAV-STOCKAGE', category: 'PRIX', title: 'Volume de stockage',
    bodyHtml: p('Le stockage est facturé au volume occupé, arrondi au téraoctet supérieur, avec un minimum d’un (1) téraoctet ; la seconde copie ne peut excéder le volume principal. Le volume constaté est communiqué chaque mois au Client.'),
  },
  {
    code: 'CT-SAV-RESPONSABILITES', category: 'RESPONSABILITE', title: 'Obligations spécifiques et exclusions',
    bodyHtml: p(
      'Le Client déclare au Prestataire tout nouvel élément à protéger ; un élément non déclaré n’est pas sauvegardé. Il reste responsable du contenu de ses données et de leur licéité.',
      'Sont exclus des Services : la remise en état du système d’information après un sinistre, la mise en œuvre d’un plan de reprise d’activité complet, et la sauvegarde des éléments non déclarés. Ces prestations peuvent faire l’objet d’un devis.',
    ),
  },
];

// ---------------------------------------------------------------------------
// Annexes
// ---------------------------------------------------------------------------

const GRILLE: AnnexDef = { kind: 'PRICING_GRID', title: 'Annexe — Grille tarifaire', bodyHtml: null };

const DPA: AnnexDef = {
  kind: 'DPA_ART28', title: 'Annexe — Accord de traitement des données (article 28 du RGPD)',
  bodyHtml:
    '<h3>1. Objet, durée, nature et finalité</h3>' +
    p('Le Prestataire traite des données personnelles pour le compte du Client dans le seul but d’exécuter les Services, pendant la durée du contrat. Les traitements consistent, selon les Services, à héberger, consulter, sauvegarder, restaurer ou administrer des données.') +
    '<h3>2. Données et personnes concernées</h3>' +
    p('Données d’identification et de contact, données de connexion et journaux techniques, et toute donnée contenue dans les systèmes, fichiers ou comptes administrés ou sauvegardés. Personnes concernées : salariés, clients, fournisseurs et autres interlocuteurs du Client. Le Client s’interdit de confier des catégories particulières de données sans en informer préalablement le Prestataire.') +
    '<h3>3. Obligations du Prestataire</h3>' + ul(
      'traiter les données uniquement sur instruction documentée du Client, y compris pour les transferts hors de l’Union européenne, et l’informer si une instruction lui paraît contraire à la réglementation ;',
      'garantir la confidentialité des données et l’engagement de confidentialité des personnes autorisées à les traiter ;',
      'mettre en œuvre les mesures techniques et organisationnelles appropriées prévues à l’article 32 du RGPD : contrôle et traçabilité des accès, chiffrement, cloisonnement, sauvegarde, mises à jour de sécurité ;',
      'ne recourir à un autre sous-traitant qu’avec l’autorisation écrite générale du Client, en l’informant de tout changement envisagé afin qu’il puisse s’y opposer, et en lui imposant les mêmes obligations ;',
      'aider le Client à répondre aux demandes d’exercice des droits des personnes concernées et à respecter ses obligations des articles 32 à 36 du RGPD ;',
      'notifier au Client toute violation de données personnelles dans les meilleurs délais, et au plus tard quarante-huit (48) heures après en avoir pris connaissance ;',
      'au terme des Services, selon le choix du Client, restituer puis supprimer les données et leurs copies, sauf obligation légale de conservation ;',
      'mettre à la disposition du Client les informations nécessaires pour démontrer le respect de ces obligations et permettre des audits, à ses frais, moyennant un préavis de trente (30) jours.',
    ) +
    '<h3>4. Obligations du Client</h3>' +
    p('Le Client fournit les instructions et informations nécessaires, veille au respect du RGPD pour les traitements dont il est responsable et informe les personnes concernées.') +
    '<h3>5. Sous-traitants ultérieurs et localisation</h3>' +
    p('La liste des sous-traitants ultérieurs (notamment hébergement et stockage) et la localisation des données sont tenues à jour et communiquées au Client sur demande. Les données sont hébergées dans l’Union européenne.'),
};

const SLA_INFOGERANCE: AnnexDef = {
  kind: 'SLA', title: 'Annexe — Niveaux de service',
  bodyHtml:
    '<table><thead><tr><th>Type de sollicitation</th><th>Délai de prise en charge</th></tr></thead><tbody>' +
    '<tr><td>Incident bloquant</td><td>4 heures ouvrées</td></tr>' +
    '<tr><td>Incident non bloquant et Demande</td><td>8 heures ouvrées</td></tr>' +
    '</tbody></table>' +
    p('Les délais courent pendant les Heures ouvrées (du lundi au vendredi, de 9 h à 18 h, hors jours fériés), à compter de la réception de la sollicitation par les canaux de support du Prestataire. La prise en charge s’entend de la qualification de la sollicitation et du début de son traitement.'),
};

const SLA_SUPERVISION: AnnexDef = {
  kind: 'SLA', title: 'Annexe — Niveaux de service',
  bodyHtml:
    '<table><thead><tr><th>Engagement</th><th>Niveau</th></tr></thead><tbody>' +
    '<tr><td>Plage de surveillance et de traitement des alertes</td><td>{{sla.plageHoraire}}</td></tr>' +
    '<tr><td>Notification au Client d’une alerte critique</td><td>{{sla.delaiIntervention}}</td></tr>' +
    '<tr><td>Contrôle du résultat des sauvegardes</td><td>quotidien (jours ouvrés)</td></tr>' +
    '<tr><td>Rapport d’activité</td><td>mensuel</td></tr>' +
    '</tbody></table>' +
    p('Les délais courent à compter de la détection de l’alerte par les outils du Prestataire.'),
};

const SLA_SAUVEGARDE: AnnexDef = {
  kind: 'SLA', title: 'Annexe — Niveaux de service',
  bodyHtml:
    '<table><thead><tr><th>Engagement</th><th>Niveau</th></tr></thead><tbody>' +
    '<tr><td>Fréquence de sauvegarde</td><td>au moins quotidienne</td></tr>' +
    '<tr><td>Conservation</td><td>30 sauvegardes quotidiennes, 8 hebdomadaires, 12 mensuelles</td></tr>' +
    '<tr><td>Verrouillage contre la suppression (Object Lock, mode conformité)</td><td>30 jours</td></tr>' +
    '<tr><td>Conservation des données Microsoft 365</td><td>12 mois</td></tr>' +
    '<tr><td>Prise en charge d’une restauration urgente</td><td>4 heures ouvrées</td></tr>' +
    '<tr><td>Contrôle du résultat des sauvegardes / rapport</td><td>quotidien / mensuel</td></tr>' +
    '</tbody></table>',
};

const LETTRE_MISSION: AnnexDef = {
  kind: 'OTHER', title: 'Annexe — Lettre de mission',
  bodyHtml:
    p('La présente lettre précise les modalités pratiques de la mission de RSSI externalisé ; elle est complétée d’un commun accord à la mise en place.') +
    '<table><tbody>' +
    '<tr><td>RSSI nommé</td><td>à désigner à la mise en place</td></tr>' +
    '<tr><td>Sponsor au sein de la direction du Client</td><td>à désigner à la mise en place</td></tr>' +
    '<tr><td>Volume de jours mensuel de référence</td><td>selon la formule retenue (formule ETI : 5 jours RSSI et 2 jours DPO)</td></tr>' +
    '<tr><td>Comités de pilotage</td><td>trimestriels, avec le tableau de bord de la période</td></tr>' +
    '<tr><td>Canaux d’escalade et astreinte</td><td>précisés à la mise en place ; astreinte et notification d’incident sous 24 heures si l’option est souscrite</td></tr>' +
    '</tbody></table>',
};

// ---------------------------------------------------------------------------
// Composition des quatre contrats types
// ---------------------------------------------------------------------------

const DEBUT = ['CT-PARTIES', 'CT-DEFINITIONS'];
const FIN = [
  'CT-DOCUMENTS', 'CT-DUREE', 'CT-PRIX', 'CT-REVISION', 'CT-PAIEMENT', 'CT-OBLIG-PRESTATAIRE', 'CT-OBLIG-CLIENT',
  'CT-RESPONSABILITE', 'CT-ASSURANCE', 'CT-CONFIDENTIALITE', 'CT-RGPD', 'CT-SOUS-TRAITANCE', 'CT-PROPRIETE',
  'CT-REVERSIBILITE', 'CT-RESILIATION', 'CT-FORCE-MAJEURE', 'CT-NON-SOLLICITATION', 'CT-LOI',
];

export const CONTRACT_TEMPLATES: readonly ContractTemplateDef[] = [
  {
    slug: 'infogerance', name: 'Contrat d’infogérance TPE-PME', category: 'MAINTENANCE',
    clauses: [...DEBUT, 'CT-INFO-OBJET', 'CT-INFO-PERIMETRE', 'CT-INFO-MISE-EN-SERVICE', 'CT-INFO-EXCLUSIONS', ...FIN],
    annexes: [SLA_INFOGERANCE, GRILLE, DPA],
  },
  {
    slug: 'supervision', name: 'Contrat de supervision et de contrôle des sauvegardes', category: 'MAINTENANCE',
    clauses: [...DEBUT, 'CT-SUP-OBJET', 'CT-SUP-PERIMETRE', 'CT-SUP-SAUVEGARDES', 'CT-SUP-ALERTES', 'CT-SUP-HORS-FORFAIT', ...FIN],
    annexes: [SLA_SUPERVISION, GRILLE, DPA],
  },
  {
    slug: 'rssi-externalise', name: 'Contrat de RSSI externalisé', category: 'OTHER',
    clauses: [
      ...DEBUT, 'CT-RSSI-OBJET', 'CT-RSSI-MISSION', 'CT-RSSI-LIVRABLES', 'CT-RSSI-ROLE', 'CT-RSSI-DPO', 'CT-RSSI-CLOISONNEMENT', ...FIN,
    ],
    annexes: [LETTRE_MISSION, GRILLE, DPA],
  },
  {
    slug: 'sauvegarde-en-ligne', name: 'Contrat de sauvegarde en ligne', category: 'HOSTING',
    clauses: [...DEBUT, 'CT-SAV-OBJET', 'CT-SAV-PERIMETRE', 'CT-SAV-CONSERVATION', 'CT-SAV-STOCKAGE', 'CT-SAV-RESPONSABILITES', ...FIN],
    annexes: [SLA_SAUVEGARDE, GRILLE, DPA],
  },
];

export const ALL_CLAUSES: readonly ClauseDef[] = [...COMMON_CLAUSES, ...OFFER_CLAUSES];
