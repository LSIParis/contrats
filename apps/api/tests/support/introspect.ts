import { RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
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
 * Énumère les routes déclarées par les contrôleurs RÉELLEMENT enregistrés
 * dans l'application (conteneur de modules Nest).
 *
 * On lit les métadonnées de routage de Nest plutôt qu'une liste écrite à la
 * main : une liste manuelle serait à jour le jour où on l'écrit, et fausse le
 * lendemain. (Avant la bascule Fastify, on lisait le routeur Express ; lire
 * les métadonnées Nest rend l'outil indépendant de l'adaptateur HTTP.)
 */
export function listRoutes(app: INestApplication): RouteInfo[] {
  const modules = app.get(ModulesContainer);
  const scanner = new MetadataScanner();
  const out: RouteInfo[] = [];
  for (const mod of modules.values()) {
    for (const wrapper of mod.controllers.values()) {
      const ctrl = wrapper.metatype as Function | null;
      if (!ctrl || !wrapper.instance) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '');
      const proto = Object.getPrototypeOf(wrapper.instance) as Record<string, Function>;
      for (const name of scanner.getAllMethodNames(proto)) {
        const handler = proto[name]!;
        const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
        if (sub === undefined) continue;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
        for (const p of Array.isArray(sub) ? sub : [sub]) {
          const routePath = '/' + [base, p].map((x) => x.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
          out.push({ method: String(method).toUpperCase(), path: routePath, handler, controller: ctrl });
        }
      }
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
