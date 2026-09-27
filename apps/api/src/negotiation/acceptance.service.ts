import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7, withScope, type Scope } from '@lsi/persistence';
import { applyEvent, BusinessRuleError, InvalidTransitionError, type ContractEvent } from '@lsi/domain';
import { z } from 'zod';
import { persistTransition, toContractSnapshot } from '../contracts/snapshot.js';

/**
 * Acceptation d'une proposition, DISTINCTE de la signature (brief §2) :
 * trace horodatée, nom, e-mail, IP, VERSION acceptée (table
 * contract_acceptances, append-only) + transition CLIENT_ACCEPT.
 *
 * Deux voies :
 *   - le client accepte lui-même depuis le portail (méthode PORTAL : son
 *     identité vient de sa session, son IP de la requête) ;
 *   - LSI enregistre une acceptation reçue hors application (e-mail,
 *     courrier) — méthode RECORDED_BY_STAFF, pièce justificative OBLIGATOIRE
 *     (CHECK en base).
 */
export const RecordAcceptanceSchema = z
  .object({
    versionId: z.uuid(),
    acceptedByName: z.string().trim().min(1).max(200),
    acceptedByEmail: z.email(),
    evidenceNote: z.string().trim().min(5).max(2000),
  })
  .strict();

export const PortalAcceptSchema = z.object({ versionId: z.uuid() }).strict();

export interface AcceptanceContext {
  readonly method: 'PORTAL' | 'RECORDED_BY_STAFF';
  readonly versionId: string;
  readonly name: string;
  readonly email: string;
  readonly userId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly evidenceNote: string | null;
}

@Injectable()
export class AcceptanceService {
  async accept(scope: Scope, contractId: string, ctx: AcceptanceContext, now: Date) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id: contractId } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      const version = await tx.contractVersion.findUnique({ where: { id: ctx.versionId }, select: { id: true, contractId: true, pdfSha256: true } });
      if (!version || version.contractId !== contractId) throw new NotFoundException('Version introuvable');

      const event: ContractEvent = { type: 'CLIENT_ACCEPT', versionId: ctx.versionId };
      let next;
      try {
        next = applyEvent(toContractSnapshot(c), event, now);
      } catch (e) {
        if (e instanceof InvalidTransitionError) {
          throw new ConflictException({ code: e.code, detail: e.message, currentStatus: e.currentStatus, allowedTransitions: e.allowedTransitions });
        }
        if (e instanceof BusinessRuleError) throw new ConflictException({ code: e.code, detail: e.message, rule: e.rule });
        throw e;
      }

      const acceptanceId = uuidv7();
      await tx.contractAcceptance.create({
        data: {
          id: acceptanceId, tenantId: c.tenantId, customerId: c.customerId, contractId, versionId: ctx.versionId,
          method: ctx.method, acceptedByUserId: ctx.userId, acceptedByName: ctx.name, acceptedByEmail: ctx.email,
          versionPdfSha256: version.pdfSha256, ip: ctx.ip, userAgent: ctx.userAgent?.slice(0, 500) ?? null,
          acceptedAt: now, evidenceNote: ctx.evidenceNote,
        },
      });
      await persistTransition(tx, contractId, event, next, now, ctx.userId ?? undefined);
      return { acceptanceId, status: next.status, versionId: ctx.versionId, acceptedAt: now };
    });
  }

  list(scope: Scope, contractId: string) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id: contractId }, select: { id: true } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      return {
        items: await tx.contractAcceptance.findMany({
          where: { contractId },
          orderBy: { acceptedAt: 'desc' },
          select: {
            id: true, versionId: true, method: true, acceptedByName: true, acceptedByEmail: true,
            ip: true, acceptedAt: true, evidenceNote: true, versionPdfSha256: true,
          },
        }),
      };
    });
  }
}
