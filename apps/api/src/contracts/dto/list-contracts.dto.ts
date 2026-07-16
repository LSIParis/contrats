import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { CONTRACT_STATUSES } from '@lsi/domain';

export class ListContractsDto {
  /**
   * FILTRE, jamais SCOPE.
   *
   * Il RESTREINT dans le scope de session ; il ne peut jamais l'élargir.
   * Le service l'intersecte avec le scope — il ne s'y substitue pas.
   * Passer le customerId d'un autre client renvoie une liste vide, pas la
   * liste de cet autre client : RLS filtre en amont de toute façon.
   */
  @IsOptional()
  @IsUUID('7')
  customerId?: string;

  @IsOptional()
  @IsEnum(CONTRACT_STATUSES, { each: true })
  status?: string[];

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  expiringWithinDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Pagination par curseur : l'offset dérive quand les données bougent. */
  @IsOptional()
  @IsString()
  cursor?: string;
}
