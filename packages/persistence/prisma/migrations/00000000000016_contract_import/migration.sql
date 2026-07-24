-- Import de contrats existants : provenance + document joint (signé hors app).
-- Les lignes existantes deviennent NATIVE. RLS inchangée (mêmes colonnes de
-- scope) ; colonnes document nullable.
CREATE TYPE "ContractOrigin" AS ENUM ('NATIVE', 'IMPORTED');

ALTER TABLE contracts
  ADD COLUMN origin "ContractOrigin" NOT NULL DEFAULT 'NATIVE',
  ADD COLUMN imported_document_key text,
  ADD COLUMN imported_document_name text,
  ADD COLUMN imported_document_sha256 char(64),
  ADD COLUMN imported_document_content_type text;
