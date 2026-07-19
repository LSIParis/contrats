import { IsEmail, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class AddSignerDto {
  @IsEnum(['LSI', 'CLIENT']) party!: 'LSI' | 'CLIENT';
  @IsString() @MaxLength(200) fullName!: string;
  @IsEmail() email!: string;
  @IsOptional() @IsInt() @Min(0) @Max(20) signingOrder?: number;
  @IsOptional() @IsUUID('7') contactId?: string;
}
