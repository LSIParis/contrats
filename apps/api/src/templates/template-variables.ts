/** Extrait les noms de variables `{{ nom }}` d'un corps HTML (dédupliqués, triés). */
export function extractVariables(html: string): string[] {
  const names = new Set<string>();
  const re = /\{\{\s*([\w.]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) names.add(m[1]);
  return [...names].sort();
}

export function variablesSchemaOf(names: string[]) {
  const properties: Record<string, { type: 'string' }> = {};
  for (const n of names) properties[n] = { type: 'string' };
  return { type: 'object', properties, required: names };
}
