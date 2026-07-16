import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MaxLength,
} from 'class-validator';

/**
 * PAS de tenantId. Jamais. (RM-29)
 *
 * Il vient de la session, résolu au login. Un tenantId ici signifierait que
 * l'appelant choisit son propre scope, et rendrait décoratifs le guard, RLS
 * et les FK composites. Un test structurel échoue si ce champ apparaît
 * (tests/structural/scope-surface.test.ts).
 *
 * customerId, lui, est LÉGITIME — mais c'est un FILTRE, pas un scope :
 * il désigne POUR QUEL client on crée le contrat, et il est VÉRIFIÉ contre
 * le scope. Si le client n'est pas dans le portefeuille de la session, RLS
 * ne trouve pas la ligne `customers` et l'API répond 404. On ne peut pas
 * créer un contrat chez un client qu'on ne voit pas.
 */
export class CreateContractDto {
  @IsUUID('7')
  customerId!: string;

  @IsString()
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsEnum(['MAIN', 'AMENDMENT'])
  type?: 'MAIN' | 'AMENDMENT';

  @IsOptional()
  @IsEnum(['MAINTENANCE', 'SUPPORT', 'HOSTING', 'SLA', 'OTHER'])
  category?: 'MAINTENANCE' | 'SUPPORT' | 'HOSTING' | 'SLA' | 'OTHER';

  @IsOptional()
  @IsUUID('7')
  templateVersionId?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  noticePeriodDays?: number;

  /** En CENTIMES, entier. On ne stocke pas de la monnaie en flottant. */
  @IsOptional()
  @IsInt()
  @Min(0)
  amountCents?: number;

  @IsOptional()
  @IsEnum(['MONTHLY', 'QUARTERLY', 'YEARLY', 'ONE_OFF'])
  billingFrequency?: 'MONTHLY' | 'QUARTERLY' | 'YEARLY' | 'ONE_OFF';
}
