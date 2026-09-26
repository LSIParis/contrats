-- Nouvelles valeurs d'énumération du cycle de vie v2 (02-cycle-de-vie.md).
--
-- Migration SÉPARÉE, et c'est voulu : PostgreSQL interdit d'utiliser une
-- valeur d'énumération ajoutée dans la même transaction (erreur 55P04,
-- « unsafe use of new value »). Prisma applique chaque migration dans sa
-- propre transaction : les valeurs sont donc commitées ici, puis utilisées
-- par la migration 19 (fonctions de découverte, contraintes).

ALTER TYPE "ContractStatus" ADD VALUE IF NOT EXISTS 'SENT_TO_CLIENT';
ALTER TYPE "ContractStatus" ADD VALUE IF NOT EXISTS 'IN_NEGOTIATION';
ALTER TYPE "ContractStatus" ADD VALUE IF NOT EXISTS 'ACCEPTED';
ALTER TYPE "ContractStatus" ADD VALUE IF NOT EXISTS 'SIGNATURE_EXPIRED';
ALTER TYPE "ContractStatus" ADD VALUE IF NOT EXISTS 'RENEWAL_DUE';
ALTER TYPE "ContractStatus" ADD VALUE IF NOT EXISTS 'TERMINATION_PENDING';
ALTER TYPE "ContractStatus" ADD VALUE IF NOT EXISTS 'IMPORTED_PENDING_VALIDATION';

ALTER TYPE "ContractOrigin" ADD VALUE IF NOT EXISTS 'AI';
