import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res: any = ctx.getResponse();
    const req: any = ctx.getRequest();
    const requestId = (req.id as string) ?? (req.headers?.['x-request-id'] as string) ?? null;

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    // Préserver le corps existant (HttpException) ; y ajouter requestId.
    const raw = isHttp ? exception.getResponse() : { statusCode: status, message: 'Erreur interne' };
    const body = typeof raw === 'string' ? { statusCode: status, message: raw } : { ...(raw as object) };
    (body as any).requestId = requestId;

    // On ne logue QUE les 5xx (les 4xx sont attendues + déjà tracées par pino-http).
    if (status >= 500) {
      this.logger.error({ err: exception, requestId, method: req.method, path: req.url, status }, 'Erreur non gérée');
    }
    res.status(status).json(body);
  }
}
