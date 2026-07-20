import { IsArray, IsEnum, IsOptional } from 'class-validator';

const ROLE_CODES = ['MSP_ADMIN', 'ACCOUNT_MANAGER', 'LEGAL_REVIEWER', 'TECHNICIAN', 'CLIENT_SIGNER', 'CLIENT_VIEWER'] as const;

export class UpdateUserDto {
  @IsOptional() @IsEnum(['ACTIVE', 'DISABLED']) status?: 'ACTIVE' | 'DISABLED';
  @IsOptional() @IsArray() @IsEnum(ROLE_CODES, { each: true }) roles?: string[];
}
