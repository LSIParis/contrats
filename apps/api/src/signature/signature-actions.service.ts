import { ConflictException, Inject, Injectable, NotFoundException, BadGatewayException } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';
import { ProviderError, type ESignatureProvider } from '@lsi/domain';
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
}
