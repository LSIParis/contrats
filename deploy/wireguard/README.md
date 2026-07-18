# Tunnel WireGuard — Docker 01 ↔ Docker Legal

Lien privé chiffré entre les deux VPS, parce qu'ils **ne partagent aucun
réseau privé** (chacun n'a que son IP publique OVH). Sans lui, le saut
nginx-pm → API passerait en clair entre deux IP publiques.

## Topologie

```
Docker 01 (nginx-pm)                    Docker Legal (app)
51.91.98.38                             51.178.30.81
   │  wg0 10.99.0.1/24                     wg0 10.99.0.2/24  │
   └──────────── UDP 51820, chiffré ───────────────────────┘

nginx-pm  →  10.99.0.2:3001  (API, via le tunnel)
```

L'API (stack `lsi-contrats`) se lie **uniquement** à `10.99.0.2:3001` : elle
n'est donc pas joignable sur l'IP publique de Legal, seulement par nginx-pm à
travers le tunnel.

## Comment il tourne

Un conteneur `lsi-wireguard` par hôte, en **réseau hôte** avec `NET_ADMIN` +
`SYS_MODULE`, `restart: unless-stopped`. Il crée l'interface `wg0` sur l'hôte
et la maintient (`sleep infinity`). Au reboot, il se relance et recrée `wg0`.

Les clés **privées** ne sont pas dans ce dépôt. Les clés publiques ne sont pas
sensibles. Chaque conteneur reçoit sa clé privée par variable d'environnement.

## Recréer (si besoin)

Générer deux paires de clés :

```sh
wg genkey | tee priv01 | wg pubkey    # → clé pub Docker 01
wg genkey | tee privLg | wg pubkey    # → clé pub Legal
```

Déployer sur **chaque** hôte un conteneur `linuxserver/wireguard:latest`,
réseau hôte, `CapAdd: [NET_ADMIN, SYS_MODULE]`, `restart: unless-stopped`,
avec pour entrypoint un script qui monte `wg0` :

```sh
ip link add wg0 type wireguard
printf '%s' "$WG_PRIV" > /tmp/p
wg set wg0 private-key /tmp/p listen-port 51820 \
  peer "$PEER_PUB" endpoint "$PEER_ENDPOINT" \
  allowed-ips "$PEER_ALLOWED" persistent-keepalive 25
ip addr add "$WG_ADDR" dev wg0
ip link set wg0 up
rm /tmp/p && sleep infinity
```

Variables par hôte :

| | `WG_ADDR` | `PEER_ENDPOINT` | `PEER_ALLOWED` |
|---|---|---|---|
| Docker 01 | `10.99.0.1/24` | `51.178.30.81:51820` | `10.99.0.2/32` |
| Legal | `10.99.0.2/24` | `51.91.98.38:51820` | `10.99.0.1/32` |

`PEER_PUB` = clé publique de l'autre hôte.

## Vérifier

Depuis le conteneur `lsi-wireguard` de Docker 01 :

```sh
wg show wg0 latest-handshakes   # un timestamp récent = handshake OK
ping -c3 10.99.0.2              # doit répondre
```

## Démonter

Supprimer les deux conteneurs `lsi-wireguard`. L'interface `wg0` peut
subsister jusqu'au prochain reboot ; pour la retirer tout de suite :
`ip link del wg0` sur chaque hôte.

> UDP **51820** doit être ouvert entre les deux IP publiques. Testé
> fonctionnel — aucun pare-feu OVH ne le bloque par défaut.
