import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SignerDto {
  @IsEnum(['LSI', 'CLIENT'])
  party!: 'LSI' | 'CLIENT';

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName!: string;

  @IsEmail()
  email!: string;

  @IsInt()
  @Min(0)
  @Max(20)
  signingOrder!: number;

  @IsOptional()
  @IsUUID('7')
  contactId?: string;

  /** §11.7 — recommandé pour les signataires client. Défaut : true pour CLIENT. */
  @IsOptional()
  @IsBoolean()
  requireEmail2fa?: boolean;
}

/**
 * Pas de tenantId, pas de customerId : le contrat est désigné par l'URL et
 * son appartenance est déduite du scope de session (RM-29).
 */
export class SendForSignatureDto {
  /**
   * Le DTO valide la FORME, pas les RÈGLES.
   *
   * ArrayMinSize(1) écarte le tableau vide, qui n'a aucun sens. Mais la règle
   * réelle — au moins un signataire LSI ET un client (RM-12) — est vérifiée
   * par le service, pas ici.
   *
   * Un ArrayMinSize(2) serait un mauvais proxy : deux signataires LSI
   * passeraient la validation de forme tout en violant RM-12. La même
   * violation renverrait alors 400 ou 422 selon la façon de la déclencher.
   * Une règle métier mérite un code métier.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SignerDto)
  signers!: SignerDto[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(180)
  expireInDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  subject?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  body?: string;

  // Volontairement ABSENT : completedRedirectUrl.
  // Il est construit côté serveur depuis une constante. Le laisser entrer
  // ici ouvrirait un open redirect — la valeur est rendue dans le
  // navigateur du signataire (§11.7).
}
