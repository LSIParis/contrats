import { BadRequestException, Injectable } from '@nestjs/common';
import { withScope, type Scope } from '@lsi/persistence';
import {
  FEATURE_FLAGS, SETTINGS, isFeatureFlag, isSettingKey,
  type FeatureFlag, type SettingKey, type SettingValue,
} from './tenant-config.js';

/**
 * Lecture / écriture des feature flags et paramètres du tenant courant.
 *
 * Le tenant vient TOUJOURS du scope de session (RLS), jamais du chemin ni du
 * corps : il n'existe pas de paramètre `tenantId` à falsifier.
 */
@Injectable()
export class TenantConfigService {
  async flags(scope: Scope): Promise<Record<FeatureFlag, boolean>> {
    const rows = await withScope(scope, (tx) => tx.tenantFeatureFlag.findMany({ where: { tenantId: scope.tenantId } }));
    const out = Object.fromEntries(Object.keys(FEATURE_FLAGS).map((k) => [k, false])) as Record<FeatureFlag, boolean>;
    for (const r of rows) if (isFeatureFlag(r.key)) out[r.key] = r.enabled;
    return out;
  }

  async isEnabled(scope: Scope, flag: FeatureFlag): Promise<boolean> {
    const row = await withScope(scope, (tx) =>
      tx.tenantFeatureFlag.findUnique({ where: { tenantId_key: { tenantId: scope.tenantId, key: flag } } }),
    );
    return row?.enabled ?? false;
  }

  async setFlag(scope: Scope, key: string, enabled: boolean, now: Date): Promise<{ key: FeatureFlag; enabled: boolean }> {
    if (!isFeatureFlag(key)) throw new BadRequestException(`Drapeau inconnu : ${key}`);
    await withScope(scope, (tx) =>
      tx.tenantFeatureFlag.upsert({
        where: { tenantId_key: { tenantId: scope.tenantId, key } },
        create: { tenantId: scope.tenantId, key, enabled, updatedAt: now, updatedByUserId: userOrNull(scope) },
        update: { enabled, updatedAt: now, updatedByUserId: userOrNull(scope) },
      }),
    );
    return { key, enabled };
  }

  async settings(scope: Scope): Promise<Record<SettingKey, unknown>> {
    const rows = await withScope(scope, (tx) => tx.tenantSetting.findMany({ where: { tenantId: scope.tenantId } }));
    const out = Object.fromEntries(Object.entries(SETTINGS).map(([k, d]) => [k, d.default])) as Record<SettingKey, unknown>;
    for (const r of rows) {
      // Une valeur stockée qui ne respecte plus le schéma (schéma durci depuis)
      // retombe sur le défaut plutôt que de propager une valeur invalide.
      if (isSettingKey(r.key) && SETTINGS[r.key].schema.safeParse(r.value).success) out[r.key] = r.value;
    }
    return out;
  }

  async setting<K extends SettingKey>(scope: Scope, key: K): Promise<SettingValue<K>> {
    return (await this.settings(scope))[key] as SettingValue<K>;
  }

  async setSetting(scope: Scope, key: string, value: unknown, now: Date): Promise<{ key: SettingKey; value: unknown }> {
    if (!isSettingKey(key)) throw new BadRequestException(`Paramètre inconnu : ${key}`);
    const parsed = SETTINGS[key].schema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: parsed.error.issues.map((i) => `${key}${i.path.length ? '.' + i.path.join('.') : ''} : ${i.message}`),
      });
    }
    const json = parsed.data as never;
    await withScope(scope, (tx) =>
      tx.tenantSetting.upsert({
        where: { tenantId_key: { tenantId: scope.tenantId, key } },
        create: { tenantId: scope.tenantId, key, value: json, updatedAt: now, updatedByUserId: userOrNull(scope) },
        update: { value: json, updatedAt: now, updatedByUserId: userOrNull(scope) },
      }),
    );
    return { key, value: parsed.data };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function userOrNull(scope: Scope): string | null {
  return UUID.test(scope.userId) ? scope.userId : null;
}
