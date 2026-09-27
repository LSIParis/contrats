-- Lot 9.9 : assistance IA à la rédaction des propositions. Migration ADDITIVE.
--
-- 1. Types d'appels IA journalisés (ai_usage.operation).
-- 2. Sources citées d'une section rédigée par IA : conservées avec la section
--    (brief §12.3 : « sources citées conservées »), jusqu'à la version figée.

ALTER TYPE "AiOperation" ADD VALUE IF NOT EXISTS 'PROPOSAL_DRAFT';
ALTER TYPE "AiOperation" ADD VALUE IF NOT EXISTS 'PROPOSAL_REPHRASE';
ALTER TYPE "AiOperation" ADD VALUE IF NOT EXISTS 'PROSPECT_RESEARCH';

ALTER TABLE proposal_sections ADD COLUMN ai_sources jsonb;
