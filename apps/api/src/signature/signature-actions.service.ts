import { ConflictException, Inject, Injectable, NotFoundException, BadGatewayException } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';
import { ProviderError, applyEvent, type ESignatureProvider } from '@lsi/domain';
import { ESIGNATURE_PROVIDER } from './provider.token.js';

const ACTIVE = ['SENT', 'PARTIALLY_COMPLETED'] as const;

@Injectable()
export class SignatureActionsService {
  constructor(@Inject(ESIGNATURE_PROVIDER) private readonly provider: ESignatureProvider) {}

  async remind(scope: Scope, contractId: string): Promise<{ reminded: number }> {
    const submitters = await withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id: contractId }, select: { id: true } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      const req = await tx.signatureRequest.findFirst({
        where: { contractId, status: { in: [...ACTIVE] } },
        orderBy: { createdAt: 'desc' }, select: { id: true },
      });
      if (!req) throw new ConflictException({ code: 'NO_ACTIVE_REQUEST', detail: 'Aucune demande de signature en cours.' });
      const signers = await tx.contractSigner.findMany({
        where: { contractId, status: { in: ['SENT', 'VIEWED'] }, providerSubmitterId: { not: null } },
        select: { providerSubmitterId: true },
      });
      return signers.map((s) => s.providerSubmitterId!) as string[];
    });

    try {
      for (const id of submitters) await this.provider.remindSubmitter(id);
    } catch (e) {
      const msg = e instanceof ProviderError ? e.message : (e as Error).message;
      throw new BadGatewayException({ code: 'SIGNATURE_PROVIDER_ERROR', detail: `Relance impossible : ${msg}`, retryable: true });
    }
    return { reminded: submitters.length };
  }

  async revoke(scope: Scope, contractId: string): Promise<{ status: 'REVOKED' }> {
    // tx1 : valider + récupérer la submission à archiver
    const req = await withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({ where: { id: contractId }, select: { id: true, status: true } });
      if (!c) throw new NotFoundException('Contrat introuvable');
      const sr = await tx.signatureRequest.findFirst({
        where: { contractId, status: { in: [...ACTIVE] } },
        orderBy: { createdAt: 'desc' }, select: { id: true, providerSubmissionId: true },
      });
      if (!sr) throw new ConflictException({ code: 'NO_ACTIVE_REQUEST', detail: 'Aucune demande de signature en cours.' });
      // Le domaine valide la transition (PENDING_SIGNATURE/PARTIALLY_SIGNED requis).
      this.assertCanRevoke(c.status);
      return sr;
    });

    // I/O hors transaction (EC-04) : on n'acte la révocation qu'après le provider.
    if (req.providerSubmissionId) {
      try {
        await this.provider.revokeSubmission(req.providerSubmissionId);
      } catch (e) {
        const msg = e instanceof ProviderError ? e.message : (e as Error).message;
        throw new BadGatewayException({ code: 'SIGNATURE_PROVIDER_ERROR', detail: `Révocation impossible : ${msg}`, retryable: true });
      }
    }

    // tx2 : acter localement
    await withScope(scope, async (tx) => {
      const now = new Date();
      await tx.signatureRequest.update({ where: { id: req.id }, data: { status: 'REVOKED', updatedAt: now } });
      await tx.contractSigner.updateMany({
        where: { contractId },
        data: { status: 'PENDING', providerSubmitterId: null, providerSubmitterSlug: null, updatedAt: now },
      });
      const c = await tx.contract.findUnique({ where: { id: contractId }, select: { status: true } });
      const next = applyEvent(this.snapshot(c!.status), { type: 'REVOKE_SIGNATURE', actorUserId: scope.userId }, now);
      await tx.contract.update({ where: { id: contractId }, data: { status: next.status, updatedAt: now, updatedByUserId: scope.userId } });
    });
    return { status: 'REVOKED' };
  }

  private assertCanRevoke(status: string): void {
    try {
      applyEvent(this.snapshot(status), { type: 'REVOKE_SIGNATURE', actorUserId: 'check' }, new Date());
    } catch (e) {
      throw new ConflictException({ code: 'INVALID_TRANSITION', detail: (e as Error).message, currentStatus: status });
    }
  }

  /** Snapshot minimal : REVOKE_SIGNATURE ne lit que le statut. */
  private snapshot(status: string): any {
    return {
      id: 'x', type: 'MAIN', status, startDate: null, endDate: null, noticePeriodDays: null,
      currentVersionId: null, approvedVersionId: null, submittedByUserId: null,
      hasLsiSigner: true, hasClientSigner: true, hasRequiredAttachments: true,
      openAmendmentExists: false, hasSignedSuccessor: false,
      signedAt: null, activatedAt: null, terminatedAt: null,
    };
  }
}
