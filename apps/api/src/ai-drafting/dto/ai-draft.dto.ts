import { IsOptional, IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class AiDraftDto {
  @IsString() @IsNotEmpty() @MaxLength(8000)
  prompt!: string;

  @IsOptional() @IsString() @MaxLength(120)
  category?: string;

  @IsOptional() @IsString() @MaxLength(4000)
  context?: string;
}
