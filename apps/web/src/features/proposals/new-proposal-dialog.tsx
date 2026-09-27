import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost, errorMessage } from '../../lib/api.js';
import { Button } from '../../ui/button.js';
import { Field } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Modal } from '../../ui/modal.js';
import { ErrorNote } from '../../ui/region-card.js';
import { Select } from '../../ui/select.js';
import { proposalAdminApi, proposalsApi, type AcceptanceMode, type CreateProposalBody } from './proposal-api.js';
import { ACCEPTANCE_MODE_LABELS } from './proposal-labels.js';

export interface CustomerOption { id: string; name: string }
interface Contact { id: string; firstName: string; lastName: string; email: string; jobTitle: string | null; isSignatory: boolean }

/**
 * Création d'une proposition : client existant ou nouveau prospect (créé par
 * `POST /v1/customers`), modèle de l'annexe C par son slug (ou proposition
 * vierge), mode d'acceptation, contacts ajoutés comme destinataires.
 */
export function NewProposalDialog({ onClose, customers, canCreateCustomer }: { onClose: () => void; customers: CustomerOption[]; canCreateCustomer: boolean }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'existing' | 'prospect'>('existing');
  const [customerId, setCustomerId] = useState('');
  const [prospectName, setProspectName] = useState('');
  const [prospectSiren, setProspectSiren] = useState('');
  const [templateSlug, setTemplateSlug] = useState('');
  const [acceptanceMode, setAcceptanceMode] = useState<'' | AcceptanceMode>('');
  const [title, setTitle] = useState('');
  const [contactIds, setContactIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const templates = useQuery({ queryKey: ['proposal-templates'], queryFn: proposalAdminApi.templates });
  const contacts = useQuery({
    queryKey: ['customer', customerId],
    queryFn: () => apiGet<{ contacts: Contact[] }>(`/v1/customers/${encodeURIComponent(customerId)}`),
    enabled: mode === 'existing' && !!customerId,
  });

  const ready = mode === 'existing' ? !!customerId : prospectName.trim().length > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setPending(true);
    setError(undefined);
    try {
      let cid = customerId;
      if (mode === 'prospect') {
        const created = await apiPost<{ id: string }>('/v1/customers', {
          name: prospectName.trim(),
          ...(prospectSiren.trim() ? { siren: prospectSiren.trim() } : {}),
        });
        cid = created.id;
      }
      const body: CreateProposalBody = {
        customerId: cid,
        ...(templateSlug ? { templateSlug } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(acceptanceMode ? { acceptanceMode } : {}),
        ...(mode === 'existing' && contactIds.length ? { contactIds } : {}),
      };
      const r = await proposalsApi.create(body);
      navigate(`/proposals/${r.proposal.id}`);
    } catch (err) {
      setError(errorMessage(err, 'Création impossible.'));
    } finally {
      setPending(false);
    }
  }

  const activeTemplates = (templates.data?.items ?? []).filter((t) => !t.archivedAt);

  return (
    <Modal
      open
      onClose={onClose}
      title="Nouvelle proposition"
      width={620}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Annuler</Button>
          <Button type="submit" form="nouvelle-proposition" disabled={!ready || pending}>{pending ? 'Création…' : 'Créer la proposition'}</Button>
        </>
      }
    >
      <form id="nouvelle-proposition" onSubmit={submit} className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs+ font-button text-ink-muted">Destinataire commercial</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="inline-flex items-center gap-2">
              <input type="radio" name="type-client" checked={mode === 'existing'} onChange={() => setMode('existing')} /> Client existant
            </label>
            {canCreateCustomer && (
              <label className="inline-flex items-center gap-2">
                <input type="radio" name="type-client" checked={mode === 'prospect'} onChange={() => setMode('prospect')} /> Nouveau prospect
              </label>
            )}
          </div>
        </fieldset>

        {mode === 'existing' ? (
          <Field label="Client ou prospect" htmlFor="np-client">
            <Select id="np-client" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setContactIds([]); }}>
              <option value="">Choisir…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Raison sociale" htmlFor="np-nom">
              <Input id="np-nom" value={prospectName} onChange={(e) => setProspectName(e.target.value)} />
            </Field>
            <Field label="SIREN (facultatif)" htmlFor="np-siren" hint="9 chiffres.">
              <Input id="np-siren" value={prospectSiren} inputMode="numeric" onChange={(e) => setProspectSiren(e.target.value)} />
            </Field>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Modèle" htmlFor="np-modele" hint="Modèles de l’annexe C ; « vierge » : tableau de prix à définir.">
            <Select id="np-modele" value={templateSlug} onChange={(e) => setTemplateSlug(e.target.value)}>
              <option value="">Proposition vierge</option>
              {activeTemplates.map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Mode d’acceptation" htmlFor="np-mode">
            <Select id="np-mode" value={acceptanceMode} onChange={(e) => setAcceptanceMode(e.target.value as '' | AcceptanceMode)}>
              <option value="">Selon le modèle</option>
              <option value="DOCUSEAL_SIGNATURE">{ACCEPTANCE_MODE_LABELS.DOCUSEAL_SIGNATURE}</option>
              <option value="CLICK_ACCEPT">{ACCEPTANCE_MODE_LABELS.CLICK_ACCEPT}</option>
            </Select>
          </Field>
        </div>

        <Field label="Titre (facultatif)" htmlFor="np-titre" hint="Par défaut : « Modèle — Client ».">
          <Input id="np-titre" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>

        {mode === 'existing' && customerId && (contacts.data?.contacts.length ?? 0) > 0 && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs+ font-button text-ink-muted">Destinataires (contacts du client)</legend>
            {contacts.data!.contacts.map((c) => (
              <label key={c.id} className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={contactIds.includes(c.id)}
                  onChange={(e) => setContactIds((ids) => (e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id)))}
                />
                {c.firstName} {c.lastName}
                <span className="text-ink-faint">— {c.email}{c.isSignatory ? ' (signataire)' : ''}</span>
              </label>
            ))}
          </fieldset>
        )}
        <ErrorNote>{error}</ErrorNote>
      </form>
    </Modal>
  );
}
