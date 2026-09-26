import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPostForm, ApiError } from '../../lib/api.js';
import { eurosToCents } from '../../lib/money.js';
import { Spinner } from '../../ui/spinner.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Select } from '../../ui/select.js';
import { Button } from '../../ui/button.js';
import { Breadcrumb } from '../../ui/breadcrumb.js';
import { Card } from '../../ui/card.js';
import { Tabs } from '../../ui/tabs.js';
import { Table } from '../../ui/table.js';
import { Badge } from '../../ui/badge.js';
import { Icon } from '../../ui/icons.js';
import { contractCategoryLabel } from '../../lib/labels.js';

export interface ImportCustomerRow { id: string; name: string; }

const CATEGORIES = ['MAINTENANCE', 'SUPPORT', 'HOSTING', 'SLA', 'OTHER'] as const;
const ACCEPT = '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** Limite de l'API (MAX_FILES_PER_REQUEST, apps/api/src/bootstrap.ts). */
export const MAX_BATCH_FILES = 20;

// ---------------------------------------------------------------------------
// Dépôt unitaire
// ---------------------------------------------------------------------------

export interface ContractImportFormProps {
  customers: ImportCustomerRow[];
  submitting: boolean;
  error?: string;
  onSubmit: (form: FormData) => void;
}

/**
 * Dépôt unitaire (`POST /v1/contracts/import`, ImportMetaSchema). Seuls le client et le
 * document sont obligatoires : sans référence l'API en attribue une (IMP-AAAA-NNNN), sans
 * titre elle le déduit du nom de fichier. Les indications saisies ici ne sont que des
 * PROPOSITIONS, revues sur l'écran de validation.
 */
export function ContractImportForm({ customers, submitting, error, onSubmit }: ContractImportFormProps) {
  const [form, setForm] = useState({
    customerId: '', reference: '', title: '', category: '',
    startDate: '', endDate: '', signedAt: '', noticePeriodDays: '', amount: '',
  });
  const [file, setFile] = useState<File | null>(null);
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });
  const ready = Boolean(form.customerId && file);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!ready || !file) return;
    const fd = new FormData();
    fd.append('customerId', form.customerId);
    if (form.reference.trim()) fd.append('reference', form.reference.trim());
    if (form.title.trim()) fd.append('title', form.title.trim());
    if (form.category) fd.append('category', form.category);
    if (form.startDate) fd.append('startDate', form.startDate);
    if (form.endDate) fd.append('endDate', form.endDate);
    if (form.signedAt) fd.append('signedAt', form.signedAt);
    if (form.noticePeriodDays.trim()) fd.append('noticePeriodDays', form.noticePeriodDays.trim());
    const cents = eurosToCents(form.amount);
    if (cents !== undefined) fd.append('amountCents', String(cents));
    fd.append('document', file);
    onSubmit(fd);
  }

  return (
    <form className="flex max-w-xl flex-col gap-4" onSubmit={handleSubmit}>
      <Field label="Client (obligatoire)" htmlFor="import-cust">
        <Select id="import-cust" value={form.customerId} onChange={set('customerId')} required>
          <option value="">— choisir —</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      <Field label="Document (PDF ou DOCX, obligatoire)" htmlFor="import-doc">
        <input
          id="import-doc"
          type="file"
          accept={ACCEPT}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm"
        />
      </Field>
      <Field label="Référence" htmlFor="import-reference" hint="Facultative : à défaut, une référence IMP-AAAA-NNNN est attribuée.">
        <Input id="import-reference" value={form.reference} onChange={set('reference')} />
      </Field>
      <Field label="Titre" htmlFor="import-title" hint="Facultatif : à défaut, déduit du nom du fichier.">
        <Input id="import-title" value={form.title} onChange={set('title')} />
      </Field>
      <Field label="Catégorie" htmlFor="import-cat">
        <Select id="import-cat" value={form.category} onChange={set('category')}>
          <option value="">Maintenance (par défaut)</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{contractCategoryLabel(c)}</option>)}
        </Select>
      </Field>
      <fieldset className="flex flex-col gap-3 rounded border border-line p-3">
        <legend className="px-1 text-13 font-title text-ink">Indications connues (facultatives)</legend>
        <p className="text-xs text-ink-faint">
          Pré-rempliront l’écran de validation, avec priorité sur l’extraction automatique. Rien n’est enregistré
          sur le contrat avant la validation.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Date de début" htmlFor="import-sd">
            <Input id="import-sd" type="date" value={form.startDate} onChange={set('startDate')} />
          </Field>
          <Field label="Date de fin" htmlFor="import-ed">
            <Input id="import-ed" type="date" value={form.endDate} onChange={set('endDate')} />
          </Field>
          <Field label="Signé le" htmlFor="import-sat">
            <Input id="import-sat" type="date" value={form.signedAt} onChange={set('signedAt')} />
          </Field>
          <Field label="Préavis (jours)" htmlFor="import-np">
            <Input id="import-np" type="number" min="0" value={form.noticePeriodDays} onChange={set('noticePeriodDays')} />
          </Field>
          <Field label="Montant HT (€)" htmlFor="import-amt">
            <Input id="import-amt" value={form.amount} onChange={set('amount')} placeholder="1500,00" inputMode="decimal" />
          </Field>
        </div>
      </fieldset>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div>
        <Button type="submit" disabled={!ready || submitting}>
          {submitting ? 'Import…' : 'Importer le contrat'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Dépôt par lot
// ---------------------------------------------------------------------------

export interface BatchResultItem { filename: string; id?: string; error?: string }

export function BatchImportForm({ customers, submitting, error, onSubmit }: ContractImportFormProps) {
  const [customerId, setCustomerId] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const tooMany = files.length > MAX_BATCH_FILES;
  const ready = Boolean(customerId && files.length > 0 && !tooMany);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    const fd = new FormData();
    fd.append('customerId', customerId);
    for (const f of files) fd.append('documents', f);
    onSubmit(fd);
  }

  return (
    <form className="flex max-w-xl flex-col gap-4" onSubmit={handleSubmit}>
      <p className="text-sm text-ink-muted">
        Un contrat est créé par fichier, tous rattachés au même client. Un fichier refusé n’empêche pas l’import des autres.
      </p>
      <Field label="Client (obligatoire)" htmlFor="batch-cust">
        <Select id="batch-cust" value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
          <option value="">— choisir —</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      <Field
        label="Documents (PDF ou DOCX)"
        htmlFor="batch-docs"
        hint={`${MAX_BATCH_FILES} fichiers au maximum par envoi.`}
        error={tooMany ? `Trop de fichiers (${files.length}) : ${MAX_BATCH_FILES} au maximum.` : undefined}
      >
        <input
          id="batch-docs"
          type="file"
          multiple
          accept={ACCEPT}
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          className="block w-full text-sm"
        />
      </Field>
      {files.length > 0 && <p className="text-sm text-ink-muted">{files.length} fichier(s) sélectionné(s).</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div>
        <Button type="submit" disabled={!ready || submitting}>
          {submitting ? 'Import en cours…' : 'Importer le lot'}
        </Button>
      </div>
    </form>
  );
}

export function BatchResults({ items }: { items: BatchResultItem[] }) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => headingRef.current?.focus(), [items]);
  const ok = items.filter((i) => i.id).length;
  return (
    <section aria-labelledby="batch-results-title" className="flex flex-col gap-3">
      <h2 id="batch-results-title" ref={headingRef} tabIndex={-1} className="outline-none">
        Résultat de l’import : {ok} importé(s), {items.length - ok} refusé(s)
      </h2>
      <Table caption="Résultat par fichier" head={<tr><th>Fichier</th><th>Résultat</th><th>Action</th></tr>}>
        {items.map((it, i) => (
          <tr key={`${it.filename}-${i}`}>
            <td>{it.filename}</td>
            <td>
              {it.id ? (
                <Badge tone="success"><Icon name="checkCircle" className="h-3.5 w-3.5" strokeWidth={2} />Importé</Badge>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone="danger"><Icon name="xCircle" className="h-3.5 w-3.5" strokeWidth={2} />Refusé</Badge>
                  <span className="text-sm text-danger">{it.error}</span>
                </span>
              )}
            </td>
            <td>
              {it.id && (
                <Link to={`/contracts/${it.id}/import`} className="text-primary hover:underline">
                  Valider l’import<span className="sr-only"> de {it.filename}</span>
                </Link>
              )}
            </td>
          </tr>
        ))}
      </Table>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : e ? 'Erreur.' : undefined);

export function ContractImportPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState('unitaire');
  const custs = useQuery({
    queryKey: ['customers'],
    queryFn: () => apiGet<{ items: ImportCustomerRow[] }>('/v1/customers'),
  });

  const single = useMutation({
    mutationFn: (fd: FormData) => apiPostForm<{ id: string }>('/v1/contracts/import', fd),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['contracts'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      nav(`/contracts/${c.id}/import`);
    },
  });
  const batch = useMutation({
    mutationFn: (fd: FormData) => apiPostForm<{ items: BatchResultItem[] }>('/v1/contracts/import/batch', fd),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contracts'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  if (custs.isLoading) return <Spinner />;
  if (custs.error || !custs.data) return <p role="alert" className="text-danger">Erreur de chargement.</p>;
  const customers = custs.data.items;

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[{ label: 'Contrats', to: '/contracts' }, { label: 'Importer' }]} />
      <h1>Importer des contrats existants</h1>
      <p className="text-sm text-ink-muted">
        Contrats signés hors plateforme : l’original est conservé tel quel (empreinte SHA-256), une copie OCR
        recherchable est produite, puis chaque contrat est validé champ par champ par un juriste/valideur.
      </p>
      <Card>
        <Tabs
          label="Mode d’import"
          active={tab}
          onChange={setTab}
          tabs={[{ id: 'unitaire', label: 'Import unitaire' }, { id: 'lot', label: 'Import par lot' }]}
          panels={{
            unitaire: (
              <ContractImportForm customers={customers} submitting={single.isPending}
                error={errorText(single.error)} onSubmit={(fd) => single.mutate(fd)} />
            ),
            lot: (
              <div className="flex flex-col gap-6">
                <BatchImportForm customers={customers} submitting={batch.isPending}
                  error={errorText(batch.error)} onSubmit={(fd) => batch.mutate(fd)} />
                {batch.data && <BatchResults items={batch.data.items} />}
              </div>
            ),
          }}
        />
      </Card>
    </div>
  );
}
