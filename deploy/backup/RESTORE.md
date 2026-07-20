# Restauration — LSI Contrats (sauvegardes Wasabi)

Sauvegardes : bucket Wasabi `lsi-contrats` (Paris), préfixes `pg/` (dumps
PostgreSQL) et `minio/` (miroir des PDF signés + audits). Chiffrées (SSE),
immuables (object lock).

## Pré-requis
Un conteneur avec `mc` + `pg_restore` v16 (ex. le conteneur `backup` de la
stack) où les alias `mc` `wasabi` et `local` sont configurés (l'entrypoint le
fait au démarrage).

## 1. Restaurer PostgreSQL
```sh
# lister les dumps, prendre celui voulu
mc ls wasabi/lsi-contrats/pg/
mc cp wasabi/lsi-contrats/pg/<AAAA-MM-JJThhmm>.dump /tmp/r.dump
# restaurer dans une base NEUVE (ne jamais ecraser le live a l'aveugle)
psql -c "CREATE DATABASE lsi_contrats_restored;"
pg_restore --no-owner --no-privileges -d lsi_contrats_restored /tmp/r.dump
# verifier, puis basculer selon la procedure d'exploitation
```

## 2. Restaurer MinIO (PDF signés + audits)
```sh
# re-synchroniser depuis Wasabi vers MinIO (additif)
mc mirror --overwrite wasabi/lsi-contrats/minio/ local/lsi-contrats
```

## 3. Vérifier
- Comptes de lignes cohérents (`contracts`, `signature_requests`, `contract_versions`).
- Un `signed_pdf_object_key` connu se télécharge bien depuis MinIO.
