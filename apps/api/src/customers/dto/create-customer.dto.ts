import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class CreateCustomerDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional() @IsString() @MaxLength(200)
  legalName?: string;

  /** SIREN : exactement 9 chiffres. Unique par tenant. */
  @IsOptional() @Matches(/^\d{9}$/, { message: 'siren doit comporter 9 chiffres' })
  siren?: string;

  @IsOptional() @IsString() @MaxLength(20)
  vatNumber?: string;

  @IsOptional() @IsString() @MaxLength(200)
  addressLine1?: string;

  @IsOptional() @IsString() @MaxLength(200)
  addressLine2?: string;

  @IsOptional() @IsString() @MaxLength(20)
  postalCode?: string;

  @IsOptional() @IsString() @MaxLength(120)
  city?: string;

  /** Code pays ISO à 2 lettres. Défaut FR côté base. */
  @IsOptional() @Length(2, 2)
  country?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;
}
