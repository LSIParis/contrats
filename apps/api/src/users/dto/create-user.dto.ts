import { IsArray, IsEmail, IsEnum, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

const ROLE_CODES = ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER', 'TECHNICIAN', 'CLIENT_SIGNER', 'CLIENT_VIEWER'] as const;

export class CreateUserDto {
  @IsEnum(['INTERNAL', 'CLIENT']) kind!: 'INTERNAL' | 'CLIENT';
  @IsEmail() email!: string;
  @IsString() @MinLength(1) fullName!: string;
  @IsOptional() @IsUUID('7') customerId?: string;
  @IsArray() @IsEnum(ROLE_CODES, { each: true }) roles!: string[];
}
