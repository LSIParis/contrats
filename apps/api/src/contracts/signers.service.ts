import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { withScope, uuidv7, type Scope } from '@lsi/persistence';
import { EDITABLE_STATUSES } from '@lsi/domain';
import type { AddSignerDto } from './dto/add-signer.dto.js';

@Injectable()
export class SignersService {
  async add(scope: Scope, contractId: string, dto: AddSignerDto) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({
        where: { id: contractId },
        select: { id: true, tenantId: true, customerId: true, status: true },
      });
      if (!c) throw new NotFoundException('Contrat introuvable');
      if (!EDITABLE_STATUSES.includes(c.status as (typeof EDITABLE_STATUSES)[number])) {
        throw new ConflictException({ code: 'RM-04', detail: 'Les signataires ne se modifient que sur un brouillon.' });
      }
      const now = new Date();
      try {
        return await tx.contractSigner.create({
          data: {
            id: uuidv7(), tenantId: c.tenantId, customerId: c.customerId, contractId,
            party: dto.party, fullName: dto.fullName, email: dto.email,
            signingOrder: dto.signingOrder ?? 0, contactId: dto.contactId ?? null,
            createdAt: now, updatedAt: now,
          },
          select: { id: true, party: true, fullName: true, email: true, signingOrder: true },
        });
      } catch (e: any) {
        if (e?.code === 'P2002') throw new ConflictException('Un signataire avec cet email existe déjà sur ce contrat');
        throw e;
      }
    });
  }

  async remove(scope: Scope, contractId: string, signerId: string) {
    return withScope(scope, async (tx) => {
      const c = await tx.contract.findUnique({
        where: { id: contractId },
        select: { id: true, status: true },
      });
      if (!c) throw new NotFoundException('Contrat introuvable');
      if (!EDITABLE_STATUSES.includes(c.status as (typeof EDITABLE_STATUSES)[number])) {
        throw new ConflictException({ code: 'RM-04', detail: 'Les signataires ne se modifient que sur un brouillon.' });
      }
      const signer = await tx.contractSigner.findFirst({ where: { id: signerId, contractId }, select: { id: true } });
      if (!signer) throw new NotFoundException('Signataire introuvable');
      await tx.contractSigner.delete({ where: { id: signerId } });
    });
  }
}
