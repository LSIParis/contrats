import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';
import { buildOpenApi, OPERATIONS } from './openapi.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Description et documentation de l'API publique — sans authentification
 * (elles ne contiennent aucune donnée). La documentation navigable est
 * rendue CÔTÉ SERVEUR, sans script ni ressource externe : compatible avec
 * la CSP de l'application et consultable hors ligne.
 */
@Public()
@Controller('api/v1')
export class OpenApiController {
  private readonly spec = buildOpenApi(process.env.APP_URL ?? 'https://contrats.lsi-maintenance.fr');

  @Get('openapi.json')
  openapi() {
    return this.spec;
  }

  @Get('docs')
  @Header('content-type', 'text/html; charset=utf-8')
  docs(): string {
    const schemas = this.spec.components.schemas;
    const ops = OPERATIONS.map((op) => {
      const o = (this.spec.paths[op.path] as Record<string, { parameters: { name: string; in: string; required: boolean; description?: string }[] }>)[op.method]!;
      const params = o.parameters
        .map((p) => `<tr><td><code>${esc(p.name)}</code></td><td>${p.in}</td><td>${p.required ? 'oui' : 'non'}</td><td>${esc(p.description ?? '')}</td></tr>`)
        .join('');
      return `<section id="${op.operationId}">
<h3><span class="m ${op.method}">${op.method.toUpperCase()}</span> <code>${esc(op.path)}</code></h3>
<p>${esc(op.summary)}${op.description ? `<br><small>${esc(op.description)}</small>` : ''}</p>
<p>Scope requis : <code>${op.scope}</code>${op.paginated ? ' · paginé par curseur' : ''}${op.etag ? ' · ETag' : ''}</p>
${params ? `<table><thead><tr><th>Paramètre</th><th>Où</th><th>Requis</th><th>Description</th></tr></thead><tbody>${params}</tbody></table>` : ''}
${op.body ? `<p>Corps : <a href="#schema-${op.body}"><code>${op.body}</code></a></p>` : ''}
<p>Réponse : <a href="#schema-${op.response}"><code>${op.response}</code></a> — erreurs : <a href="#schema-Problem"><code>Problem</code></a></p>
</section>`;
    }).join('\n');
    const defs = Object.entries(schemas)
      .map(([name, s]) => `<section id="schema-${name}"><h3>${name}</h3><pre>${esc(JSON.stringify(s, null, 2))}</pre></section>`)
      .join('\n');
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API Contrats — documentation</title>
<style>
:root{--bg:#fff;--fg:#1f2937;--muted:#6b7280;--line:#e5e7eb;--code:#f3f4f6;--accent:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#111827;--fg:#e5e7eb;--muted:#9ca3af;--line:#374151;--code:#1f2937;--accent:#93c5fd}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px}h1{margin:0 0 4px}h2{margin-top:40px;border-bottom:1px solid var(--line);padding-bottom:6px}
section{border-bottom:1px solid var(--line);padding:8px 0 16px}code,pre{background:var(--code);border-radius:4px;font:13px ui-monospace,Consolas,monospace}
code{padding:1px 4px}pre{padding:12px;overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid var(--line);padding:4px 8px;text-align:left}
.m{display:inline-block;min-width:58px;text-align:center;border-radius:4px;color:#fff;font-size:12px;padding:2px 6px}.get{background:#15803d}.post{background:#1d4ed8}.delete{background:#b91c1c}
a{color:var(--accent)}small{color:var(--muted)}nav a{margin-right:12px}
</style></head><body><main>
<h1>${esc(this.spec.info.title)} <small>v${esc(this.spec.info.version)}</small></h1>
<p>${esc(this.spec.info.description)}</p>
<nav><a href="openapi.json">openapi.json</a>${OPERATIONS.map((o) => `<a href="#${o.operationId}">${o.operationId}</a>`).join('')}</nav>
<h2>Authentification</h2>
<p><code>Authorization: Bearer ctr_&lt;prefix&gt;_&lt;secret&gt;</code>. Clé créée par un administrateur, affichée une seule fois, stockée hachée. Débit limité par client (en-têtes <code>RateLimit-*</code>, <code>Retry-After</code>).</p>
<h2>Opérations</h2>
${ops}
<h2>Schémas</h2>
${defs}
</main></body></html>`;
  }
}
