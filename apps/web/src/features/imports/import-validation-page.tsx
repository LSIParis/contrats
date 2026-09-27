import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError } from '../../lib/api.js';
import { useMe } from '../../lib/queries.js';
import { can } from '../../lib/permissions.js';
import {
  billingFrequencyLabel, contractCategoryLabel, ocrStatusLabel, renewalModeLabel,
} from '../../lib/labels.js';
import { Badge } from '../../ui/badge.js';
import { StatusBadge } from '../../ui/status-badge.js';
import { Breadcrumb } from '../../ui/breadcrumb.js';
import { Button } from '../../ui/button.js';
import { Card } from '../../ui/card.js';
import { Field } from '../../ui/field.js';
import { Input, controlClass } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { Spinner } from '../../ui/spinner.js';
import { Icon } from '../../ui/icons.js';
import { useToast } from '../../ui/toast.js';
import { PdfFrame } from './pdf-viewer.js';
import { ImportAiExtract } from '../ai/import-ai-extract.js';
import { allows } from '../../lib/permissions.js';
import {
  confidenceLevel, prefill, toPayload,
  type FieldSource, type FormErrors, type FormKey, type ImportView, type ProposedField, type ValidationForm,
} from './import-mapping.js';

const CATEGORIES = ['MAINTENANCE', 'SUPPORT', 'HOSTING', 'SLA', 'OTHER'] as const;
const FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'YEARLY', 'ONE_OFF'] as const;
const RENEWAL_MODES = ['NONE', 'TACIT', 'EXPRESS'] as const;
const POLLING_MS = 5000;

/** Ordre des champs : sert à placer le focus sur la PREMIÈRE erreur. */
const FIELD_ORDER: FormKey[] = [
  'title', 'category', 'signedAt', 'startDate', 'endDate', 'noticeQuantity', 'renewalMode',
  'renewalPeriodMonths', 'amount', 'billingFrequency', 'chatelNotice', 'note',
];
const fieldId = (k: FormKey) => `imp-${k}`;

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('fr-FR');
const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('fr-FR');

// ---------------------------------------------------------------------------
// Confiance et preuve
// ---------------------------------------------------------------------------

/** Indicateur de confiance : ton + pourcentage + mot (la couleur ne porte jamais seule le sens). */
export function ConfidenceBadge({ field }: { field: ProposedField | null }) {
  if (!field) return <Badge tone="neutral">Non extrait</Badge>;
  if (field.method === 'SAISIE') {
    return (
      <Badge tone="info">
        <Icon name="pencil" className="h-3.5 w-3.5" strokeWidth={2} />
        Saisi au dépôt
      </Badge>
    );
  }
  const pct = Math.round(field.confidence * 100);
  const level = confidenceLevel(field.confidence);
  const icon = level.tone === 'success' ? 'checkCircle' : level.tone === 'warn' ? 'alert' : 'alertCircle';
  return (
    <Badge tone={level.tone}>
      <Icon name={icon} className="h-3.5 w-3.5" strokeWidth={2} />
      Confiance {level.label} : {pct} %
    </Badge>
  );
}

function SourceInfo({ source }: { source?: FieldSource }) {
  const field = source?.field ?? null;
  return (
    <div className="mt-1 flex flex-col gap-1 text-xs text-ink-muted">
      <div className="flex flex-wrap items-center gap-2">
        <ConfidenceBadge field={field} />
        {field?.method === 'LLM' && <Badge tone="warn">Proposé par l’IA</Badge>}
        {source?.derived && <span>{source.derived}</span>}
      </div>
      {field?.evidence?.excerpt && (
        <blockquote className="border-l-2 border-line-strong pl-2 italic text-ink-muted">
          <span className="sr-only">Extrait du document : </span>« {field.evidence.excerpt} »
        </blockquote>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bandeaux
// ---------------------------------------------------------------------------

function OcrBanner({ view, canRetry, onRetry, retrying, retryError }: {
  view: ImportView; canRetry: boolean; onRetry: () => void; retrying: boolean; retryError?: string;
}) {
  const { status, attempts, pages, error } = view.ocr;
  let body: ReactNode;
  if (status === 'PENDING' || status === 'RUNNING') {
    body = (
      <p className="flex items-center gap-2 text-info">
        <Icon name="clock" />
        OCR {ocrStatusLabel(status).toLowerCase()}{attempts ? ` (tentative ${attempts})` : ''} — actualisation automatique toutes les 5 secondes.
        Les champs seront complétés à la fin du traitement.
      </p>
    );
  } else if (status === 'FAILED') {
    body = (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-danger">
        <Icon name="alertCircle" />
        <span>OCR en échec{error ? ` : ${error}` : '.'}</span>
        {canRetry && (
          <Button type="button" variant="secondary" size="sm" onClick={onRetry} disabled={retrying}>
            {retrying ? 'Relance…' : 'Relancer l’OCR'}
          </Button>
        )}
        {retryError && <span>{retryError}</span>}
      </div>
    );
  } else if (status === 'DONE') {
    body = (
      <p className="flex items-center gap-2 text-success">
        <Icon name="checkCircle" />
        OCR terminé{pages ? ` (${pages} page${pages > 1 ? 's' : ''})` : ''} — copie recherchable disponible.
      </p>
    );
  } else {
    body = (
      <p className="flex items-center gap-2 text-ink-muted">
        <Icon name="info" />
        OCR non nécessaire : le document contient déjà son texte.
      </p>
    );
  }
  return (
    <div aria-live="polite" aria-atomic="true" className="rounded-lg border border-line bg-surface px-4 py-3 text-sm">
      <span className="sr-only">État de l’OCR : {ocrStatusLabel(status)}. </span>
      {body}
    </div>
  );
}

function LegacyNotice({ view, meId }: { view: ImportView; meId?: string }) {
  const importer = view.original.uploadedByUserId
    ? view.original.uploadedByUserId === meId
      ? 'vous'
      : `utilisateur ${view.original.uploadedByUserId.slice(0, 8)}`
    : 'inconnu';
  return (
    <section aria-label="Origine du contrat" className="rounded-lg border border-info bg-info-bg px-4 py-3 text-sm text-ink">
      <p className="flex items-center gap-2 font-semibold text-info">
        <Icon name="fileCheck" />
        Contrat signé hors plateforme — aucune nouvelle signature ne sera demandée
      </p>
      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
        <dt className="text-ink-muted">Origine</dt>
        <dd>Reprise de l’existant (<code>{view.origin}</code>)</dd>
        <dt className="text-ink-muted">Mode de signature</dt>
        <dd>Signature manuscrite hors plateforme (<code>{view.signatureMode}</code>)</dd>
        <dt className="text-ink-muted">Fichier original</dt>
        <dd>{view.original.filename}</dd>
        <dt className="text-ink-muted">Empreinte SHA-256</dt>
        <dd><code className="break-all font-mono text-xs">{view.original.sha256}</code></dd>
        <dt className="text-ink-muted">Importé par</dt>
        <dd>{importer}, le {fmtDateTime(view.original.createdAt)}</dd>
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Document (gauche)
// ---------------------------------------------------------------------------

function DocumentPane({ view }: { view: ImportView }) {
  const id = view.contract.id;
  const hasOcr = Boolean(view.ocr.searchablePdf);
  const [which, setWhich] = useState<'original' | 'ocr'>('original');
  const isPdf = view.original.contentType === 'application/pdf';
  const originalHref = `/v1/contracts/${id}/imported-document`;
  const ocrHref = `/v1/contracts/${id}/import/ocr.pdf`;
  const showing = which === 'ocr' && hasOcr ? 'ocr' : 'original';

  return (
    <Card title="Document">
      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Version affichée">
        <Button type="button" size="sm" variant={showing === 'original' ? 'primary' : 'secondary'}
          aria-pressed={showing === 'original'} onClick={() => setWhich('original')}>
          Original
        </Button>
        <Button type="button" size="sm" variant={showing === 'ocr' ? 'primary' : 'secondary'}
          aria-pressed={showing === 'ocr'} disabled={!hasOcr} onClick={() => setWhich('ocr')}>
          Copie OCR recherchable
        </Button>
        <a href={showing === 'ocr' ? ocrHref : originalHref} className="ml-auto text-sm text-primary hover:underline">
          Télécharger
        </a>
      </div>
      {showing === 'ocr' ? (
        <PdfFrame src={ocrHref} title={`Copie OCR recherchable de ${view.original.filename}`} downloadHref={ocrHref} />
      ) : isPdf ? (
        <PdfFrame src={originalHref} title={`Document original : ${view.original.filename}`} downloadHref={originalHref} />
      ) : (
        <p className="p-6 text-center text-ink-muted">
          Aperçu non disponible pour ce format (DOCX).{' '}
          <a href={originalHref} className="text-primary underline">Télécharger l’original</a>
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Formulaire (droite)
// ---------------------------------------------------------------------------

function InfoRow({ label, field, render }: { label: string; field: ProposedField | null; render: (v: unknown) => string }) {
  return (
    <div className="border-b border-line py-2 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs+ font-button text-ink-muted">{label}</span>
        <span className="text-sm text-ink">{field ? render(field.value) : '—'}</span>
      </div>
      <SourceInfo source={{ field }} />
    </div>
  );
}

export function ImportValidationForm({ view, canValidate, submitting, serverError, onSubmit }: {
  view: ImportView;
  canValidate: boolean;
  submitting: boolean;
  serverError?: string;
  onSubmit: (payload: NonNullable<ReturnType<typeof toPayload>['payload']>) => void;
}) {
  const initial = prefill(view);
  const [form, setForm] = useState<ValidationForm>(initial.form);
  const [sources, setSources] = useState(initial.sources);
  const [errors, setErrors] = useState<FormErrors>({});
  const dirty = useRef(false);
  const errorRef = useRef<HTMLDivElement | null>(null);
  const pending = view.contract.status === 'IMPORTED_PENDING_VALIDATION';
  const editable = pending && canValidate;

  // Tant que le valideur n'a rien modifié, la fin de l'OCR met à jour le pré-remplissage.
  const extractionKey = JSON.stringify(view.extraction ?? null);
  useEffect(() => {
    if (dirty.current) return;
    const next = prefill(view);
    setForm(next.form);
    setSources(next.sources);
  }, [extractionKey]); // `view` change à chaque sondage : seule l'extraction compte ici.

  useEffect(() => {
    if (serverError) errorRef.current?.focus();
  }, [serverError]);

  const set = (k: FormKey) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    dirty.current = true;
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!editable) return;
    const r = toPayload(form);
    setErrors(r.errors);
    const first = FIELD_ORDER.find((k) => r.errors[k]);
    if (first) {
      document.getElementById(fieldId(first))?.focus();
      return;
    }
    if (r.payload) onSubmit(r.payload);
  }

  const ex = view.extraction;
  const get = (k: string) => {
    const f = ex?.[k];
    return f && typeof f === 'object' ? f : null;
  };

  return (
    <Card title="Champs extraits">
      <form noValidate onSubmit={handleSubmit} aria-label="Validation des champs extraits" className="flex flex-col gap-4">
        {!canValidate && pending && (
          <p className="flex items-center gap-2 rounded border border-warn bg-warn-bg px-3 py-2 text-sm text-warn">
            <Icon name="info" />
            Validation réservée au juriste/valideur. Les champs sont affichés en lecture seule.
          </p>
        )}
        {!pending && (
          <p className="flex items-center gap-2 rounded border border-success bg-success-bg px-3 py-2 text-sm text-success">
            <Icon name="checkCircle" />
            {view.validated ? `Import validé le ${fmtDateTime(view.validated.at)}.` : 'Import déjà traité.'}
          </p>
        )}
        <fieldset disabled={!editable} className="flex flex-col gap-4">
          <legend className="sr-only">Champs du contrat</legend>
          <Field label="Titre" htmlFor={fieldId('title')} error={errors.title}>
            <Input id={fieldId('title')} value={form.title} onChange={set('title')} />
          </Field>
          <Field label="Catégorie" htmlFor={fieldId('category')}>
            <Select id={fieldId('category')} value={form.category} onChange={set('category')}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{contractCategoryLabel(c)}</option>)}
            </Select>
          </Field>

          <div>
            <Field label="Date de signature" htmlFor={fieldId('signedAt')} error={errors.signedAt}>
              <Input id={fieldId('signedAt')} type="date" value={form.signedAt} onChange={set('signedAt')} />
            </Field>
            <SourceInfo source={sources.signedAt} />
          </div>
          <div>
            <Field label="Date d’effet (obligatoire)" htmlFor={fieldId('startDate')} error={errors.startDate}>
              <Input id={fieldId('startDate')} type="date" required value={form.startDate} onChange={set('startDate')} />
            </Field>
            <SourceInfo source={sources.startDate} />
          </div>
          <div>
            <Field label="Date de fin (terme)" htmlFor={fieldId('endDate')} error={errors.endDate}>
              <Input id={fieldId('endDate')} type="date" value={form.endDate} onChange={set('endDate')} />
            </Field>
            <SourceInfo source={sources.endDate} />
          </div>

          <div>
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <Field label="Préavis" htmlFor={fieldId('noticeQuantity')} error={errors.noticeQuantity}>
                <Input id={fieldId('noticeQuantity')} type="number" min="0" inputMode="numeric"
                  value={form.noticeQuantity} onChange={set('noticeQuantity')} />
              </Field>
              <Field label="Unité du préavis" htmlFor={fieldId('noticeUnit')}>
                <Select id={fieldId('noticeUnit')} value={form.noticeUnit} onChange={set('noticeUnit')}>
                  <option value="JOURS">jours</option>
                  <option value="MOIS">mois</option>
                </Select>
              </Field>
            </div>
            <SourceInfo source={sources.noticeQuantity} />
          </div>

          <div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Reconduction" htmlFor={fieldId('renewalMode')}>
                <Select id={fieldId('renewalMode')} value={form.renewalMode} onChange={set('renewalMode')}>
                  {RENEWAL_MODES.map((m) => <option key={m} value={m}>{renewalModeLabel(m)}</option>)}
                </Select>
              </Field>
              <Field label="Durée de reconduction (mois)" htmlFor={fieldId('renewalPeriodMonths')} error={errors.renewalPeriodMonths}
                hint={sources.renewalPeriodMonths?.derived}>
                <Input id={fieldId('renewalPeriodMonths')} type="number" min="1" inputMode="numeric"
                  value={form.renewalPeriodMonths} onChange={set('renewalPeriodMonths')}
                  disabled={form.renewalMode === 'NONE'} />
              </Field>
            </div>
            <SourceInfo source={sources.renewalMode} />
          </div>

          <div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Montant HT (€)" htmlFor={fieldId('amount')} error={errors.amount}>
                <Input id={fieldId('amount')} inputMode="decimal" placeholder="1500,00" value={form.amount} onChange={set('amount')} />
              </Field>
              <Field label="Périodicité de facturation" htmlFor={fieldId('billingFrequency')}>
                <Select id={fieldId('billingFrequency')} value={form.billingFrequency} onChange={set('billingFrequency')}>
                  {FREQUENCIES.map((f) => <option key={f} value={f}>{billingFrequencyLabel(f)}</option>)}
                </Select>
              </Field>
            </div>
            <SourceInfo source={sources.amount} />
          </div>

          <Field label="Information loi Chatel (client consommateur)" htmlFor={fieldId('chatelNotice')}>
            <Select id={fieldId('chatelNotice')} value={form.chatelNotice} onChange={set('chatelNotice')}>
              <option value="">Selon la fiche client</option>
              <option value="true">Oui, s’applique</option>
              <option value="false">Non</option>
            </Select>
          </Field>

          <Field label="Commentaire du valideur" htmlFor={fieldId('note')}>
            <textarea id={fieldId('note')} rows={3} maxLength={2000} className={controlClass}
              value={form.note} onChange={set('note')} />
          </Field>
        </fieldset>

        <section aria-labelledby="imp-info-title" className="rounded border border-line bg-page px-3 py-2">
          <h3 id="imp-info-title" className="text-13 font-title text-ink">Informations extraites (lecture seule)</h3>
          <InfoRow label="Indice de révision" field={get('indiceRevision')} render={(v) => String(v)} />
          <InfoRow label="Prestataire" field={get('prestataireRaisonSociale')} render={(v) => String(v)} />
          <InfoRow label="SIREN prestataire" field={get('prestataireSiren')} render={(v) => String(v)} />
          <InfoRow label="Client" field={get('clientRaisonSociale')} render={(v) => String(v)} />
          <InfoRow label="SIREN client" field={get('clientSiren')} render={(v) => String(v)} />
          <InfoRow label="Durée initiale" field={get('dureeMois')} render={(v) => `${String(v)} mois`} />
        </section>

        {serverError && (
          <div ref={errorRef} tabIndex={-1} role="alert" className="rounded border border-danger bg-danger-bg px-3 py-2 text-sm text-danger">
            {serverError}
          </div>
        )}
        {pending && canValidate && (
          <div>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Validation…' : 'Valider l’import'}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ImportValidationPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const roles = me.data?.roles ?? [];

  const q = useQuery({
    queryKey: ['import', id],
    queryFn: () => apiGet<ImportView>(`/v1/contracts/${id}/import`),
    refetchInterval: (query) => {
      const s = query.state.data?.ocr.status;
      return s === 'PENDING' || s === 'RUNNING' ? POLLING_MS : false;
    },
  });

  const retry = useMutation({
    mutationFn: () => apiPost<{ ocrStatus: string }>(`/v1/contracts/${id}/import/retry-ocr`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['import', id] }),
  });

  const validate = useMutation({
    mutationFn: (payload: object) =>
      apiPost<{ id: string; status: string; deadlinesCreated: number }>(`/v1/contracts/${id}/import/validate`, payload),
    onSuccess: (r) => {
      toast.show(`Import validé. ${r.deadlinesCreated} échéance(s) calculée(s).`, 'success');
      for (const k of [['import', id], ['contract', id], ['contracts'], ['dashboard'], ['deadlines']]) {
        void qc.invalidateQueries({ queryKey: k });
      }
      nav(`/contracts/${id}?onglet=echeances`);
    },
  });

  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <p role="alert" className="text-danger">Import introuvable.</p>;
  const view = q.data;
  const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : e ? 'Erreur inattendue.' : undefined);

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[
        { label: 'Contrats', to: '/contracts' },
        { label: view.contract.reference, to: `/contracts/${view.contract.id}` },
        { label: 'Validation de l’import' },
      ]} />
      <div className="flex flex-wrap items-center gap-3">
        <h1>Validation de l’import — {view.contract.reference}</h1>
        <StatusBadge status={view.contract.status} />
      </div>
      <LegacyNotice view={view} meId={me.data?.userId} />
      <OcrBanner
        view={view}
        canRetry={can(roles, 'contracts.import')}
        onRetry={() => retry.mutate()}
        retrying={retry.isPending}
        retryError={errMsg(retry.error)}
      />
      {view.contract.status === 'IMPORTED_PENDING_VALIDATION' && allows(me.data, 'contracts.import') && (
        <ImportAiExtract contractId={view.contract.id} ocrReady={view.ocr.status === 'DONE' || view.ocr.status === 'SKIPPED'} />
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <DocumentPane view={view} />
        <ImportValidationForm
          view={view}
          canValidate={can(roles, 'imports.validate')}
          submitting={validate.isPending}
          serverError={errMsg(validate.error)}
          onSubmit={(p) => validate.mutate(p)}
        />
      </div>
    </div>
  );
}
