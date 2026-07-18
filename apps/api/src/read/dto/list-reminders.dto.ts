import { IsEnum, IsOptional } from 'class-validator';
import { REMINDER_STATUSES, type ReminderStatus } from '@lsi/domain';

export class ListRemindersDto {
  /**
   * FILTRE, jamais SCOPE — cf. ListContractsDto. Une valeur invalide doit
   * échouer avec un 400 (ValidationPipe), jamais atteindre Prisma : la
   * colonne est un enum et une valeur hors énumération y provoquerait une
   * PrismaClientValidationError (500).
   */
  @IsOptional()
  @IsEnum(REMINDER_STATUSES)
  status?: ReminderStatus;
}
