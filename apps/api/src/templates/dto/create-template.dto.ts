import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';

const CATEGORIES = ['MAINTENANCE', 'SUPPORT', 'HOSTING', 'SLA', 'OTHER'] as const;

export class CreateTemplateDto {
  @IsString() @MinLength(1) @MaxLength(200)
  name!: string;

  @IsEnum(CATEGORIES, { message: 'Catégorie invalide.' })
  category!: (typeof CATEGORIES)[number];
}
