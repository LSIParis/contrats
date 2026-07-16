import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
