import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // rawBody: conserve les octets reçus, indispensable au HMAC du webhook
  // DocuSeal (§11.7). Sans cela, verifyWebhook n'a rien à vérifier et le
  // webhook refuserait TOUT en production — ou pire, si on l'avait fait
  // porter sur le JSON reparsé, il accepterait des corps falsifiés.
  const app = await NestFactory.create(AppModule, { rawBody: true, bufferLogs: true });
  app.useLogger(app.get(Logger));

  // Parse les cookies : le guard lit le cookie de session (§13.1).
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Un champ inconnu FAIT ÉCHOUER la requête au lieu d'être ignoré.
      //
      // Sans cela, un `tenantId` envoyé par un appelant serait retiré en
      // silence — et le jour où quelqu'un lit `req.body` brut quelque part,
      // il serait là. On échoue bruyamment plutôt que d'ignorer discrètement.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Le portail client et l'interface interne sont servis par le BFF Next.js,
  // qui parle à l'API dans le VPC. Pas de CORS ouvert.
  app.enableCors({ origin: process.env.APP_ORIGIN ?? false, credentials: true });

  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
