import { IsDateString, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class TerminateContractDto {
  @IsString()
  @MinLength(1, { message: 'Un motif est obligatoire.' })
  @MaxLength(2000)
  reason!: string;

  /**
   * Facultative : absente, la date d'effet est CALCULÉE selon le préavis et
   * la période en cours (computeTerminationEffectiveDate). Présente, elle ne
   * peut précéder le calcul que par dérogation administrateur (RM-20).
   */
  @IsOptional()
  @IsDateString()
  effectiveDate?: string;

  @IsEnum(['LSI', 'CLIENT'])
  initiatedBy!: 'LSI' | 'CLIENT';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  overrideReason?: string;
}
