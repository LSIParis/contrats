import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  withScope, createCustomer, CustomerSirenConflict, resolveUserScope,
  type Scope,
} from '@lsi/persistence';
import { SessionService, type Session } from '../auth/session.service.js';

@Injectable()
export class CustomersService {
  constructor(private readonly sessions: SessionService) {}

  async create(scope: Scope, session: Session, dto: import('./dto/create-customer.dto.js').CreateCustomerDto) {
    const isAdmin = session.roles.includes('MSP_ADMIN');
    let created: { id: string };
    try {
      created = await createCustomer({
        tenantId: session.tenantId,
        name: dto.name, legalName: dto.legalName ?? null, siren: dto.siren ?? null,
        vatNumber: dto.vatNumber ?? null, addressLine1: dto.addressLine1 ?? null,
        addressLine2: dto.addressLine2 ?? null, postalCode: dto.postalCode ?? null,
        city: dto.city ?? null, country: dto.country ?? null, notes: dto.notes ?? null,
        creatorUserId: session.userId, grantAccess: !isAdmin,
      });
    } catch (e) {
      if (e instanceof CustomerSirenConflict) throw new ConflictException('SIREN déjà utilisé');
      throw e;
    }

    // Le scope est résolu au LOGIN et mis en cache dans la session ; le client
    // neuf n'y figure pas. Pour un AM, on re-résout depuis customer_access
    // (qui contient désormais l'accès) et on rafraîchit la session — sinon il
    // ne verrait pas son propre client avant de se reconnecter (EC-17).
    let effective = scope;
    if (!isAdmin) {
      // Créer un client ne change PAS les rôles de l'utilisateur — seulement
      // son portefeuille. On ne met donc à jour QUE le scope de la session,
      // en gardant session.roles tel quel (évite d'importer RoleCode et la
      // frontière @prisma/client).
      const resolved = await resolveUserScope(session.tenantId, session.userId);
      if (resolved) {
        effective = resolved.scope;
        await this.sessions.put({ ...session, scope: resolved.scope });
      }
    }

    return withScope(effective, (tx) =>
      tx.customer.findUniqueOrThrow({
        where: { id: created.id },
        select: { id: true, name: true, siren: true, country: true },
      }),
    );
  }

  list(scope: Scope) {
    return withScope(scope, async (tx) => {
      const rows = await tx.customer.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true, name: true, siren: true, country: true, status: true,
          _count: { select: { contracts: true } },
        },
      });
      return {
        items: rows.map((c) => ({
          id: c.id, name: c.name, siren: c.siren, country: c.country,
          status: c.status, contractCount: c._count.contracts,
        })),
      };
    });
  }

  findOne(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id },
        select: {
          id: true, name: true, legalName: true, siren: true, vatNumber: true,
          addressLine1: true, addressLine2: true, postalCode: true, city: true,
          country: true, status: true,
        },
      });
      if (!customer) throw new NotFoundException('Client introuvable');
      const contacts = await tx.customerContact.findMany({
        where: { customerId: id },
        orderBy: [{ isPrimary: 'desc' }, { lastName: 'asc' }],
        select: {
          id: true, firstName: true, lastName: true, email: true,
          phone: true, jobTitle: true, isPrimary: true,
        },
      });
      return { customer, contacts };
    });
  }
}
