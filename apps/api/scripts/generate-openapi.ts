/**
 * Génère, depuis les schémas Zod de l'API publique (src/public-api/openapi.ts) :
 *   1. `openapi.yaml` à la racine du dépôt (description OpenAPI 3.1) ;
 *   2. `packages/contrats-client/src/generated.ts` (types + méthodes du client).
 *
 *   pnpm openapi:generate          # écrit les fichiers
 *   pnpm openapi:generate --check  # échoue s'ils ne sont pas à jour (CI)
 *
 * Aucune dépendance de génération tierce : le sous-ensemble de JSON Schema
 * produit par `z.toJSONSchema` est petit et connu.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { buildOpenApi, OPERATIONS } from '../src/public-api/openapi.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const spec = buildOpenApi();

type Js = Record<string, unknown>;

/** JSON Schema (sous-ensemble zod) → type TypeScript. */
export function tsType(s: Js | boolean | undefined, indent = ''): string {
  if (s === undefined || s === true || (typeof s === 'object' && Object.keys(s).filter((k) => k !== 'description').length === 0)) return 'unknown';
  if (s === false) return 'never';
  if (typeof s.$ref === 'string') return s.$ref.split('/').pop()!;
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  if ('const' in s) return JSON.stringify(s.const);
  const union = (s.anyOf ?? s.oneOf) as Js[] | undefined;
  if (union) return union.map((u) => tsType(u, indent)).join(' | ');
  if (Array.isArray(s.type)) return s.type.map((t) => tsType({ ...s, type: t }, indent)).join(' | ');
  switch (s.type) {
    case 'string': return 'string';
    case 'integer':
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': return `Array<${tsType(s.items as Js, indent)}>`;
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, Js>;
      const required = new Set((s.required ?? []) as string[]);
      const inner = `${indent}  `;
      const lines = Object.entries(props).map(([k, v]) => {
        const doc = typeof v.description === 'string' ? `${inner}/** ${v.description.replace(/\*\//g, '*\\/')} */\n` : '';
        return `${doc}${inner}${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${required.has(k) ? '' : '?'}: ${tsType(v, inner)};`;
      });
      const extra = s.additionalProperties;
      // Objet « ouvert » (z.looseObject) : propriétés supplémentaires non typées.
      if (extra !== undefined && extra !== false) lines.push(`${inner}[key: string]: unknown;`);
      return lines.length ? `{\n${lines.join('\n')}\n${indent}}` : 'Record<string, unknown>';
    }
    default: return 'unknown';
  }
}

function generateClient(): string {
  const out: string[] = [
    '// Fichier GÉNÉRÉ par apps/api/scripts/generate-openapi.ts — ne pas modifier à la main.',
    `// API Contrats ${spec.info.version} (OpenAPI ${spec.openapi}).`,
    '',
  ];
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    const desc = (schema as Js).description;
    if (typeof desc === 'string') out.push(`/** ${desc} */`);
    out.push(`export type ${name} = ${tsType(schema as Js)};`, '');
  }
  out.push(
    'export interface Transport {',
    '  request<T>(method: string, path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown }): Promise<T>;',
    '}',
    '',
    'export class ContratsOperations {',
    '  constructor(protected readonly transport: Transport) {}',
  );
  for (const op of OPERATIONS) {
    const pathParams = Object.keys(op.pathParams ?? {});
    const args: string[] = pathParams.map((p) => `${p}: string`);
    const queryShape = op.query
      ? Object.entries(op.query.shape).map(([k, v]) => {
          const opt = (v as { safeParse: (x: unknown) => { success: boolean } }).safeParse(undefined).success;
          const ts = k === 'limit' ? 'number' : 'string';
          return `${k}${opt ? '?' : ''}: ${ts}`;
        })
      : [];
    if (queryShape.length) args.push(`query: { ${queryShape.join('; ')} } = {}`);
    if (op.body) args.push(`body: ${op.body}`);
    const path = op.path.replace(/\{(\w+)\}/g, (_m, p: string) => `\${encodeURIComponent(${p})}`);
    out.push(
      '',
      `  /** ${op.summary} — scope \`${op.scope}\`. */`,
      `  ${op.operationId}(${args.join(', ')}): Promise<${op.response}> {`,
      `    return this.transport.request<${op.response}>('${op.method.toUpperCase()}', \`${path}\`, {${queryShape.length ? ' query,' : ''}${op.body ? ' body,' : ''} });`,
      '  }',
    );
  }
  out.push('}', '');
  return out.join('\n');
}

const files: [string, string][] = [
  [resolve(root, 'openapi.yaml'), `# Fichier GÉNÉRÉ (pnpm openapi:generate) depuis apps/api/src/public-api — ne pas modifier à la main.\n${stringify(spec, { lineWidth: 0 })}`],
  [resolve(root, 'packages/contrats-client/src/generated.ts'), generateClient()],
];

const check = process.argv.includes('--check');
let stale = 0;
for (const [file, content] of files) {
  if (check) {
    let current = '';
    try { current = readFileSync(file, 'utf8'); } catch { /* absent */ }
    if (current.replace(/\r\n/g, '\n') !== content) {
      console.error(`✖ ${file} n'est pas à jour : lancez « pnpm openapi:generate ».`);
      stale++;
    }
  } else {
    writeFileSync(file, content, 'utf8');
    console.log(`✔ ${file}`);
  }
}
if (stale) process.exit(1);
