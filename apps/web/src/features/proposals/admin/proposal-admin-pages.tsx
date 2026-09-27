import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../../../lib/api.js';
import { centsToEurosInput, eurosToCents, formatCents } from '../../../lib/money.js';
import { allows } from '../../../lib/permissions.js';
import { useMe } from '../../../lib/queries.js';
import { Badge } from '../../../ui/badge.js';
import { Breadcrumb } from '../../../ui/breadcrumb.js';
import { Button } from '../../../ui/button.js';
import { Card } from '../../../ui/card.js';
import { ConfirmDialog } from '../../../ui/confirm-dialog.js';
import { Input } from '../../../ui/input.js';
import { Modal } from '../../../ui/modal.js';
import { ErrorNote } from '../../../ui/region-card.js';
import { Select } from '../../../ui/select.js';
import { Spinner } from '../../../ui/spinner.js';
import { Table } from '../../../ui/table.js';
import { useToast } from '../../../ui/toast.js';
import { proposalAdminApi, type DefLine, type LibraryItem, type LinePricing } from '../proposal-api.js';
import { ACCEPTANCE_MODE_LABELS, formatDateTime, PRICE_SCOPE_LABELS, RECURRENCE_LABELS, SECTION_KIND_LABELS } from '../proposal-labels.js';

/**
 * Administration du module Propositions (brief §12.9 : l'administrateur gère
 * modèles, bibliothèque, seuils et CGV ; 11-propositions.md §12). Lecture :
 * `proposals.read` ; écriture : `proposals.library.manage`. Disponible même
 * module désactivé, pour tout préparer avant la bascule.
 */

/** Slugs des contrats types exigés par les quatre modèles de l'annexe C (conversion, V2-H47). */
export const REQUIRED_CONTRACT_SLUGS = ['infogerance', 'supervision', 'rssi-externalise', 'sauvegarde-en-ligne'];

const TEMPLATE_STATUS_LABELS: Record<string, string> = { DRAFT: 'Brouillon', PUBLISHED: 'Publié', DEPRECATED: 'Obsolète' };

function AdminFrame({ title, crumb, children, actions }: { title: string; crumb?: { label: string; to: string }; children: ReactNode; actions?: ReactNode }) {
  const tabs: [string, string][] = [
    ['/proposal-admin/templates', 'Modèles'],
    ['/proposal-admin/library', 'Bibliothèque'],
    ['/proposal-admin/terms', 'CGV'],
    ['/proposal-admin/contract-templates', 'Contrats types'],
    ['/proposal-admin/pending', 'Prix à valider'],
  ];
  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[{ label: 'Administration' }, { label: 'Propositions', to: '/proposal-admin/templates' }, ...(crumb ? [crumb] : []), { label: title }]} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-22">{title}</h1>
        {actions}
      </div>
      <nav aria-label="Administration des propositions" className="flex flex-wrap gap-1 border-b border-line">
        {tabs.map(([to, label]) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `-mb-px border-b-2 px-3.5 py-2.5 text-sm font-button ${isActive ? 'border-primary text-primary' : 'border-transparent text-ink-muted hover:text-ink'}`}
          >
            {label}
          </NavLink>
        ))}
      </nav>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modèles
// ---------------------------------------------------------------------------

export function ProposalTemplatesPage() {
  const q = useQuery({ queryKey: ['proposal-templates'], queryFn: proposalAdminApi.templates });
  return (
    <AdminFrame title="Modèles de proposition">
      {q.isLoading ? <Spinner /> : q.error ? <ErrorNote>{errorMessage(q.error)}</ErrorNote> : (
        <Card>
          <Table
            caption="Modèles de proposition"
            head={<tr><th scope="col">Modèle</th><th scope="col">Slug</th><th scope="col">Acceptation</th><th scope="col">Contrat type (slug)</th><th scope="col">Prix à valider</th><th scope="col">État</th></tr>}
          >
            {(q.data?.items ?? []).map((t) => (
              <tr key={t.id}>
                <td><Link to={`/proposal-admin/templates/${t.slug}`} className="font-button text-primary hover:underline">{t.name}</Link></td>
                <td><code className="text-xs">{t.slug}</code></td>
                <td>{ACCEPTANCE_MODE_LABELS[t.acceptanceMode] ?? t.acceptanceMode}</td>
                <td>{t.contractTemplateSlug ? <code className="text-xs">{t.contractTemplateSlug}</code> : <span className="text-danger">aucun</span>}</td>
                <td>{t.pendingValidations > 0 ? <Badge tone="warn">{t.pendingValidations} à valider</Badge> : <Badge tone="success">Validé</Badge>}</td>
                <td className="flex flex-wrap gap-1">
                  {t.archivedAt && <Badge tone="muted">Archivé</Badge>}
                  {t.userModifiedAt ? <Badge tone="info">Modifié dans l’interface</Badge> : <Badge tone="neutral">Version du seed {t.seedVersion ?? '—'}</Badge>}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </AdminFrame>
  );
}

function linePrice(l: DefLine, choices: { key: string; options: { value: string; label: string }[] }[]): string {
  if ('unitPriceCents' in l.pricing) return formatCents(String(l.pricing.unitPriceCents));
  const ch = choices.find((c) => c.key === (l.pricing as { dependsOn: string }).dependsOn);
  return Object.entries(l.pricing.byChoice).map(([v, c]) => `${ch?.options.find((o) => o.value === v)?.label ?? v} : ${formatCents(String(c))}`).join(' · ');
}

export function ProposalTemplateDetailPage() {
  const { slug = '' } = useParams();
  const me = useMe();
  const qc = useQueryClient();
  const canManage = allows(me.data, 'proposals.library.manage');
  const q = useQuery({ queryKey: ['proposal-template', slug], queryFn: () => proposalAdminApi.template(slug) });
  const [line, setLine] = useState<DefLine | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['proposal-template', slug] });
    void qc.invalidateQueries({ queryKey: ['proposal-templates'] });
    void qc.invalidateQueries({ queryKey: ['proposal-pending'] });
  };

  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorNote>{errorMessage(q.error, 'Modèle indisponible.')}</ErrorNote>;
  const t = q.data;
  const def = t.definition;

  return (
    <AdminFrame title={t.name} crumb={{ label: 'Modèles', to: '/proposal-admin/templates' }}>
      {t.pendingValidations.length > 0 && (
        <p className="rounded border border-warn bg-warn-bg px-3 py-2 text-13 text-warn">
          {t.pendingValidations.length} élément(s) « à valider » : {t.pendingValidations.map((p) => `${PRICE_SCOPE_LABELS[p.scope]} « ${p.label} »`).join(', ')}.{' '}
          <Link to="/proposal-admin/pending" className="font-button underline">Prix à valider</Link>
        </p>
      )}
      <TemplateMeta slug={slug} t={t} canManage={canManage} onSaved={refresh} />

      <Card title="Tarification du modèle">
        <Table
          caption="Lignes de prix du modèle"
          head={<tr><th scope="col">Ligne</th><th scope="col">Type</th><th scope="col">Périodicité</th><th scope="col">Unité</th><th scope="col">Prix HT</th><th scope="col">Statut</th><th scope="col"><span className="sr-only">Action</span></th></tr>}
        >
          {def.lines.map((l) => (
            <tr key={l.key}>
              <td>{l.label}{l.priceSource && <span className="block text-xs text-ink-faint">{l.priceSource}</span>}</td>
              <td>{l.kind === 'OPTIONAL' ? 'Option' : l.kind === 'SETUP' ? 'Mise en service' : l.kind === 'INFO' ? 'Hors forfait' : 'Obligatoire'}</td>
              <td>{RECURRENCE_LABELS[l.recurrence] ?? l.recurrence}</td>
              <td>{l.unit}</td>
              <td className="tabular-nums">{linePrice(l, def.choices)}</td>
              <td>{l.priceStatus === 'TO_VALIDATE' || Object.values(l.priceStatusByChoice ?? {}).includes('TO_VALIDATE') ? <Badge tone="warn">À valider</Badge> : <Badge tone="success">Validé</Badge>}</td>
              <td className="text-right">{canManage && <Button size="sm" variant="secondary" aria-label={`Modifier le prix de ${l.label}`} onClick={() => setLine(l)}>Modifier</Button>}</td>
            </tr>
          ))}
        </Table>
        {def.rules.length > 0 && (
          <ul className="mt-3 list-disc pl-5 text-13 text-ink-muted">
            {def.rules.map((r) => <li key={r.key}>{r.type} — {String(r.label ?? r.message ?? r.key)}{typeof r.percent === 'number' ? ` (${r.percent} %)` : ''}{typeof r.amountCents === 'number' ? ` (${formatCents(String(r.amountCents))})` : ''}</li>)}
          </ul>
        )}
      </Card>

      <Card title="Sections par défaut">
        <ol className="flex flex-col gap-1 text-sm">
          {t.sections.map((s) => (
            <li key={s.key} className="flex flex-wrap items-center gap-2">
              <span>{s.title}</span>
              <Badge tone="neutral">{SECTION_KIND_LABELS[s.kind] ?? s.kind}</Badge>
              {s.optional && <Badge tone="info">Facultative</Badge>}
              {s.libraryItemKey && <code className="text-xs text-ink-faint">{s.libraryItemKey}</code>}
              {s.validationStatus === 'TO_VALIDATE' && <Badge tone="warn">À valider</Badge>}
            </li>
          ))}
        </ol>
      </Card>

      {line && <LinePriceDialog slug={slug} line={line} choices={def.choices} onClose={() => setLine(null)} onSaved={() => { setLine(null); refresh(); }} />}
    </AdminFrame>
  );
}

function TemplateMeta({ slug, t, canManage, onSaved }: { slug: string; t: Record<string, any>; canManage: boolean; onSaved: () => void }) {
  const toast = useToast();
  const init = () => ({
    name: String(t.name ?? ''), description: String(t.description ?? ''), target: String(t.target ?? ''), validityDays: String(t.validityDays ?? 30),
    acceptanceMode: String(t.acceptanceMode), providerCountersign: !!t.providerCountersign, signedProposalIsContract: !!t.signedProposalIsContract,
  });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [t]);
  const save = useMutation({
    mutationFn: (b: Record<string, unknown>) => proposalAdminApi.updateTemplate(slug, b),
    onSuccess: () => { toast.show('Modèle enregistré (tracé ; le seed ne le réécrira plus).', 'success'); onSaved(); },
  });
  const [error, setError] = useState<string | undefined>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const init0 = init();
    const b: Record<string, unknown> = {};
    for (const k of ['name', 'description', 'target', 'acceptanceMode'] as const) if (f[k].trim() !== init0[k]) b[k] = f[k].trim();
    for (const k of ['providerCountersign', 'signedProposalIsContract'] as const) if (f[k] !== init0[k]) b[k] = f[k];
    const days = Number(f.validityDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) return setError('Validité : entier entre 1 et 365.');
    if (String(days) !== init0.validityDays) b.validityDays = days;
    setError(undefined);
    if (Object.keys(b).length) save.mutate(b);
  };
  const text = (id: string, label: string, key: 'name' | 'description' | 'target' | 'validityDays') => (
    <div className="flex flex-col gap-[5px]">
      <label htmlFor={id} className="text-xs+ font-button text-ink-muted">{label}</label>
      <Input id={id} value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
    </div>
  );
  return (
    <form aria-label="Paramètres du modèle" onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5 shadow-sm">
      <h2 className="text-15 font-title text-ink">Paramètres du modèle</h2>
      <fieldset disabled={!canManage} className="grid gap-3 sm:grid-cols-2">
        {text('tpl-nom', 'Nom', 'name')}
        {text('tpl-cible', 'Cible', 'target')}
        {text('tpl-description', 'Description', 'description')}
        {text('tpl-validite', 'Validité (jours)', 'validityDays')}
        <div className="flex flex-col gap-[5px]">
          <label htmlFor="tpl-mode" className="text-xs+ font-button text-ink-muted">Mode d’acceptation par défaut</label>
          <Select id="tpl-mode" value={f.acceptanceMode} onChange={(e) => setF({ ...f, acceptanceMode: e.target.value })}>
            <option value="DOCUSEAL_SIGNATURE">{ACCEPTANCE_MODE_LABELS.DOCUSEAL_SIGNATURE}</option>
            <option value="CLICK_ACCEPT">{ACCEPTANCE_MODE_LABELS.CLICK_ACCEPT}</option>
          </Select>
        </div>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.providerCountersign} onChange={(e) => setF({ ...f, providerCountersign: e.target.checked })} />
          Contre-signature LSI Maintenance
        </label>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.signedProposalIsContract} onChange={(e) => setF({ ...f, signedProposalIsContract: e.target.checked })} />
            La proposition signée vaut contrat (contrat créé directement actif)
          </label>
          <p className="text-xs text-warn">Désactivée par défaut : option à faire valider par un juriste (conditions particulières et CGV complètes dans la proposition).</p>
        </div>
      </fieldset>
      <p className="text-13 text-ink-muted">Contrat type associé (conversion) : <code>{t.contractTemplateSlug ?? 'aucun'}</code> — voir « Contrats types ».</p>
      <ErrorNote>{error ?? errorMessage(save.error)}</ErrorNote>
      {canManage && <div><Button type="submit" size="sm" disabled={save.isPending}>Enregistrer le modèle</Button></div>}
    </form>
  );
}

function LinePriceDialog({ slug, line, choices, onClose, onSaved }: {
  slug: string; line: DefLine; choices: { key: string; options: { value: string; label: string }[] }[]; onClose: () => void; onSaved: () => void;
}) {
  const byChoice = 'byChoice' in line.pricing ? line.pricing : null;
  const choice = byChoice ? choices.find((c) => c.key === byChoice.dependsOn) : undefined;
  const [values, setValues] = useState<Record<string, string>>(() =>
    byChoice ? Object.fromEntries(Object.entries(byChoice.byChoice).map(([k, v]) => [k, centsToEurosInput(v)])) : { '': centsToEurosInput((line.pricing as { unitPriceCents: number }).unitPriceCents) },
  );
  const [label, setLabel] = useState(line.label);
  const [source, setSource] = useState(line.priceSource ?? '');
  const [error, setError] = useState<string | undefined>();
  const save = useMutation({
    mutationFn: (b: { label?: string; pricing?: LinePricing; priceSource?: string }) => proposalAdminApi.updateLine(slug, line.key, b),
    onSuccess: onSaved,
  });
  const submit = () => {
    const cents: Record<string, number> = {};
    for (const [k, v] of Object.entries(values)) {
      const c = eurosToCents(v);
      if (c === undefined) return setError('Prix invalide.');
      cents[k] = c;
    }
    const pricing: LinePricing = byChoice ? { dependsOn: byChoice.dependsOn, byChoice: cents } : { unitPriceCents: cents['']! };
    const b: { label?: string; pricing?: LinePricing; priceSource?: string } = {};
    if (JSON.stringify(pricing) !== JSON.stringify(line.pricing)) b.pricing = pricing;
    if (label.trim() !== line.label) b.label = label.trim();
    if (source.trim() && source.trim() !== (line.priceSource ?? '')) b.priceSource = source.trim();
    setError(undefined);
    if (Object.keys(b).length === 0) return onClose();
    save.mutate(b);
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Prix de « ${line.label} »`}
      footer={<><Button variant="secondary" onClick={onClose}>Annuler</Button><Button onClick={submit} disabled={save.isPending}>Enregistrer le prix</Button></>}
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-warn">Un prix modifié repasse « à valider » : il devra être validé (écran « Prix à valider ») avant qu’une proposition qui le retient puisse partir. Le modèle devient propre au tenant (le seed ne le réécrira plus).</p>
        <div className="flex flex-col gap-[5px]">
          <label htmlFor="ligne-libelle" className="text-xs+ font-button text-ink-muted">Libellé</label>
          <Input id="ligne-libelle" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        {Object.keys(values).map((k) => {
          const id = `ligne-prix-${k || 'unique'}`;
          const optLabel = choice?.options.find((o) => o.value === k)?.label ?? k;
          return (
            <div key={k} className="flex flex-col gap-[5px]">
              <label htmlFor={id} className="text-xs+ font-button text-ink-muted">{k ? `Prix HT (€) — ${optLabel}` : 'Prix HT (€)'}</label>
              <Input id={id} inputMode="decimal" value={values[k]} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
            </div>
          );
        })}
        <div className="flex flex-col gap-[5px]">
          <label htmlFor="ligne-source" className="text-xs+ font-button text-ink-muted">Source du prix</label>
          <Input id="ligne-source" value={source} onChange={(e) => setSource(e.target.value)} />
        </div>
        <ErrorNote>{error ?? errorMessage(save.error)}</ErrorNote>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Bibliothèque de contenus
// ---------------------------------------------------------------------------

type LibDraft = { key: string; title: string; folder: string; body: string; requiresLegalReview: boolean };

export function ContentLibraryPage() {
  const me = useMe();
  const canManage = allows(me.data, 'proposals.library.manage');
  const q = useQuery({ queryKey: ['proposal-library'], queryFn: proposalAdminApi.library });
  const [editing, setEditing] = useState<LibraryItem | 'new' | null>(null);
  const items = q.data?.items ?? [];
  const folders = [...new Set(items.map((i) => i.folder))];
  return (
    <AdminFrame title="Bibliothèque de contenus" actions={canManage ? <Button onClick={() => setEditing('new')}>Nouveau contenu</Button> : undefined}>
      <p className="text-13 text-ink-muted">
        Contenus réutilisables, versionnés : le texte est copié dans chaque proposition (avec son empreinte) et figé à l’envoi.
        Modifier le texte copié dans une proposition en fait une clause dérogatoire soumise à revue interne.
      </p>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorNote>{errorMessage(q.error)}</ErrorNote> : items.length === 0 ? <Card><p className="text-13 text-ink-muted">Aucun contenu.</p></Card> : (
        folders.map((f) => (
          <section key={f} aria-label={f} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-5 shadow-sm">
            <h2 className="text-15 font-title text-ink">{f}</h2>
            <ul className="flex flex-col gap-2">
              {items.filter((i) => i.folder === f).map((i) => (
                <li key={i.key} className="flex flex-col gap-1 border-b border-line pb-2 last:border-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-button">{i.title}</span>
                    <code className="text-xs text-ink-faint">{i.key}</code>
                    <Badge tone="muted">v{i.version}</Badge>
                    {i.requiresLegalReview && <Badge tone="warn">Relecture juridique requise</Badge>}
                    {i.userModifiedAt && <Badge tone="info">Modifié dans l’interface</Badge>}
                    <span className="text-xs text-ink-faint">mis à jour le {formatDateTime(i.updatedAt)}</span>
                    <span className="flex-1" />
                    {canManage && <Button size="sm" variant="secondary" aria-label={`Modifier « ${i.title} »`} onClick={() => setEditing(i)}>Modifier</Button>}
                  </div>
                  <p className="line-clamp-3 whitespace-pre-wrap text-13 text-ink-muted">{i.body}</p>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {editing && <LibraryDialog item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </AdminFrame>
  );
}

function LibraryDialog({ item, onClose }: { item: LibraryItem | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<LibDraft>(item
    ? { key: item.key, title: item.title, folder: item.folder, body: item.body, requiresLegalReview: item.requiresLegalReview }
    : { key: '', title: '', folder: '', body: '', requiresLegalReview: false });
  const save = useMutation({
    mutationFn: () => item
      ? proposalAdminApi.updateLibraryItem(item.key, { title: f.title.trim(), folder: f.folder.trim(), body: f.body, requiresLegalReview: f.requiresLegalReview })
      : proposalAdminApi.createLibraryItem({ key: f.key.trim(), title: f.title.trim(), folder: f.folder.trim(), body: f.body, requiresLegalReview: f.requiresLegalReview }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['proposal-library'] });
      toast.show(item ? 'Nouvelle version enregistrée.' : 'Contenu créé.', 'success');
      onClose();
    },
  });
  const title = item ? `Modifier « ${item.title} »` : 'Nouveau contenu';
  const field = (id: string, label: string, key: 'key' | 'title' | 'folder', hint?: string) => (
    <div className="flex flex-col gap-[5px]">
      <label htmlFor={id} className="text-xs+ font-button text-ink-muted">{label}</label>
      <Input id={id} value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
      {hint && <p className="text-xs text-ink-faint">{hint}</p>}
    </div>
  );
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      width={720}
      footer={<><Button variant="secondary" onClick={onClose}>Annuler</Button><Button disabled={save.isPending} onClick={() => save.mutate()}>{item ? 'Enregistrer une nouvelle version' : 'Créer le contenu'}</Button></>}
    >
      <div className="flex flex-col gap-3">
        {!item && field('lib-cle', 'Clé', 'key', 'Identifiant stable en minuscules et tirets (ex. faq-sauvegarde).')}
        {field('lib-titre', 'Titre', 'title')}
        {field('lib-dossier', 'Dossier', 'folder')}
        <div className="flex flex-col gap-[5px]">
          <label htmlFor="lib-texte" className="text-xs+ font-button text-ink-muted">Texte (Markdown)</label>
          <textarea id="lib-texte" className="min-h-[200px] w-full rounded border border-line-strong px-3 py-2 font-mono text-13" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        </div>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.requiresLegalReview} onChange={(e) => setF({ ...f, requiresLegalReview: e.target.checked })} />
          Relecture juridique requise
        </label>
        {item && <p className="text-13 text-ink-muted">Les propositions déjà envoyées gardent le texte figé de leur version.</p>}
        <ErrorNote>{errorMessage(save.error)}</ErrorNote>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// CGV
// ---------------------------------------------------------------------------

export function TermsPage() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = allows(me.data, 'proposals.library.manage');
  const q = useQuery({ queryKey: ['proposal-terms'], queryFn: proposalAdminApi.terms });
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [confirm, setConfirm] = useState(false);
  const publish = useMutation({
    mutationFn: () => proposalAdminApi.publishTerms({ title: title.trim(), body }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ['proposal-terms'] });
      toast.show(`CGV v${t.versionNumber} publiées.`, 'success');
      setConfirm(false);
      setTitle('');
      setBody('');
    },
  });
  const items = q.data?.items ?? [];
  return (
    <AdminFrame title="Conditions générales de vente">
      <p className="text-13 text-ink-muted">Versions immuables : chaque nouvelle version de proposition référence la dernière version publiée. Sans CGV publiées, aucune proposition ne peut partir.</p>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorNote>{errorMessage(q.error)}</ErrorNote> : items.length === 0 ? (
        <p role="alert" className="rounded border border-danger bg-danger-bg px-3 py-2 text-13 text-danger">Aucune version publiée : les propositions sont bloquées (CGV absentes).</p>
      ) : (
        <Card>
          <Table caption="Versions des CGV" head={<tr><th scope="col">Version</th><th scope="col">Titre</th><th scope="col">Publiée le</th><th scope="col">Empreinte SHA-256</th></tr>}>
            {items.map((t, n) => (
              <tr key={t.id}>
                <td>v{t.versionNumber} {n === 0 && <Badge tone="success">En vigueur</Badge>}</td>
                <td>{t.title}</td>
                <td>{formatDateTime(t.createdAt)}</td>
                <td><code className="break-all text-xs">{t.sha256}</code></td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      {canManage && (
        <Card title="Publier une nouvelle version">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-[5px]">
              <label htmlFor="cgv-titre" className="text-xs+ font-button text-ink-muted">Titre de la version</label>
              <Input id="cgv-titre" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="flex flex-col gap-[5px]">
              <label htmlFor="cgv-texte" className="text-xs+ font-button text-ink-muted">Texte des CGV (Markdown)</label>
              <textarea id="cgv-texte" className="min-h-[240px] w-full rounded border border-line-strong px-3 py-2 font-mono text-13" value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
            <div><Button disabled={title.trim().length < 3 || body.trim().length < 20} onClick={() => { publish.reset(); setConfirm(true); }}>Publier une nouvelle version</Button></div>
          </div>
        </Card>
      )}
      <ConfirmDialog open={confirm} title="Publier les CGV ?" confirmLabel="Publier" onClose={() => setConfirm(false)} onConfirm={() => publish.mutate()} pending={publish.isPending} error={errorMessage(publish.error)}>
        <p>La version publiée est immuable (empreinte SHA-256) et s’appliquera à toute nouvelle version de proposition. Les versions déjà envoyées gardent leurs CGV.</p>
      </ConfirmDialog>
    </AdminFrame>
  );
}

// ---------------------------------------------------------------------------
// Correspondance modèle de proposition → contrat type (slug)
// ---------------------------------------------------------------------------

export function ContractTemplateSlugsPage() {
  const me = useMe();
  const toast = useToast();
  const canManage = allows(me.data, 'proposals.library.manage');
  const templates = useQuery({ queryKey: ['proposal-templates'], queryFn: proposalAdminApi.templates });
  const contracts = useQuery({ queryKey: ['contract-templates'], queryFn: proposalAdminApi.contractTemplates, enabled: canManage });
  /** Slugs posés pendant la session (affichage immédiat, avant rechargement de la liste). */
  const [assigned, setAssigned] = useState<Record<string, string | null>>({});
  const [choice, setChoice] = useState<Record<string, string>>({});
  const put = useMutation({
    mutationFn: ({ id, slug }: { id: string; slug: string | null }) => proposalAdminApi.setContractTemplateSlug(id, slug),
    onSuccess: (r) => {
      setAssigned((a) => {
        const next = { ...a };
        // Un slug est unique : on le retire d'un autre contrat type connu.
        for (const [k, v] of Object.entries(next)) if (r.slug && v === r.slug) next[k] = null;
        next[r.id] = r.slug;
        return next;
      });
      toast.show(r.slug ? `Slug « ${r.slug} » associé.` : 'Slug retiré.', 'success');
    },
  });

  if (me.isLoading) return <Spinner />;
  const rows = contracts.data?.items ?? [];
  const slugOf = (id: string, fallback?: string | null) => (id in assigned ? assigned[id] : fallback ?? null);
  const required = [...new Set([...REQUIRED_CONTRACT_SLUGS, ...(templates.data?.items ?? []).map((t) => t.contractTemplateSlug).filter((s): s is string => !!s)])];
  const holder = (slug: string) => rows.find((r) => slugOf(r.id, r.slug) === slug);

  return (
    <AdminFrame title="Contrats types des propositions">
      <p className="rounded border border-warn bg-warn-bg px-3 py-2 text-13 text-warn">
        La conversion d’une proposition signée en contrat utilise la version <strong>publiée</strong> du contrat type dont le slug correspond à celui du modèle de proposition.
        Tant que les slugs <code>infogerance</code>, <code>supervision</code>, <code>rssi-externalise</code> et <code>sauvegarde-en-ligne</code> ne sont pas associés à des contrats types publiés,
        la conversion échoue (erreur visible sur la proposition, retentée automatiquement).
      </p>
      {!canManage ? (
        <p role="alert" className="text-13 text-ink-muted">Écran réservé aux administrateurs.</p>
      ) : contracts.isLoading || templates.isLoading ? <Spinner /> : contracts.error ? <ErrorNote>{errorMessage(contracts.error)}</ErrorNote> : (
        <>
          <Card title="Slugs attendus">
            <Table caption="Slugs attendus par les modèles de proposition" head={<tr><th scope="col">Slug</th><th scope="col">Modèles de proposition</th><th scope="col">Contrat type associé</th></tr>}>
              {required.map((slug) => {
                const h = holder(slug);
                const users = (templates.data?.items ?? []).filter((t) => t.contractTemplateSlug === slug).map((t) => t.name);
                return (
                  <tr key={slug}>
                    <td><code className="text-xs">{slug}</code></td>
                    <td>{users.join(', ') || '—'}</td>
                    <td>
                      {h ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <span>{h.name}</span>
                          {h.status === 'PUBLISHED' ? <Badge tone="success">Publié</Badge> : <Badge tone="danger">Contrat type non publié : la conversion échouera</Badge>}
                        </span>
                      ) : (
                        <Badge tone="danger">Non associé : la conversion échouera</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </Table>
            <p className="mt-2 text-xs text-ink-faint">
              État d’après la liste des contrats types (slug) et les associations faites ici.
            </p>
          </Card>
          <ErrorNote>{errorMessage(put.error)}</ErrorNote>
          <Card title="Contrats types">
            <Table caption="Contrats types" head={<tr><th scope="col">Contrat type</th><th scope="col">Statut</th><th scope="col">Slug actuel</th><th scope="col">Associer</th></tr>}>
              {rows.map((r) => {
                const current = slugOf(r.id, r.slug);
                const value = choice[r.id] ?? current ?? '';
                return (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td><Badge tone={r.status === 'PUBLISHED' ? 'success' : 'neutral'}>{TEMPLATE_STATUS_LABELS[r.status] ?? r.status}</Badge></td>
                    <td>{current ? <code className="text-xs">{current}</code> : '—'}</td>
                    <td>
                      <span className="flex flex-wrap items-center gap-2">
                        <label htmlFor={`slug-${r.id}`} className="sr-only">Slug de {r.name}</label>
                        <Select id={`slug-${r.id}`} className="max-w-[220px]" value={value} onChange={(e) => setChoice({ ...choice, [r.id]: e.target.value })}>
                          <option value="">Aucun slug</option>
                          {[...new Set([...required, ...(current ? [current] : [])])].map((s) => <option key={s} value={s}>{s}</option>)}
                        </Select>
                        <Button size="sm" variant="secondary" aria-label={`Associer ${r.name}`} disabled={put.isPending || value === (current ?? '')} onClick={() => put.mutate({ id: r.id, slug: value || null })}>
                          Enregistrer
                        </Button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </Table>
          </Card>
        </>
      )}
    </AdminFrame>
  );
}
