import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertKeyMatchesScope, type DocumentStorage, type ObjectScope } from './document-storage.port.js';

/**
 * Stockage S3-compatible (MinIO auto-hébergé ou OVH Object Storage). (§10.7)
 *
 * L'endpoint et `forcePathStyle` rendent l'adaptateur agnostique : MinIO en
 * dev, OVH en prod, sans changer le code.
 *
 * Le scope est dans le CHEMIN (assertKeyMatchesScope) et dupliqué en metadata
 * pour la traçabilité et les inventaires. Sur `get`, on vérifie que la
 * metadata correspond au scope demandé : défense en profondeur qui rattrape
 * partiellement l'absence de contexte KMS.
 */
@Injectable()
export class S3Storage implements DocumentStorage {
  private readonly log = new Logger(S3Storage.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const endpoint = process.env.S3_ENDPOINT;
    const region = process.env.S3_REGION ?? 'eu-west-3';
    const accessKeyId = process.env.S3_ACCESS_KEY;
    const secretAccessKey = process.env.S3_SECRET_KEY;
    this.bucket = process.env.S3_BUCKET ?? 'lsi-contrats';
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('S3_ACCESS_KEY / S3_SECRET_KEY absents');
    }
    this.client = new S3Client({
      region,
      endpoint, // undefined = AWS ; défini = MinIO/OVH
      forcePathStyle: !!endpoint, // MinIO exige le path-style
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async put(key: string, data: Buffer, scope: ObjectScope, contentType = 'application/octet-stream'): Promise<void> {
    assertKeyMatchesScope(key, scope);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        Metadata: { 'tenant-id': scope.tenantId, 'customer-id': scope.customerId },
      }),
    );
  }

  async get(key: string, scope: ObjectScope): Promise<Buffer | null> {
    assertKeyMatchesScope(key, scope);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      // Défense en profondeur : la metadata doit correspondre au scope demandé.
      const t = res.Metadata?.['tenant-id'];
      const c = res.Metadata?.['customer-id'];
      if (t !== scope.tenantId || c !== scope.customerId) {
        this.log.error(`ALERTE : ${key} lu avec un scope ne correspondant pas à sa metadata`);
        throw new Error('AccessDenied: metadata scope mismatch');
      }
      const bytes = await res.Body!.transformToByteArray();
      return Buffer.from(bytes);
    } catch (e: any) {
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async presignedGetUrl(key: string, scope: ObjectScope, ttlSeconds: number): Promise<string> {
    assertKeyMatchesScope(key, scope);
    // URL présignée à durée courte : un secret porteur, sa vie doit valoir le
    // temps d'un téléchargement, pas d'une session (§10.7).
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }
}
