import { IsDateString, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class TerminateContractDto {
  @IsString()
  @MinLength(1, { message: 'Un motif est obligatoire.' })
  @MaxLength(2000)
  reason!: string;

  @IsDateString()
  effectiveDate!: string;

  @IsEnum(['LSI', 'CLIENT'])
  initiatedBy!: 'LSI' | 'CLIENT';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  overrideReason?: string;
}
