import type { INestApplication } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RouteInfo {
  method: string;
  path: string;
  handler: Function;
  controller: Function;
}

/**
 * Énumère les routes réellement montées, depuis le routeur Express.
 *
 * On lit le routeur plutôt qu'une liste écrite à la main : une liste
 * manuelle serait à jour le jour où on l'écrit, et fausse le lendemain.
 */
export function listRoutes(app: INestApplication): RouteInfo[] {
  const server = app.getHttpServer();
  const router = server._events?.request?._router ?? server._router;
  const stack: any[] = router?.stack ?? [];
  const out: RouteInfo[] = [];

  for (const layer of stack) {
    if (!layer.route) continue;
    const routePath: string = layer.route.path;
    for (const l of layer.route.stack ?? []) {
      out.push({
        method: (l.method ?? 'get').toUpperCase(),
        path: routePath,
        handler: l.handle,
        controller: l.handle,
      });
    }
  }
  return out;
}

export interface DtoProperty {
  dto: string;
  property: string;
}

/**
 * Extrait les propriétés déclarées dans les DTO d'entrée, par lecture du
 * source. (§16.4-D)
 *
 * Analyse statique volontaire plutôt qu'introspection des métadonnées :
 * class-validator n'enregistre que les propriétés DÉCORÉES. Un champ
 * `tenantId!: string` sans décorateur serait invisible aux métadonnées —
 * et c'est précisément le cas qu'on veut attraper, puisqu'il traverserait
 * quand même si le DTO n'a pas `forbidNonWhitelisted`.
 */
export async function collectDtoProperties(): Promise<DtoProperty[]> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const srcRoot = path.resolve(here, '../../src');
  const files = await walk(srcRoot);
  const dtoFiles = files.filter((f) => f.endsWith('.dto.ts'));

  const out: DtoProperty[] = [];
  for (const file of dtoFiles) {
    const src = await readFile(file, 'utf8');
    const dtoName = path.basename(file);
    // Propriétés de classe : `  nom!: type;` ou `  nom?: type;`
    for (const m of src.matchAll(/^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)[?!]?\s*:/gm)) {
      const prop = m[1]!;
      if (['constructor'].includes(prop)) continue;
      out.push({ dto: dtoName, property: prop });
    }
  }
  return out;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walk(full)));
    else if (e.isFile()) files.push(full);
  }
  return files;
}
