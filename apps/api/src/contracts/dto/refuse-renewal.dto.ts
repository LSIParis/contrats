import { IsString, MinLength, MaxLength } from 'class-validator';

export class RefuseRenewalDto {
  @IsString()
  @MinLength(1, { message: 'Un motif est obligatoire.' })
  @MaxLength(2000)
  reason!: string;
}
