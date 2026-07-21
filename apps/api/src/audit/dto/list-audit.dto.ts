import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListAuditDto {
  @IsOptional() @IsString() resourceType?: string;
  @IsOptional() @IsUUID('7') resourceId?: string;
  @IsOptional() @IsUUID('7') actorUserId?: string;
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() from?: string; // ISO
  @IsOptional() @IsString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
