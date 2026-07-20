import { IsDateString, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class AmendContractDto {
  @IsString() @MinLength(1, { message: 'Une description est obligatoire.' }) @MaxLength(2000)
  reason!: string;

  @IsOptional() @IsDateString()
  endDate?: string;

  @IsOptional() @IsInt() @Min(0)
  amountCents?: number;
}
