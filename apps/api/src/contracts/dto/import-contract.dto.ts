import { IsDateString, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Min, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

/** Métadonnées d'un contrat importé (multipart : les nombres/dates arrivent
 *  en chaîne → @Type coerce). tenantId JAMAIS ici (vient de la session). */
export class ImportContractDto {
  @IsUUID('7') customerId!: string;
  @IsString() @IsNotEmpty() @MaxLength(100) reference!: string;
  @IsString() @IsNotEmpty() @MaxLength(300) title!: string;

  @IsOptional() @IsEnum(['MAIN', 'AMENDMENT']) type?: 'MAIN' | 'AMENDMENT';
  @IsOptional() @IsEnum(['MAINTENANCE', 'SUPPORT', 'HOSTING', 'SLA', 'OTHER'])
  category?: 'MAINTENANCE' | 'SUPPORT' | 'HOSTING' | 'SLA' | 'OTHER';

  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
  @IsOptional() @IsDateString() signedAt?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) noticePeriodDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) amountCents?: number;
}
