import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateCommentDto {
  @IsString()
  @MinLength(1, { message: 'Le commentaire ne peut pas être vide.' })
  @MaxLength(5000, { message: 'Commentaire trop long (5000 caractères max).' })
  body!: string;

  @IsOptional()
  @IsEnum(['INTERNAL', 'SHARED'], { message: 'Visibilité invalide.' })
  visibility?: 'INTERNAL' | 'SHARED';
}
