import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { withScope, uuidv7, type Scope } from '@lsi/persistence';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';

// Dérivé structurellement du type de withScope() plutôt qu'importé depuis
// @prisma/client : ce dernier import est interdit hors du module persistence
// (§16.4-D, eslint.config.js) — une requête émise hors de withScope() lève
// une exception PostgreSQL, RLS n'a alors aucun scope à opposer.
type TxClient = Parameters<Parameters<typeof withScope>[1]>[0];

const ROLE_LABEL: Record<string, string> = {
  MSP_ADMIN: 'Administrateur',
  ACCOUNT_MANAGER: 'Chargé de compte',
  LEGAL_REVIEWER: 'Relecteur juridique',
  TECHNICIAN: 'Technicien',
  CLIENT_SIGNER: 'Signataire client',
  CLIENT_VIEWER: 'Lecteur client',
};
const INTERNAL_ROLES = ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER', 'TECHNICIAN'];
const CLIENT_ROLES = ['CLIENT_SIGNER', 'CLIENT_VIEWER'];

@Injectable()
export class UsersService {
  list(scope: Scope) {
    return withScope(scope, async (tx) => {
      const rows = await tx.user.findMany({
        include: {
          roles: { include: { role: true } },
          customer: { select: { id: true, name: true } },
        },
        orderBy: { fullName: 'asc' },
      });
      return {
        items: rows.map((u) => ({
          id: u.id,
          email: u.email,
          fullName: u.fullName,
          kind: u.kind,
          status: u.status,
          roles: u.roles.map((r) => r.role.code),
          customer: u.customer,
        })),
      };
    });
  }

  // CLIENT ⊆ CLIENT_ROLES, INTERNAL ⊆ INTERNAL_ROLES ; CLIENT exige customerId,
  // INTERNAL l'interdit. 422 (pas 400) : le corps est syntaxiquement valide,
  // c'est la COHÉRENCE métier kind↔rôles↔customerId qui est en cause (RM-32).
  private assertKindRoles(kind: 'INTERNAL' | 'CLIENT', roles: readonly string[], customerId?: string | null): void {
    const allowed = kind === 'CLIENT' ? CLIENT_ROLES : INTERNAL_ROLES;
    const bad = roles.filter((r) => !allowed.includes(r));
    if (bad.length > 0) {
      throw new UnprocessableEntityException(
        `Rôle(s) incompatible(s) avec un compte ${kind} : ${bad.join(', ')}`,
      );
    }
    if (kind === 'CLIENT' && !customerId) {
      throw new UnprocessableEntityException('customerId requis pour un utilisateur CLIENT');
    }
    if (kind === 'INTERNAL' && customerId) {
      throw new UnprocessableEntityException('customerId doit être absent pour un utilisateur INTERNAL');
    }
  }

  // find-or-create sur (tenant, code) : les rôles ne sont pas seedés par
  // tenant (catalogue vide au départ). Le catch P2002 couvre la course entre
  // deux créations concurrentes du même rôle sur le même tenant.
  private async findOrCreateRole(tx: TxClient, tenantId: string, code: string): Promise<string> {
    const existing = await tx.role.findFirst({ where: { code: code as never } });
    if (existing) return existing.id;
    try {
      const created = await tx.role.create({
        data: { id: uuidv7(), tenantId, code: code as never, label: ROLE_LABEL[code] ?? code },
      });
      return created.id;
    } catch (e: any) {
      if (e?.code === 'P2002') {
        const refound = await tx.role.findFirst({ where: { code: code as never } });
        if (refound) return refound.id;
      }
      throw e;
    }
  }

  async create(scope: Scope, dto: CreateUserDto) {
    this.assertKindRoles(dto.kind, dto.roles, dto.customerId);
    // Uniqueness côté base est @@unique([tenantId, email]) — CASE-SENSITIVE —
    // alors que les deux parcours de connexion (OIDC, magic-link) résolvent
    // l'email via lower(email). Sans normalisation ici, 'Admin@lsi.fr' et
    // 'admin@lsi.fr' cohabiteraient (pas de P2002 → pas de 409), et le login
    // résoudrait ensuite de façon non déterministe entre les deux lignes.
    const normalizedEmail = dto.email.trim().toLowerCase();
    return withScope(scope, async (tx) => {
      if (dto.kind === 'CLIENT') {
        const customer = await tx.customer.findUnique({ where: { id: dto.customerId! } });
        if (!customer) throw new BadRequestException('Client introuvable');
        if (customer.status !== 'ACTIVE') {
          throw new UnprocessableEntityException({
            code: 'CUSTOMER_ARCHIVED',
            detail: 'Impossible de rattacher un utilisateur CLIENT à un client archivé.',
          });
        }
      }
      const id = uuidv7();
      const now = new Date();
      try {
        await tx.user.create({
          data: {
            id,
            tenantId: scope.tenantId,
            kind: dto.kind,
            customerId: dto.kind === 'CLIENT' ? dto.customerId! : null,
            email: normalizedEmail,
            fullName: dto.fullName,
            status: 'ACTIVE',
            createdAt: now,
            updatedAt: now,
          },
        });
      } catch (e: any) {
        if (e?.code === 'P2002') throw new ConflictException('Un utilisateur avec cet email existe déjà pour ce tenant');
        throw e;
      }
      // Dédup : `user_roles` a pour PK (userId, roleId) — un doublon dans
      // dto.roles (ex. ['TECHNICIAN','TECHNICIAN']) ferait échouer le second
      // create() avec P2002 non intercepté → 500 (au lieu d'un 201 idempotent).
      for (const code of new Set(dto.roles)) {
        const roleId = await this.findOrCreateRole(tx, scope.tenantId, code);
        await tx.userRole.create({ data: { userId: id, roleId, tenantId: scope.tenantId } });
      }
      return { id };
    });
  }

  async update(scope: Scope, id: string, dto: UpdateUserDto) {
    return withScope(scope, async (tx) => {
      const user = await tx.user.findUnique({
        where: { id },
        include: { roles: { include: { role: true } } },
      });
      if (!user) throw new NotFoundException('Utilisateur introuvable');

      const currentRoleCodes = user.roles.map((r) => r.role.code as string);
      const isActiveAdminNow = user.status === 'ACTIVE' && currentRoleCodes.includes('MSP_ADMIN');
      const losesAdmin =
        isActiveAdminNow &&
        (dto.status === 'DISABLED' || (dto.roles !== undefined && !dto.roles.includes('MSP_ADMIN')));

      if (losesAdmin) {
        // Verrou anti-course (TOCTOU) : sous READ COMMITTED (défaut Postgres),
        // deux PATCH concurrents désactivant chacun un admin DIFFÉRENT parmi
        // les deux derniers pourraient chacun lire « 1 autre admin actif »
        // AVANT que l'un des deux ne commite, et donc committer tous les
        // deux → zéro admin actif (verrouillage total du tenant). Verrouiller
        // uniquement les lignes du user ciblé ne suffit pas : ce sont des
        // lignes DIFFÉRENTES qui ne se bloquent pas mutuellement.
        //
        // On verrouille donc l'ENSEMBLE des lignes user_roles MSP_ADMIN du
        // tenant (FOR UPDATE) avant de compter. La seconde transaction
        // concurrente bloque sur ce verrou jusqu'au commit de la première,
        // puis relit un compte à jour et voit correctement 0 → 409. RLS
        // injecte le prédicat tenant_id/actor_kind (policy user_roles_scope,
        // migration 00000000000003_rls) ; lsi_app a UPDATE sur user_roles
        // (migration 00000000000001_app_role), donc SELECT ... FOR UPDATE
        // est autorisé.
        await tx.$queryRaw`
          SELECT ur.user_id FROM user_roles ur
          JOIN roles r ON r.id = ur.role_id
          WHERE r.code = 'MSP_ADMIN'
          FOR UPDATE`;

        // Dernier-admin : compter les AUTRES MSP_ADMIN actifs du tenant.
        // Le scope MSP_ADMIN est all_customers, donc cette requête voit tout
        // le tenant — pas seulement le portefeuille de l'appelant.
        const otherActiveAdmins = await tx.userRole.count({
          where: {
            userId: { not: id },
            role: { code: 'MSP_ADMIN' },
            user: { status: 'ACTIVE' },
          },
        });
        if (otherActiveAdmins === 0) {
          throw new ConflictException({
            code: 'LAST_ADMIN',
            detail: 'Impossible de retirer le dernier administrateur (MSP_ADMIN) actif du tenant.',
          });
        }
      }

      if (dto.status !== undefined) {
        await tx.user.update({ where: { id }, data: { status: dto.status, updatedAt: new Date() } });
      }

      if (dto.roles !== undefined) {
        this.assertKindRoles(user.kind, dto.roles, user.customerId);
        await tx.userRole.deleteMany({ where: { userId: id } });
        // Même dédup que create() — cf. commentaire ci-dessus.
        for (const code of new Set(dto.roles)) {
          const roleId = await this.findOrCreateRole(tx, scope.tenantId, code);
          await tx.userRole.create({ data: { userId: id, roleId, tenantId: scope.tenantId } });
        }
      }

      return { ok: true };
    });
  }
}
