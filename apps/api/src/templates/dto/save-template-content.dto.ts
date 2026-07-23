import { IsString, MaxLength } from 'class-validator';

export class SaveTemplateContentDto {
  @IsString() @MaxLength(200000)
  bodyHtml!: string;
}
