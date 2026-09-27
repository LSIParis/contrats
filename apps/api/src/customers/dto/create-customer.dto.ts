import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

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

  /**
   * Consommateur ou non-professionnel (art. liminaire C. conso.) : déclenche
   * l'obligation d'information de la loi Chatel sur les contrats à tacite
   * reconduction (02-cycle-de-vie §5). Défaut : professionnel.
   */
  @IsOptional() @IsBoolean()
  isConsumer?: boolean;

  /** Référence du client dans Client Help (ou saisie locale). Unique par tenant. */
  @IsOptional() @IsString() @MaxLength(100)
  externalRef?: string;

  /**
   * Statut commercial (lot 9) : un prospect créé depuis une proposition est
   * `PROSPECT` ; il devient `CLIENT` à la signature. Défaut : `CLIENT`.
   */
  @IsOptional() @IsIn(['PROSPECT', 'CLIENT'])
  commercialStatus?: 'PROSPECT' | 'CLIENT';
}
