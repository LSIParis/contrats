import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Pas de tenantId, pas de customerId : le contrat est désigné par l'URL et
 * son appartenance est déduite du scope de session (RM-29).
 *
 * Pas de `signers` : les signataires sont DÉFINIS sur le contrat (bloc
 * Signataires, `ContractSigner`) — on ne les redemande plus à l'envoi. RM-12
 * (au moins un LSI et un client) est vérifiée par le service depuis ces
 * lignes, pas depuis le corps de la requête.
 */
export class SendForSignatureDto {
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
