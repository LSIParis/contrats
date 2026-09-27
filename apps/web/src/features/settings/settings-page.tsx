import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPut, ApiError } from '../../lib/api.js';
import { useMe } from '../../lib/queries.js';
import { can } from '../../lib/permissions.js';
import { Breadcrumb } from '../../ui/breadcrumb.js';
import { Button } from '../../ui/button.js';
import { Card } from '../../ui/card.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { Spinner } from '../../ui/spinner.js';
import { useToast } from '../../ui/toast.js';
import { SettingsNav } from './settings-nav.js';
import { AiUsageCard } from './ai-usage-card.js';

export { AiUsageCard };

/**
 * Paramètres du tenant (MSP_ADMIN, action `tenant.configure`) :
 *   - feature flags : `GET /v1/feature-flags` → `{ flags, descriptions }`,
 *     `PUT /v1/admin/feature-flags/:key { enabled }` ;
 *   - paramètres : `GET /v1/admin/settings` → `{ settings }`,
 *     `PUT /v1/admin/settings/:key { value }` (validé par Zod côté API, erreurs 400 affichées).
 */

interface FlagsResponse { flags: Record<string, boolean>; descriptions: Record<string, string> }

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

function FlagRow({ flag, enabled, description }: { flag: string; enabled: boolean; description: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: (next: boolean) =>
      apiPut<{ key: string; enabled: boolean }>(`/v1/admin/feature-flags/${encodeURIComponent(flag)}`, { enabled: next }),
    onSuccess: (r) => {
      toast.show(`« ${r.key} » ${r.enabled ? 'activé' : 'désactivé'}.`, 'success');
      void qc.invalidateQueries({ queryKey: ['feature-flags'] });
    },
  });
  const id = `flag-${flag.replace(/[^a-z0-9]/gi, '-')}`;
  const on = m.isPending ? Boolean(m.variables) : enabled;
  return (
    <li className="flex items-start gap-3 border-b border-line py-3 last:border-b-0">
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="mt-1 h-4 w-4 accent-[var(--primary)]"
        checked={on}
        disabled={m.isPending}
        aria-describedby={`${id}-desc`}
        onChange={(e) => m.mutate(e.target.checked)}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="font-medium text-ink">
          <code>{flag}</code> — {on ? 'activé' : 'désactivé'}
        </label>
        <p id={`${id}-desc`} className="text-13 text-ink-muted">{description}</p>
        {m.error && (
          <p role="alert" className="text-13 text-danger">
            {m.error instanceof ApiError ? m.error.message : 'Échec de la mise à jour.'}
          </p>
        )}
      </div>
    </li>
  );
}

export function FeatureFlagsCard() {
  const q = useQuery({ queryKey: ['feature-flags'], queryFn: () => apiGet<FlagsResponse>('/v1/feature-flags') });
  return (
    <Card title="Fonctionnalités (feature flags)">
      {q.isLoading ? (
        <Spinner />
      ) : q.error || !q.data ? (
        <p role="alert" className="text-danger">Drapeaux indisponibles.</p>
      ) : (
        <ul>
          {Object.entries(q.data.flags).map(([k, v]) => (
            <FlagRow key={k} flag={k} enabled={v} description={q.data.descriptions[k] ?? ''} />
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Paramètres
// ---------------------------------------------------------------------------

type Kind =
  | { type: 'select'; options: Array<[string, string]> }
  | { type: 'text'; nullable: true }
  | { type: 'number'; nullable?: boolean; integer?: boolean }
  | { type: 'list' };

interface SettingDef { key: string; label: string; hint?: string; kind: Kind }

export const SETTING_DEFS: SettingDef[] = [
  { key: 'ai.provider', label: 'Fournisseur IA', kind: { type: 'select', options: [['perplexity', 'Perplexity'], ['claude', 'Claude']] } },
  { key: 'ai.model', label: 'Modèle IA', hint: 'Vide : modèle par défaut du fournisseur.', kind: { type: 'text', nullable: true } },
  { key: 'ai.preset', label: 'Preset IA', hint: 'Vide : aucun preset.', kind: { type: 'text', nullable: true } },
  { key: 'ai.monthlyBudgetUsd', label: 'Budget IA mensuel (USD)', hint: 'Vide : illimité.', kind: { type: 'number', nullable: true } },
  { key: 'alerts.thresholdsDays', label: 'Seuils d’alerte des échéances (jours)', hint: 'Liste séparée par des virgules, ex. 90, 60, 30, 7.', kind: { type: 'list' } },
  {
    key: 'pricing.rounding', label: 'Arrondi des prix au centime',
    kind: { type: 'select', options: [['HALF_AWAY_FROM_ZERO', 'Au plus proche, demi vers l’extérieur'], ['HALF_EVEN', 'Au plus proche, demi au pair (bancaire)']] },
  },
  { key: 'pricing.overrideApprovalThresholdPercent', label: 'Seuil de seconde validation d’une dérogation tarifaire (%)', kind: { type: 'number' } },
  {
    key: 'pricing.unitPriceScale', label: 'Décimales du prix unitaire calculé',
    hint: 'De 0 à 6 (révision, formule, règles). Les totaux restent arrondis au centime.', kind: { type: 'number', integer: true },
  },
  {
    key: 'pricing.indexLookup', label: 'Recherche des valeurs d’indice par défaut',
    kind: { type: 'select', options: [['LATEST_PUBLISHED', 'Dernière valeur publiée à la date'], ['EXACT_PERIOD', 'Valeur de la période exacte']] },
  },
  {
    key: 'signature.defaultOrder', label: 'Ordre de signature par défaut',
    kind: { type: 'select', options: [['CLIENT_FIRST', 'Client puis LSI'], ['LSI_FIRST', 'LSI puis client']] },
  },
  { key: 'signature.expireDays', label: 'Expiration d’une demande de signature (jours)', kind: { type: 'number', integer: true } },
  { key: 'retention.yearsAfterEnd', label: 'Conservation après la fin du contrat (années)', kind: { type: 'number', integer: true } },
];

export function toInput(value: unknown, kind: Kind): string {
  if (value == null) return '';
  if (kind.type === 'list') return Array.isArray(value) ? value.join(', ') : String(value);
  if (kind.type === 'number') return String(value).replace('.', ',');
  return String(value);
}

/** Saisie → valeur JSON. Seule la FORME est contrôlée ici ; les bornes sont celles de l'API. */
export function fromInput(raw: string, kind: Kind): { value: unknown } | { error: string } {
  const t = raw.trim();
  switch (kind.type) {
    case 'select':
      return { value: t };
    case 'text':
      return { value: t === '' ? null : t };
    case 'number': {
      if (t === '') return kind.nullable ? { value: null } : { error: 'Valeur obligatoire.' };
      const n = Number(t.replace(',', '.'));
      if (!Number.isFinite(n)) return { error: 'Nombre attendu.' };
      return { value: n };
    }
    case 'list': {
      const parts = t.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      const nums = parts.map(Number);
      if (nums.some((n) => !Number.isFinite(n))) return { error: 'Liste de nombres attendue (ex. 90, 60, 30, 7).' };
      return { value: nums };
    }
  }
}

const sid = (key: string) => `setting-${key.replace(/\./g, '-')}`;

export function TenantSettingsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => apiGet<{ settings: Record<string, unknown> }>('/v1/admin/settings'),
  });
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!q.data) return;
    setValues(Object.fromEntries(SETTING_DEFS.map((d) => [d.key, toInput(q.data.settings[d.key], d.kind)])));
  }, [q.data]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!q.data) return;
    const nextErrors: Record<string, string> = {};
    let saved = 0;
    setSaving(true);
    for (const d of SETTING_DEFS) {
      const raw = values[d.key] ?? '';
      if (raw === toInput(q.data.settings[d.key], d.kind)) continue; // inchangé
      const parsed = fromInput(raw, d.kind);
      if ('error' in parsed) {
        nextErrors[d.key] = parsed.error;
        continue;
      }
      try {
        await apiPut(`/v1/admin/settings/${encodeURIComponent(d.key)}`, { value: parsed.value });
        saved++;
      } catch (err) {
        nextErrors[d.key] = err instanceof ApiError ? err.message : 'Échec de l’enregistrement.';
      }
    }
    setSaving(false);
    setErrors(nextErrors);
    if (saved) {
      toast.show(`${saved} paramètre(s) enregistré(s).`, 'success');
      await qc.invalidateQueries({ queryKey: ['admin-settings'] });
    }
    const first = SETTING_DEFS.find((d) => nextErrors[d.key]);
    if (first) document.getElementById(sid(first.key))?.focus();
  }

  if (q.isLoading) return <Card title="Paramètres du tenant"><Spinner /></Card>;
  if (q.error || !q.data) return <Card title="Paramètres du tenant"><p role="alert" className="text-danger">Paramètres indisponibles.</p></Card>;

  return (
    <Card title="Paramètres du tenant">
      <form noValidate onSubmit={handleSubmit} className="flex max-w-2xl flex-col gap-4">
        {SETTING_DEFS.map((d) => {
          const id = sid(d.key);
          const v = values[d.key] ?? '';
          const onChange = (e: { target: { value: string } }) => setValues((s) => ({ ...s, [d.key]: e.target.value }));
          return (
            <Field key={d.key} label={`${d.label} (${d.key})`} htmlFor={id} hint={d.hint} error={errors[d.key]}>
              {d.kind.type === 'select' ? (
                <Select id={id} value={v} onChange={onChange}>
                  {d.kind.options.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
                </Select>
              ) : (
                <Input id={id} value={v} onChange={onChange} inputMode={d.kind.type === 'number' ? 'decimal' : undefined} />
              )}
            </Field>
          );
        })}
        <div>
          <Button type="submit" disabled={saving}>{saving ? 'Enregistrement…' : 'Enregistrer les paramètres'}</Button>
        </div>
      </form>
    </Card>
  );
}

export function SettingsPage() {
  const me = useMe();
  if (me.isLoading) return <Spinner />;
  if (!can(me.data?.roles, 'tenant.configure')) {
    return <p role="alert" className="text-danger">Accès réservé aux administrateurs.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[{ label: 'Administration' }, { label: 'Paramètres' }]} />
      <h1>Paramètres</h1>
      <SettingsNav />
      <FeatureFlagsCard />
      <TenantSettingsCard />
      <AiUsageCard />
    </div>
  );
}
