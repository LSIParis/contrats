import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp, createFastifyAdapter } from './bootstrap.js';

async function bootstrap() {
  // rawBody: conserve les octets reçus, indispensable au HMAC du webhook
  // DocuSeal (§11.7). Sans cela, verifyWebhook n'a rien à vérifier et le
  // webhook refuserait TOUT en production — ou pire, si on l'avait fait
  // porter sur le JSON reparsé, il accepterait des corps falsifiés.
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter(), {
    rawBody: true,
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  await configureApp(app);
  app.enableShutdownHooks();

  // 0.0.0.0 : dans le conteneur, écouter sur la boucle locale rendrait l'API
  // injoignable depuis le réseau de la stack (Fastify écoute sur 127.0.0.1 par défaut).
  await app.listen(Number(process.env.PORT ?? 3001), process.env.HOST ?? '0.0.0.0');
}

void bootstrap();
