import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SaveContentDto {
  @IsString()
  @MaxLength(500_000)
  bodyHtml!: string;

  @IsOptional() @IsString() @MaxLength(500)
  changeSummary?: string;
}
