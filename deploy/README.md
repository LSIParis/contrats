# Déploiement — LSI Contrats (Phase A)

Déploiement de l'API sur **Docker Legal** via Portainer, exposée sur
`contrats.lsi-maintenance.fr` derrière nginx-pm.

> Périmètre Phase A : l'API et ses dépendances **réellement utilisées**
> (Postgres, Gotenberg). Pas d'auth (Phase B), pas de stockage persistant
> (Phase C), pas de worker (Phase D). Voir
> `docs/superpowers/specs/2026-07-17-plan-deploiement-production.md`.

## Prérequis

1. L'image `ghcr.io/lsiparis/contrats:latest` existe (la CI l'a poussée).
2. Le package ghcr est **accessible** par Docker Legal : soit public, soit un
   secret de registre configuré dans Portainer (`ghcr.io` + un PAT `read:packages`).
3. Les secrets de déploiement sont prêts (voir `.env.deploy.example`).

## Étapes

### 1. Créer la stack Portainer

Portainer → Stacks → Add stack → coller `docker-compose.stack.yml`.
Renseigner les variables dans **Environment variables** (jamais en dur).

Au premier démarrage, l'ordre est : `postgres` (healthy) → `migrate`
(applique le schéma **et** renouvelle les mots de passe de rôles, puis se
termine) → `api`.

### 2. Vérifier

```
# depuis Docker Legal
curl -f http://localhost:3001/health        # → {"status":"ok"}
```

### 3. Exposer via nginx-pm

La zone DNS `contrats.lsi-maintenance.fr` passe par nginx-pm (sur Docker 01).
Créer un **Proxy Host** :

- Domaine : `contrats.lsi-maintenance.fr`
- Forward vers : `http://<IP Docker Legal>:3001`
- SSL : Let's Encrypt, **Force SSL**, HTTP/2

> **⚠ Sécurité réseau — décision à trancher.** nginx-pm (Docker 01) et l'API
> (Docker Legal) sont sur des **hôtes différents**. Le port 3001 de Legal doit
> donc être joignable par Docker 01. Deux options :
>
> 1. **Réseau privé** entre les VPS (OVH vRack / Vultr VPC) : l'API n'écoute
>    que sur l'IP privée, jamais exposée publiquement. **Recommandé.**
> 2. **Port public + pare-feu** : publier 3001 et restreindre par `ufw`/
>    security group à la **seule IP de nginx-pm**. Sans ce filtrage, l'API est
>    joignable en clair par tout Internet (contournant TLS).
>
> À confirmer : les deux VPS partagent-ils un réseau privé ?

### 4. Câbler le webhook DocuSeal

DocuSeal → `/settings/webhooks` :

- URL : `https://contrats.lsi-maintenance.fr/v1/webhooks/docuseal`
- HMAC : activer, relever le secret `whsec_…` → le reporter dans
  `DOCUSEAL_WEBHOOK_SECRET` de la stack, puis redéployer l'API.

## Fermer la boucle (test de bout en bout)

Une fois l'API en ligne et le webhook câblé : créer un contrat de test,
l'envoyer en signature, signer via DocuSeal, vérifier que le webhook fait
passer le contrat en `SIGNED`. L'auth n'existant pas encore (Phase B), ce
déclenchement passe par une commande d'amorçage jetable — à préparer.

## Rollback

`IMAGE_TAG` accepte un `sha-<commit>` : épingler un tag connu et redéployer la
stack revient à la version précédente. Les migrations ne sont pas
auto-réversibles — vérifier la compatibilité avant de reculer.
