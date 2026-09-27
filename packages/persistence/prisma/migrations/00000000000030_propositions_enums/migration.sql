-- Lot 9 — propositions commerciales (docs/contrats/11-propositions.md). Migration ADDITIVE.
--
-- Nouvelles valeurs d'énumérations EXISTANTES, seules dans leur migration :
-- une valeur ajoutée par ALTER TYPE … ADD VALUE ne peut pas être utilisée
-- dans la transaction qui l'ajoute (PostgreSQL 55P04). La migration 31 les
-- emploie (index, CHECK, fonctions) une fois celle-ci COMMITÉE.

-- Contrat né d'une proposition signée (brief §12.1 : `Contract.origin` enrichi de PROPOSAL).
ALTER TYPE "ContractOrigin" ADD VALUE IF NOT EXISTS 'PROPOSAL';

-- Prestations trimestrielles (test de restauration trimestriel des modèles
-- Supervision et Sauvegarde en ligne) : récurrence gérée par le moteur, et donc
-- par le barème du contrat issu de la proposition.
ALTER TYPE "PricingRecurrence" ADD VALUE IF NOT EXISTS 'QUARTERLY';

-- Documents d'une proposition : PDF de la version, PDF signé, journal DocuSeal.
ALTER TYPE "StoredDocumentKind" ADD VALUE IF NOT EXISTS 'PROPOSAL_PDF';
ALTER TYPE "StoredDocumentKind" ADD VALUE IF NOT EXISTS 'PROPOSAL_SIGNED_PDF';
ALTER TYPE "StoredDocumentKind" ADD VALUE IF NOT EXISTS 'PROPOSAL_AUDIT_TRAIL';
