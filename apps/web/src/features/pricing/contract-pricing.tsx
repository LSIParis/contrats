import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, errorText } from '../../lib/api.js';
import { formatDecimal, formatDecimalEuros } from '../../lib/money.js';
import { canDo } from '../../lib/permissions.js';
import { useMe } from '../../lib/queries.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { ConfirmDialog } from '../../ui/confirm-dialog.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { ErrorNote, RegionCard } from '../../ui/region-card.js';
import { Spinner } from '../../ui/spinner.js';
import { Table } from '../../ui/table.js';
import { useToast } from '../../ui/toast.js';
import { KIND_LABELS, MODE_LABELS, SCHEDULE_STATUS, fmtDay } from './labels.js';
import { OverridesCard } from './overrides-card.js';
import { PriceAtCard } from './price-at-card.js';
import { ScheduleEditor } from './schedule-editor.js';
import { SimulatorCard } from './simulator-card.js';
import type { LineInput, ScheduleView, SchedulesResponse } from './types.js';

/**
 * Onglet « Tarification » de la fiche contrat (brief §5 et §11, lot 3) :
 * versions du barème, éditeur de brouillon, prix à une date avec trace,
 * simulateur, dérogations et double validation. Les droits viennent de
 * `/v1/auth/me` ; l'API reste seule juge (403 affichés).
 */
export function ContractPricing({ contractId }: { contractId: string }) {
  const me = useMe();
  const q = useQuery({
    queryKey: ['pricing-schedules', contractId],
    queryFn: () => apiRequest<SchedulesResponse>('GET', `/v1/contracts/${contractId}/pricing/schedules`),
  });
  const schedules = q.data?.items ?? [];
  return (
    <div className="flex flex-col gap-4">
      <SchedulesCard contractId={contractId} data={q.data} loading={q.isLoading} error={errorText(q.error)} canWrite={canDo(me.data, 'pricing.write')} />
      {q.data && <PriceAtCard contractId={contractId} schedules={schedules} />}
      {q.data && canDo(me.data, 'pricing.simulate') && <SimulatorCard contractId={contractId} schedules={schedules} />}
      {q.data && <OverridesCard contractId={contractId} schedules={schedules} me={me.data} />}
    </div>
  );
}

type Confirm = { kind: 'activate' | 'delete'; s: ScheduleView } | null;

function SchedulesCard({
  contractId, data, loading, error, canWrite,
}: {
  contractId: string;
  data: SchedulesResponse | undefined;
  loading: boolean;
  error?: string;
  canWrite: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<ScheduleView | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [creating, setCreating] = useState<{ copyFrom: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const base = `/v1/contracts/${contractId}/pricing/schedules`;
  const items = data?.items ?? [];

  const act = useMutation({
    mutationFn: (c: NonNullable<Confirm>) =>
      c.kind === 'activate'
        ? apiRequest<ScheduleView>('POST', `${base}/${c.s.version}/activate`)
        : apiRequest<unknown>('DELETE', `${base}/${c.s.version}`),
    onSuccess: (_r, c) => {
      toast.show(c.kind === 'activate' ? `Version ${c.s.version} activée.` : `Brouillon ${c.s.version} supprimé.`, 'success');
      if (editing?.id === c.s.id) setEditing(null);
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ['pricing-schedules', contractId] });
      void qc.invalidateQueries({ queryKey: ['pricing-at', contractId] });
    },
  });

  const current = editing ? (items.find((s) => s.id === editing.id) ?? editing) : undefined;
  const editedSchedule = current?.status === 'DRAFT' ? current : undefined;
  const viewed = items.find((s) => s.version === viewing);

  return (
    <>
      <RegionCard
        title="Barème — versions"
        actions={canWrite ? <Button type="button" size="sm" onClick={() => setCreating({ copyFrom: '' })}>Nouvelle version</Button> : undefined}
      >
        {loading && <Spinner />}
        <ErrorNote>{error}</ErrorNote>
        {data && (
          <p className="text-13 text-ink-muted">
            {data.nextRevisionDate ? `Prochaine révision tarifaire : ${fmtDay(data.nextRevisionDate)}.` : 'Aucune révision tarifaire programmée.'}{' '}
            Une version engagée ne se modifie jamais : réviser = créer une nouvelle version.
          </p>
        )}
        {data && items.length === 0 && <p className="text-13 text-ink-faint">Aucun barème pour ce contrat.</p>}
        {items.length > 0 && (
          <Table
            caption="Versions du barème"
            head={<tr><th>Version</th><th>Statut</th><th>Validité</th><th>Engagement</th><th>Lignes</th><th>Actions</th></tr>}
          >
            {items.map((s) => {
              const st = SCHEDULE_STATUS[s.status] ?? { label: s.status, tone: 'neutral' as const };
              return (
                <tr key={s.id}>
                  <td className="font-medium">v{s.version}{s.note && <span className="block text-xs text-ink-faint">{s.note}</span>}</td>
                  <td><Badge tone={st.tone}>{st.label}</Badge></td>
                  <td>{fmtDay(s.validFrom)} → {s.validTo ? fmtDay(s.validTo) : 'sans fin'}</td>
                  <td>{s.commitmentMonths ? `${s.commitmentMonths} mois` : '—'}</td>
                  <td>{s.lines.length}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      <Button type="button" size="sm" variant="ghost" aria-label={`Voir les lignes de la version ${s.version}`} onClick={() => setViewing(viewing === s.version ? null : s.version)}>
                        {viewing === s.version ? 'Masquer' : 'Lignes'}
                      </Button>
                      {canWrite && s.status === 'DRAFT' && (
                        <>
                          <Button type="button" size="sm" variant="secondary" aria-label={`Modifier la version ${s.version}`} onClick={() => setEditing(s)}>Modifier</Button>
                          <Button type="button" size="sm" aria-label={`Activer la version ${s.version}`} onClick={() => { act.reset(); setConfirm({ kind: 'activate', s }); }}>Activer</Button>
                          <Button type="button" size="sm" variant="danger-ghost" aria-label={`Supprimer la version ${s.version}`} onClick={() => { act.reset(); setConfirm({ kind: 'delete', s }); }}>Supprimer</Button>
                        </>
                      )}
                      {canWrite && (
                        <Button type="button" size="sm" variant="ghost" aria-label={`Copier la version ${s.version} dans une nouvelle version`} onClick={() => setCreating({ copyFrom: String(s.version) })}>
                          Copier
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
        {viewed && <LinesTable schedule={viewed} />}
      </RegionCard>

      {editedSchedule && <ScheduleEditor key={editedSchedule.id} contractId={contractId} schedule={editedSchedule} onClose={() => setEditing(null)} />}

      <ConfirmDialog
        open={confirm?.kind === 'activate'}
        title={`Activer la version ${confirm?.s.version ?? ''}`}
        confirmLabel="Activer"
        onConfirm={() => confirm && act.mutate(confirm)}
        onClose={() => setConfirm(null)}
        pending={act.isPending}
        error={errorText(act.error)}
      >
        {confirm && (
          <>
            <p>
              La version {confirm.s.version} s’appliquera à partir du {fmtDay(confirm.s.validFrom)}
              {confirm.s.validTo ? ` jusqu’au ${fmtDay(confirm.s.validTo)}` : ', sans fin'} et sera figée.
            </p>
            <p>Les versions engagées qui la chevauchent seront clôturées la veille du {fmtDay(confirm.s.validFrom)}.</p>
            <p className="text-13 text-ink-muted">Le barème est recalculé par le moteur avant activation : un barème incalculable est refusé.</p>
          </>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm?.kind === 'delete'}
        title={`Supprimer le brouillon ${confirm?.s.version ?? ''}`}
        confirmLabel="Supprimer"
        variant="danger"
        onConfirm={() => confirm && act.mutate(confirm)}
        onClose={() => setConfirm(null)}
        pending={act.isPending}
        error={errorText(act.error)}
      >
        <p>Le brouillon et ses lignes seront supprimés.</p>
      </ConfirmDialog>

      {creating && (
        <CreateScheduleDialog
          contractId={contractId}
          schedules={items}
          initialCopyFrom={creating.copyFrom}
          onClose={() => setCreating(null)}
          onCreated={(s) => {
            setCreating(null);
            setEditing(s);
            toast.show(`Brouillon ${s.version} créé.`, 'success');
          }}
        />
      )}
    </>
  );
}

function describeLinePrice(l: LineInput): string {
  if (l.kind === 'DISCOUNT' && l.discount) {
    const v = l.discount.type === 'PERCENT' ? `${formatDecimal(l.discount.value, { minFraction: 0 })} %` : formatDecimalEuros(l.discount.value);
    return `Remise ${v} sur ${l.discount.appliesTo.scope === 'SUBTOTAL' ? 'le sous-total' : l.discount.appliesTo.lineIds.join(', ')}`;
  }
  if (l.mode === 'RULE' && l.rule) return `Règle ${l.rule.priceRuleId}${l.rule.adjustmentRuleIds?.length ? ` + ${l.rule.adjustmentRuleIds.join(', ')}` : ''}`;
  if (l.mode === 'FORMULA' && l.formula) return `Formule ${l.formula.expression}`;
  if (l.tiers) return `${l.tiers.tiers.length} palier(s) ${l.tiers.mode === 'VOLUME' ? 'au volume' : 'par tranches'}`;
  return formatDecimalEuros(l.unitPrice);
}

function LinesTable({ schedule }: { schedule: ScheduleView }) {
  return (
    <Table
      caption={`Lignes de la version ${schedule.version}`}
      head={<tr><th>Ligne</th><th>Type</th><th>Mode</th><th>Quantité</th><th>Prix</th><th>TVA</th><th>Révision</th></tr>}
    >
      {schedule.lines.map((l) => (
        <tr key={l.lineKey}>
          <td>{l.label}<span className="block text-xs text-ink-faint">{l.articleCode} · {l.lineKey}</span></td>
          <td>{KIND_LABELS[l.kind] ?? l.kind}</td>
          <td>{MODE_LABELS[l.mode] ?? l.mode}</td>
          <td className="tabular-nums">
            {l.kind === 'DISCOUNT' ? '—' : l.quantitySource === 'PROVIDER' ? `fournie (${l.providerArticleCode ?? ''})` : `${formatDecimal(l.quantity ?? '1', { minFraction: 0 })} ${l.unit}`}
          </td>
          <td className="tabular-nums">{describeLinePrice(l)}</td>
          <td className="tabular-nums">{formatDecimal(l.vatRatePercent, { minFraction: 0 })} %</td>
          <td>{l.revision ? `${l.revision.indexCode} au ${fmtDay(l.revision.revisionDate)} (a ${l.revision.a}, b ${l.revision.b})` : '—'}</td>
        </tr>
      ))}
    </Table>
  );
}

function CreateScheduleDialog({
  contractId, schedules, initialCopyFrom, onClose, onCreated,
}: {
  contractId: string;
  schedules: ScheduleView[];
  initialCopyFrom: string;
  onClose: () => void;
  onCreated: (s: ScheduleView) => void;
}) {
  const uid = useId();
  const source = (v: string) => schedules.find((s) => String(s.version) === v);
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [copyFrom, setCopyFrom] = useState(initialCopyFrom);
  const [commitment, setCommitment] = useState(() => String(source(initialCopyFrom)?.commitmentMonths ?? ''));
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string>();
  const m = useMutation({
    mutationFn: (body: unknown) => apiRequest<ScheduleView>('POST', `/v1/contracts/${contractId}/pricing/schedules`, body),
    onSuccess: (s) => onCreated(s),
  });
  const qc = useQueryClient();

  function submit() {
    let commitmentMonths: number | undefined;
    if (commitment.trim()) {
      const n = Number(commitment.trim());
      if (!Number.isInteger(n) || n < 1 || n > 240) {
        setFormError('Engagement : nombre entier de mois entre 1 et 240.');
        return;
      }
      commitmentMonths = n;
    }
    setFormError(undefined);
    m.mutate(
      {
        validFrom,
        ...(validTo ? { validTo } : {}),
        ...(commitmentMonths !== undefined ? { commitmentMonths } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(copyFrom ? { copyFromVersion: Number(copyFrom) } : { lines: [] }),
      },
      { onSuccess: () => void qc.invalidateQueries({ queryKey: ['pricing-schedules', contractId] }) },
    );
  }

  return (
    <ConfirmDialog
      open
      title="Nouvelle version du barème"
      confirmLabel="Créer le brouillon"
      disabled={!validFrom}
      onConfirm={submit}
      onClose={onClose}
      pending={m.isPending}
      error={formError ?? errorText(m.error)}
    >
      <p className="text-13 text-ink-muted">
        Le brouillon reste modifiable jusqu’à son activation. Activé, il clôture la version engagée qu’il chevauche la veille de sa date d’effet.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Valide à partir du" htmlFor={`${uid}-from`}>
          <Input id={`${uid}-from`} type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </Field>
        <Field label="Jusqu’au (facultatif)" htmlFor={`${uid}-to`}>
          <Input id={`${uid}-to`} type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        </Field>
      </div>
      <Field label="Lignes de départ" htmlFor={`${uid}-copy`} hint="La copie conserve les clés de ligne (dérogations et historique suivent).">
        <Select
          id={`${uid}-copy`}
          value={copyFrom}
          onChange={(e) => {
            setCopyFrom(e.target.value);
            const src = source(e.target.value);
            if (src?.commitmentMonths && !commitment.trim()) setCommitment(String(src.commitmentMonths));
          }}
        >
          <option value="">Aucune (barème vide)</option>
          {schedules.map((s) => (
            <option key={s.version} value={String(s.version)}>Copie de la version {s.version} ({SCHEDULE_STATUS[s.status]?.label ?? s.status})</option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Engagement (mois)" htmlFor={`${uid}-commit`}>
          <Input id={`${uid}-commit`} inputMode="numeric" value={commitment} onChange={(e) => setCommitment(e.target.value)} />
        </Field>
        <Field label="Note" htmlFor={`${uid}-note`}>
          <Input id={`${uid}-note`} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}
