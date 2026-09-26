import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateContactDto {
  @IsString() @MaxLength(120) firstName!: string;
  @IsString() @MaxLength(120) lastName!: string;
  @IsEmail() email!: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) jobTitle?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
  /** Habilité à signer pour le client (signataire DocuSeal proposé). */
  @IsOptional() @IsBoolean() isSignatory?: boolean;
  /** Qualité à signer : gérant, président, DG, mandataire… (brief §1). */
  @IsOptional() @IsString() @MaxLength(120) signingCapacity?: string;
}
