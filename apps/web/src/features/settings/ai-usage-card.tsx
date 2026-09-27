import { useId, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest, errorText } from '../../lib/api.js';
import { Button } from '../../ui/button.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { ErrorNote, RegionCard } from '../../ui/region-card.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';

/**
 * Usage de l'IA par tenant (05-ia-perplexity.md §13, §16) :
 * `GET /v1/ai/availability` (état : drapeau, fournisseur, clé, budget) et
 * `GET /v1/admin/ai/usage?month=AAAA-MM` (synthèse du mois civil UTC). Les
 * coûts sont en USD, tels que renvoyés par le fournisseur (un appel Claude
 * n'a pas de coût communiqué : suivre ses jetons).
 */
interface Availability { enabled: boolean; provider: string; configured: boolean; budgetUsd: number | null; spentUsd: number; available: boolean }
interface UsageLine { operation: string; provider: string; status: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }
interface Usage { month: string; totalCostUsd: number; totalCalls: number; budgetUsd: number | null; lines: UsageLine[] }

const OPERATIONS: Record<string, string> = {
  draft: 'Rédaction', rephrase: 'Reformulation', harden: 'Durcissement', explain: 'Explication', compare: 'Comparaison',
  missing: 'Clauses manquantes', import_extract: 'Extraction à l’import',
};
const STATUSES: Record<string, string> = {
  OK: 'Réussi', AUTH: 'Authentification refusée', RATE_LIMIT: 'Limite de débit', TIMEOUT: 'Délai dépassé',
  SCHEMA_VIOLATION: 'Réponse hors schéma', UPSTREAM: 'Erreur du fournisseur', LEAK_BLOCKED: 'Fuite bloquée (pseudonymisation)',
};
const PROVIDERS: Record<string, string> = { perplexity: 'Perplexity', claude: 'Claude' };

const usd = (n: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(n);
const int = (n: number) => new Intl.NumberFormat('fr-FR').format(n);
const currentMonth = () => new Date().toISOString().slice(0, 7);

export function AiUsageCard() {
  const uid = useId();
  const [input, setInput] = useState(currentMonth());
  const [month, setMonth] = useState(currentMonth());
  const [formError, setFormError] = useState<string>();
  const avail = useQuery({ queryKey: ['ai-availability'], queryFn: () => apiRequest<Availability>('GET', '/v1/ai/availability') });
  const q = useQuery({
    queryKey: ['ai-usage', month],
    queryFn: () => apiRequest<Usage>('GET', `/v1/admin/ai/usage?month=${encodeURIComponent(month)}`),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.trim())) return setFormError('Mois attendu au format AAAA-MM.');
    setFormError(undefined);
    setMonth(input.trim());
  }

  const a = avail.data;
  const u = q.data;
  const pct = u && u.budgetUsd ? Math.round((u.totalCostUsd / u.budgetUsd) * 100) : null;
  return (
    <RegionCard title="Usage de l’IA">
      {a && (
        <p className="text-sm text-ink">
          {a.enabled ? '' : 'Assistance IA désactivée (drapeau contrats.ai.enabled). '}
          Fournisseur : {PROVIDERS[a.provider] ?? a.provider} — {a.configured ? 'clé configurée' : 'clé absente (secret à fournir)'} —{' '}
          {a.available ? 'disponible' : 'indisponible'}.
        </p>
      )}
      <form noValidate onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <Field label="Mois (AAAA-MM)" htmlFor={`${uid}-month`}>
          <Input id={`${uid}-month`} value={input} onChange={(e) => setInput(e.target.value)} className="w-32" />
        </Field>
        <Button type="submit" variant="secondary">Afficher</Button>
      </form>
      <ErrorNote>{formError ?? errorText(q.error)}</ErrorNote>
      {q.isLoading && <Spinner />}
      {u && (
        <>
          <p className="text-sm text-ink">
            {u.month} : <strong>{int(u.totalCalls)}</strong> appel(s), coût <strong>{usd(u.totalCostUsd)}</strong>
            {u.budgetUsd === null ? ' — budget illimité.' : ` sur un budget de ${usd(u.budgetUsd)}.`}
          </p>
          {pct !== null && (
            <div className="flex items-center gap-3">
              <div
                role="progressbar"
                aria-label="Budget IA consommé"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.min(pct, 100)}
                aria-valuetext={`${pct} %`}
                className="h-2.5 w-full max-w-md overflow-hidden rounded-full bg-slate-100"
              >
                <div
                  className={`h-full ${pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warn' : 'bg-primary'}`}
                  style={{ width: `${Math.min(pct, 100)}%` }}
                />
              </div>
              <span className="text-13 text-ink-muted">{pct} %{pct >= 100 ? ' — budget atteint : les appels sont refusés' : ''}</span>
            </div>
          )}
          {u.lines.length === 0 ? (
            <p className="text-13 text-ink-faint">Aucun appel ce mois-ci.</p>
          ) : (
            <Table
              caption="Appels IA du mois"
              head={<tr><th>Opération</th><th>Fournisseur</th><th>Statut</th><th>Appels</th><th>Jetons entrée</th><th>Jetons sortie</th><th>Coût</th></tr>}
            >
              {u.lines.map((l) => (
                <tr key={`${l.operation}-${l.provider}-${l.status}`}>
                  <td>{OPERATIONS[l.operation] ?? l.operation}</td>
                  <td>{PROVIDERS[l.provider] ?? l.provider}</td>
                  <td>{STATUSES[l.status] ?? l.status}</td>
                  <td className="tabular-nums">{int(l.calls)}</td>
                  <td className="tabular-nums">{int(l.inputTokens)}</td>
                  <td className="tabular-nums">{int(l.outputTokens)}</td>
                  <td className="tabular-nums">{usd(l.costUsd)}</td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}
    </RegionCard>
  );
}
