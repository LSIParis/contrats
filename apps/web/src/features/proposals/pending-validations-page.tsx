import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../lib/api.js';
import { formatEuros } from '../../lib/money.js';
import { useMe } from '../../lib/queries.js';
import { can } from '../../lib/permissions.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { Card } from '../../ui/card.js';
import { Modal } from '../../ui/modal.js';
import { Spinner } from '../../ui/spinner.js';
import { useToast } from '../../ui/toast.js';

/**
 * Écran « Prix à valider » (annexe C, règle 7) : lignes, règles, sections et choix
 * encore `TO_VALIDATE` dans les modèles de proposition. Valider est une action
 * d'administrateur, tracée dans le journal d'audit ; le modèle devient alors propre
 * au tenant (le seed ne le réécrira plus, sauf `--force`).
 */
type Scope = 'LINE' | 'RULE' | 'SECTION' | 'CHOICE';
interface PendingItem {
  scope: Scope; key: string; label: string; choiceValue?: string; templateSlug: string; templateName: string;
  detail:
    | null
    | { unit?: string; pricing?: { unitPriceCents: number } | { dependsOn: string; byChoice: Record<string, number> }; priceSource?: string | null }
    | { amountCents: number; priceSource?: string | null }
    | { percent: number };
}
interface PendingList { items: PendingItem[]; total: number }

const SCOPE_LABEL: Record<Scope, string> = { LINE: 'Ligne de prix', RULE: 'Règle', SECTION: 'Section', CHOICE: 'Choix' };
const ENDPOINT = '/v1/proposal-admin/pending-validations';

function priceOf(item: PendingItem): string {
  const d = item.detail as Record<string, any> | null;
  if (!d) return '—';
  if (typeof d.amountCents === 'number') return `${formatEuros(d.amountCents)} HT / mois`;
  if (typeof d.percent === 'number') return `${d.percent} %`;
  const p = d.pricing;
  if (!p) return '—';
  const unit = d.unit ? ` / ${d.unit}` : '';
  if (typeof p.unitPriceCents === 'number') return `${formatEuros(p.unitPriceCents)} HT${unit}`;
  const byChoice = p.byChoice as Record<string, number>;
  if (item.choiceValue !== undefined && byChoice[item.choiceValue] !== undefined) {
    return `${formatEuros(byChoice[item.choiceValue]!)} HT${unit} (${item.choiceValue})`;
  }
  return Object.entries(byChoice).map(([k, v]) => `${k} : ${formatEuros(v)}`).join(' · ') + ` HT${unit}`;
}

export function PendingValidationsPage() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const allowed = can(me.data?.roles, 'proposals.prices.validate');
  const q = useQuery({ queryKey: ['proposal-pending'], queryFn: () => apiGet<PendingList>(ENDPOINT), enabled: allowed });
  const [target, setTarget] = useState<PendingItem | null>(null);
  const validate = useMutation({
    mutationFn: (i: PendingItem) =>
      apiPost<PendingList>(`${ENDPOINT}/validate`, {
        templateSlug: i.templateSlug, scope: i.scope, key: i.key, ...(i.choiceValue !== undefined ? { choiceValue: i.choiceValue } : {}),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['proposal-pending'], data);
      void qc.invalidateQueries({ queryKey: ['proposal-pending'] });
      toast.show('Élément validé et tracé dans le journal d’audit.');
      setTarget(null);
    },
    onError: (e) => toast.show((e as Error).message, 'danger'),
  });

  if (me.isLoading) return <Spinner />;
  if (!allowed) return <p role="alert" className="text-sm text-ink-muted">Écran réservé aux administrateurs.</p>;
  if (q.isLoading) return <Spinner />;
  if (q.error) return <p role="alert" className="text-sm text-danger">Liste indisponible : {(q.error as Error).message}</p>;

  const groups = new Map<string, PendingItem[]>();
  for (const i of q.data?.items ?? []) groups.set(i.templateName, [...(groups.get(i.templateName) ?? []), i]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-22">Prix à valider</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {q.data?.total ?? 0} élément(s) indicatif(s) dans les modèles de proposition. Une proposition qui en retient un ne peut pas passer « prête ».
        </p>
      </div>
      {groups.size === 0 && <Card><p className="text-sm text-ink-muted">Aucun prix à valider : tous les modèles sont validés.</p></Card>}
      {[...groups.entries()].map(([name, items]) => (
        <Card key={name} title={`${name} (${items.length})`}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Éléments à valider du modèle {name}</caption>
              <thead>
                <tr className="border-b border-line text-left text-xs+ text-ink-muted">
                  <th scope="col" className="py-2 pr-3 font-button">Élément</th>
                  <th scope="col" className="py-2 pr-3 font-button">Nature</th>
                  <th scope="col" className="py-2 pr-3 font-button">Valeur</th>
                  <th scope="col" className="py-2 pr-3 font-button">Source</th>
                  <th scope="col" className="py-2"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={`${i.scope}:${i.key}:${i.choiceValue ?? ''}`} className="border-b border-line last:border-0">
                    <td className="py-2 pr-3">{i.label}{i.choiceValue !== undefined && <span className="text-ink-faint"> — {i.choiceValue}</span>}</td>
                    <td className="py-2 pr-3"><Badge tone="warn">{SCOPE_LABEL[i.scope]}</Badge></td>
                    <td className="py-2 pr-3 tabular-nums">{priceOf(i)}</td>
                    <td className="py-2 pr-3 text-13 text-ink-muted">{(i.detail as { priceSource?: string | null } | null)?.priceSource ?? '—'}</td>
                    <td className="py-2 text-right">
                      <Button size="sm" onClick={() => setTarget(i)} aria-label={`Valider ${i.label}${i.choiceValue ? ` (${i.choiceValue})` : ''}`}>Valider</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
      <Modal
        open={!!target}
        onClose={() => setTarget(null)}
        title="Valider cet élément ?"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setTarget(null)}>Annuler</Button>
            <Button onClick={() => target && validate.mutate(target)} disabled={validate.isPending}>Valider</Button>
          </div>
        }
      >
        {target && (
          <div className="flex flex-col gap-2 text-sm">
            <p><strong>{target.templateName}</strong> — {target.label}{target.choiceValue ? ` (${target.choiceValue})` : ''} : {priceOf(target)}</p>
            <p className="text-ink-muted">
              La validation est tracée dans le journal d’audit. Le modèle devient propre au tenant : le seed des modèles ne le réécrira plus
              (sauf restauration forcée).
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
