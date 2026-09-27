import { BlockList, isIP } from 'node:net';

/**
 * Protection SSRF des webhooks sortants. (08-securite-rgpd.md §Webhooks)
 *
 * Une URL d'abonnement est saisie par un admin, mais c'est NOTRE serveur qui
 * l'appelle : sans garde, elle devient un proxy vers le réseau interne de la
 * stack (postgres, redis, minio, métadonnées cloud 169.254.169.254…).
 *
 * Deux barrières :
 *   1. à l'ENREGISTREMENT (`validateWebhookUrl`) : https obligatoire, pas
 *      d'identifiants dans l'URL, pas d'hôte manifestement local ;
 *   2. à la CONNEXION (`guardedLookup`, http-sender.ts) : le nom est résolu
 *      et CHAQUE adresse est vérifiée avant d'ouvrir la socket. C'est la
 *      barrière qui compte : un nom public peut pointer vers 127.0.0.1
 *      (rebinding DNS) ou changer de cible après l'enregistrement.
 * Les redirections ne sont JAMAIS suivies (une 302 vers l'intérieur
 * contournerait tout ce qui précède) : une 3xx est un échec de livraison.
 *
 * `WEBHOOKS_ALLOW_PRIVATE=true` lève ces deux barrières (tests, poste de
 * développement, consommateur de la suite sur le réseau privé). Il est
 * explicite, lu à chaque appel, et documenté comme un choix d'exploitation.
 */
const blocked = new BlockList();
// IPv4 non routables publiquement ou spéciales (RFC 6890 et voisines).
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
// IPv6 : boucle, non spécifiée, ULA, lien local, multicast, documentation, NAT64.
blocked.addAddress('::1', 'ipv6');
blocked.addAddress('::', 'ipv6');
for (const [net, prefix] of [
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

export function allowPrivateTargets(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WEBHOOKS_ALLOW_PRIVATE === 'true';
}

/** Vrai si l'adresse IP (littérale) est privée, locale ou réservée. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4 encapsulée (::ffff:127.0.0.1) : on juge l'IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return blocked.check(mapped[1]!, 'ipv4');
    return blocked.check(lower, 'ipv6');
  }
  return true; // pas une IP : on refuse par défaut
}

export class UnsafeWebhookTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeWebhookTargetError';
  }
}

/** Hôte manifestement local (nom) — vérifié à l'enregistrement. */
function isLocalHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.');
}

/**
 * Validation à l'enregistrement. Renvoie l'URL normalisée ou lève
 * `UnsafeWebhookTargetError` avec un message destiné à l'admin.
 */
export function validateWebhookUrl(raw: string, allowPrivate = allowPrivateTargets()): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeWebhookTargetError('URL invalide');
  }
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) {
    throw new UnsafeWebhookTargetError('URL en https:// obligatoire');
  }
  if (u.username || u.password) {
    throw new UnsafeWebhookTargetError('identifiants interdits dans l’URL (le secret HMAC authentifie les livraisons)');
  }
  if (u.hash) throw new UnsafeWebhookTargetError('fragment (#…) interdit dans l’URL');
  if (!allowPrivate) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) ? isPrivateAddress(host) : isLocalHostname(host)) {
      throw new UnsafeWebhookTargetError('hôte privé, local ou réservé refusé');
    }
  }
  return u.toString();
}
