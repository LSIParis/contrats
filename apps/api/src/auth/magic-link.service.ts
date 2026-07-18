import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { findLoginUser, resolveUserScope, uuidv7 } from '@lsi/persistence';
import type { EmailSender } from '@lsi/domain';
import { REDIS } from './redis.provider.js';
import { EMAIL_SENDER } from '../notifications/email.token.js';
import { SessionService, SESSION_TTL, type RoleCode } from './session.service.js';

const TOKEN_TTL_SECONDS = 15 * 60; // 15 min (§13.1)

interface MagicPayload {
  userId: string;
  tenantId: string;
}

/**
 * Authentification par magic link — pour les CLIENTS. (§13.1)
 *
 * Nathalie se connecte trois fois par an : un mot de passe serait réinitialisé
 * à chaque fois. Le magic link supprime ce frottement.
 *
 * Sécurité :
 *   - le jeton est aléatoire (32 o), à USAGE UNIQUE, TTL 15 min
 *   - on stocke son HASH, jamais le jeton en clair : un vol de Redis ne donne
 *     aucun lien utilisable
 *   - la demande répond TOUJOURS 200, que l'email existe ou non — pas
 *     d'oracle d'énumération de comptes (§13.3)
 *   - seuls les CLIENTS passent par là ; un compte INTERNE ne reçoit jamais
 *     de magic link (il passe par OIDC)
 */
@Injectable()
export class MagicLinkService {
  private readonly log = new Logger(MagicLinkService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    private readonly sessions: SessionService,
  ) {}

  private key(hash: string): string {
    return `magic:${hash}`;
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Demande un magic link. Répond toujours sans révéler si le compte existe.
   */
  async request(tenantId: string, email: string, now: Date): Promise<void> {
    const user = await findLoginUser(tenantId, email);

    // Un compte INTERNE ne reçoit pas de magic link : il passe par OIDC.
    // On ne le dit pas à l'appelant (pas d'énumération).
    if (!user || user.kind !== 'CLIENT') {
      this.log.debug(`magic link ignoré pour ${email} (inconnu ou non-client)`);
      return;
    }

    const token = randomBytes(32).toString('base64url');
    const payload: MagicPayload = { userId: user.userId, tenantId };
    await this.redis.set(this.key(this.hash(token)), JSON.stringify(payload), 'EX', TOKEN_TTL_SECONDS);

    const link = `${process.env.PORTAL_URL ?? 'https://contrats.lsi-maintenance.fr'}/portal/verify?token=${token}`;
    await this.email.send({
      to: email,
      subject: 'Votre lien de connexion — LSI Maintenance',
      text:
        `Bonjour,\n\nCliquez sur ce lien pour accéder à vos contrats (valable 15 minutes) :\n${link}\n\n` +
        `Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.`,
    });
  }

  /**
   * Vérifie un jeton et ouvre une session. Le jeton est consommé (usage unique).
   * Renvoie l'id de session + le TTL, ou null si le jeton est invalide/expiré.
   */
  async verify(token: string): Promise<{ sessionId: string; ttl: number } | null> {
    const k = this.key(this.hash(token));
    const raw = await this.redis.get(k);
    if (!raw) return null;
    // Usage unique : on supprime AVANT de créer la session.
    await this.redis.del(k);

    const { userId, tenantId } = JSON.parse(raw) as MagicPayload;

    // Le scope est (re)résolu maintenant, jamais porté par le jeton.
    const resolved = await resolveUserScope(tenantId, userId);
    if (!resolved || resolved.kind !== 'CLIENT') return null; // révoqué/désactivé entre-temps

    const sessionId = uuidv7();
    await this.sessions.put(
      {
        sessionId,
        userId,
        tenantId,
        roles: resolved.roles as RoleCode[],
        scope: resolved.scope,
      },
      SESSION_TTL.CLIENT,
    );
    return { sessionId, ttl: SESSION_TTL.CLIENT };
  }
}
