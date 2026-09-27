import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { errorMessage } from '../../lib/api.js';
import { allows } from '../../lib/permissions.js';
import type { Me } from '../../lib/queries.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';
import { ErrorNote } from '../../ui/region-card.js';
import { Select } from '../../ui/select.js';
import { useToast } from '../../ui/toast.js';
import { proposalsApi, type ProposalDetail } from './proposal-api.js';
import { ACCEPTANCE_MODE_LABELS, MERGE_TAGS } from './proposal-labels.js';

/**
 * Réglages de la proposition (`PATCH /v1/proposals/:id`) : paramètres de
 * rédaction (brouillon seulement : titre, mode, validité, sensibilité, valeurs
 * de fusion saisies) et pilotage commercial (probabilité, date d'effet,
 * relances), modifiables tant que la proposition vit. Seuls les champs
 * changés sont envoyés.
 */
const TERMINAL = ['CONVERTED', 'DECLINED', 'WITHDRAWN'];

function Row({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-[5px]">
      <label htmlFor={id} className="text-xs+ font-button text-ink-muted">{label}</label>
      {children}
      {hint && <p className="text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

export function SettingsPanel({ detail, me, onDetail }: { detail: ProposalDetail; me: Me | undefined; onDetail: (d: ProposalDetail) => void }) {
  const p = detail.proposal;
  const canWrite = allows(me, 'proposals.write');
  const draft = p.status === 'DRAFT' && !detail.version.lockedAt;
  return (
    <div className="flex flex-col gap-4">
      <DraftSettings detail={detail} editable={canWrite && draft} onDetail={onDetail} />
      <PilotSettings detail={detail} editable={canWrite && !TERMINAL.includes(p.status)} onDetail={onDetail} />
    </div>
  );
}

function DraftSettings({ detail, editable, onDetail }: { detail: ProposalDetail; editable: boolean; onDetail: (d: ProposalDetail) => void }) {
  const toast = useToast();
  const p = detail.proposal;
  const init = () => ({
    title: p.title, acceptanceMode: p.acceptanceMode, validityDays: String(p.validityDays), fixedExpiryDate: p.fixedExpiryDate?.slice(0, 10) ?? '',
    sensitive: p.sensitive,
    merge: Object.fromEntries(MERGE_TAGS.filter((t) => t.input).map((t) => [t.tag, p.mergeContext?.[t.tag] === undefined ? '' : String(p.mergeContext[t.tag])])) as Record<string, string>,
  });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [detail]);
  const [error, setError] = useState<string | undefined>();

  const save = useMutation({
    mutationFn: (b: Record<string, unknown>) => proposalsApi.update(p.id, b),
    onSuccess: (d) => { onDetail(d); toast.show('Réglages enregistrés.', 'success'); },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const b: Record<string, unknown> = {};
    if (f.title.trim() !== p.title) b.title = f.title.trim();
    if (f.acceptanceMode !== p.acceptanceMode) b.acceptanceMode = f.acceptanceMode;
    const days = Number(f.validityDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) return setError('Validité : nombre de jours entre 1 et 365.');
    if (days !== p.validityDays) b.validityDays = days;
    if ((f.fixedExpiryDate || null) !== (p.fixedExpiryDate?.slice(0, 10) ?? null)) b.fixedExpiryDate = f.fixedExpiryDate || null;
    if (f.sensitive !== p.sensitive) b.sensitive = f.sensitive;
    // Valeurs de fusion : on conserve les autres clés du contexte, entiers pour parc.* et effectif.
    const merge: Record<string, string | number> = { ...(p.mergeContext ?? {}) };
    for (const t of MERGE_TAGS.filter((x) => x.input)) {
      const raw = (f.merge[t.tag] ?? '').trim();
      if (!raw) delete merge[t.tag];
      else if (t.tag === 'contact.civilite') merge[t.tag] = raw;
      else if (/^\d+$/.test(raw)) merge[t.tag] = Number(raw);
      else return setError(`${t.label} : nombre entier attendu.`);
    }
    if (JSON.stringify(merge) !== JSON.stringify(p.mergeContext ?? {})) b.mergeContext = merge;
    setError(undefined);
    if (Object.keys(b).length) save.mutate(b);
  };

  return (
    <form onSubmit={submit} aria-label="Réglages de rédaction" className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5 shadow-sm">
      <h2 className="text-15 font-title text-ink">Rédaction</h2>
      {!editable && <p className="text-13 text-ink-muted">Modifiable uniquement en brouillon (réviser la proposition sinon).</p>}
      <fieldset disabled={!editable} className="grid gap-3 sm:grid-cols-2">
        <Row id="reg-titre" label="Titre"><Input id="reg-titre" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Row>
        <Row id="reg-mode" label="Mode d’acceptation" hint="Acceptation par clic : réservée aux petits montants (seuil du tenant).">
          <Select id="reg-mode" value={f.acceptanceMode} onChange={(e) => setF({ ...f, acceptanceMode: e.target.value as typeof f.acceptanceMode })}>
            <option value="DOCUSEAL_SIGNATURE">{ACCEPTANCE_MODE_LABELS.DOCUSEAL_SIGNATURE}</option>
            <option value="CLICK_ACCEPT">{ACCEPTANCE_MODE_LABELS.CLICK_ACCEPT}</option>
          </Select>
        </Row>
        <Row id="reg-validite" label="Validité après envoi (jours)"><Input id="reg-validite" inputMode="numeric" value={f.validityDays} onChange={(e) => setF({ ...f, validityDays: e.target.value })} /></Row>
        <Row id="reg-echeance" label="Échéance fixe (facultative)" hint="Prioritaire sur la validité ; fin de journée, heure de Paris.">
          <Input id="reg-echeance" type="date" value={f.fixedExpiryDate} onChange={(e) => setF({ ...f, fixedExpiryDate: e.target.value })} />
        </Row>
        <label className="inline-flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={f.sensitive} onChange={(e) => setF({ ...f, sensitive: e.target.checked })} />
          Proposition sensible : contenu visible seulement après un code à usage unique envoyé par e-mail
        </label>
      </fieldset>
      <fieldset disabled={!editable} className="flex flex-col gap-2">
        <legend className="mb-1 text-13 font-button text-ink">Valeurs de fusion saisies</legend>
        <p className="text-xs text-ink-faint">Les autres balises (client, contact, commercial, totaux) sont calculées par le serveur.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {MERGE_TAGS.filter((t) => t.input).map((t) => (
            <Row key={t.tag} id={`reg-${t.tag}`} label={`${t.label} ({{${t.tag}}})`}>
              <Input id={`reg-${t.tag}`} value={f.merge[t.tag] ?? ''} inputMode={t.tag === 'contact.civilite' ? undefined : 'numeric'} onChange={(e) => setF({ ...f, merge: { ...f.merge, [t.tag]: e.target.value } })} />
            </Row>
          ))}
        </div>
      </fieldset>
      <ErrorNote>{error ?? errorMessage(save.error)}</ErrorNote>
      {editable && <div><Button type="submit" size="sm" disabled={save.isPending}>Enregistrer les réglages</Button></div>}
    </form>
  );
}

function PilotSettings({ detail, editable, onDetail }: { detail: ProposalDetail; editable: boolean; onDetail: (d: ProposalDetail) => void }) {
  const toast = useToast();
  const p = detail.proposal;
  const cfg = p.followUpConfig ?? { noOpenAfterDays: 3, noDecisionAfterDays: 7, beforeExpiryDays: 2 };
  const init = () => ({
    win: p.winProbability === null ? '' : String(p.winProbability), start: p.desiredStartDate?.slice(0, 10) ?? '',
    a: String(cfg.noOpenAfterDays), b: String(cfg.noDecisionAfterDays), c: String(cfg.beforeExpiryDays),
  });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [detail]);
  const [error, setError] = useState<string | undefined>();
  const save = useMutation({
    mutationFn: (b: Record<string, unknown>) => proposalsApi.update(p.id, b),
    onSuccess: (d) => { onDetail(d); toast.show('Pilotage enregistré.', 'success'); },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const b: Record<string, unknown> = {};
    const win = f.win.trim() === '' ? null : Number(f.win);
    if (win !== null && (!Number.isInteger(win) || win < 0 || win > 100)) return setError('Probabilité : entier entre 0 et 100.');
    if (win !== p.winProbability) b.winProbability = win;
    if ((f.start || null) !== (p.desiredStartDate?.slice(0, 10) ?? null)) b.desiredStartDate = f.start || null;
    const next = { noOpenAfterDays: Number(f.a), noDecisionAfterDays: Number(f.b), beforeExpiryDays: Number(f.c) };
    if (!Object.values(next).every((n) => Number.isInteger(n) && n >= 1)) return setError('Relances : nombres de jours entiers (1 au moins).');
    if (JSON.stringify(next) !== JSON.stringify(cfg)) b.followUpConfig = next;
    setError(undefined);
    if (Object.keys(b).length) save.mutate(b);
  };
  return (
    <form onSubmit={submit} aria-label="Pilotage commercial" className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5 shadow-sm">
      <h2 className="text-15 font-title text-ink">Pilotage commercial</h2>
      <fieldset disabled={!editable} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Row id="pil-proba" label="Probabilité de gain (%)"><Input id="pil-proba" inputMode="numeric" value={f.win} onChange={(e) => setF({ ...f, win: e.target.value })} /></Row>
        <Row id="pil-effet" label="Date d’effet souhaitée" hint="Reprise par le contrat généré."><Input id="pil-effet" type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Row>
        <Row id="pil-r1" label="Relance sans ouverture (J+)"><Input id="pil-r1" inputMode="numeric" value={f.a} onChange={(e) => setF({ ...f, a: e.target.value })} /></Row>
        <Row id="pil-r2" label="Relance sans décision (J+)"><Input id="pil-r2" inputMode="numeric" value={f.b} onChange={(e) => setF({ ...f, b: e.target.value })} /></Row>
        <Row id="pil-r3" label="Relance avant échéance (J-)"><Input id="pil-r3" inputMode="numeric" value={f.c} onChange={(e) => setF({ ...f, c: e.target.value })} /></Row>
      </fieldset>
      <ErrorNote>{error ?? errorMessage(save.error)}</ErrorNote>
      {editable && <div><Button type="submit" size="sm" disabled={save.isPending}>Enregistrer le pilotage</Button></div>}
    </form>
  );
}
