import { Badge } from '../../ui/badge.js';
import { Field } from '../../ui/field.js';
import { Input, controlClass } from '../../ui/input.js';
import type { VariableRow } from './variables.js';

const INPUT_TYPE: Record<string, string> = { date: 'date', integer: 'number' };

/**
 * Variables utilisées par le document, avec leur définition du registre.
 * Une variable sans valeur est SURLIGNÉE : elle devient « [à compléter] » dans
 * le document et bloque la soumission en revue interne (V2-VAR).
 */
export function VariablesPanel({ rows, onChange, readOnly = false }: {
  rows: VariableRow[];
  onChange?: (name: string, value: string) => void;
  readOnly?: boolean;
}) {
  if (rows.length === 0) return <p className="text-sm text-ink-faint">Le document n’utilise aucune variable.</p>;
  const missing = rows.filter((r) => r.missing).length;
  return (
    <div className="flex flex-col gap-3">
      <p className={`text-sm ${missing ? 'text-warn' : 'text-success'}`} role="status">
        {missing ? `${missing} variable(s) à compléter avant la soumission en revue interne.` : 'Toutes les variables sont renseignées.'}
      </p>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => {
          const id = `var-${r.name.replace(/\W/g, '-')}`;
          return (
            <li key={r.name} className={`rounded border px-3 py-2 ${r.missing ? 'border-warn bg-warn-bg' : 'border-line'}`}>
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                <code className="text-ink-faint">{`{{${r.name}}}`}</code>
                {r.missing && <Badge tone="warn">À compléter</Badge>}
                {r.unknown && <Badge tone="danger">Inconnue du registre</Badge>}
              </div>
              {readOnly ? (
                <p className="text-sm"><span className="text-ink-muted">{r.label} : </span>{r.value || '—'}</p>
              ) : (
                <Field label={r.label} htmlFor={id} hint={r.unknown ? 'Variable non déclarée : l’enregistrement sera refusé. Corrigez son nom dans le texte.' : undefined}>
                  {r.type === 'text' ? (
                    <textarea id={id} rows={2} className={controlClass} value={r.value} onChange={(e) => onChange?.(r.name, e.target.value)} />
                  ) : (
                    <Input id={id} type={INPUT_TYPE[r.type] ?? 'text'} value={r.value}
                      inputMode={r.type === 'money' ? 'decimal' : r.type === 'siren' ? 'numeric' : undefined}
                      placeholder={r.type === 'siren' ? '9 chiffres' : r.type === 'money' ? '1500.00' : undefined}
                      onChange={(e) => onChange?.(r.name, e.target.value)} />
                  )}
                </Field>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
