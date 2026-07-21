import { IsString, MaxLength, MinLength } from 'class-validator';

export class EditCommentDto {
  @IsString()
  @MinLength(1, { message: 'Le commentaire ne peut pas être vide.' })
  @MaxLength(5000, { message: 'Commentaire trop long (5000 caractères max).' })
  body!: string;
}
