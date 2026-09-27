import { createContext, useContext, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiPost, errorMessage } from '../../lib/api.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';
import { Modal } from '../../ui/modal.js';
import { ErrorNote } from '../../ui/region-card.js';
import { aiUnavailableReason, useAiAvailability, type AiSource } from '../ai/ai-api.js';
import { AiPrivacyNotice, AiSources, AiUnavailable } from '../ai/ai-notice.js';
import type { ProposalDetail } from './proposal-api.js';

/**
 * Assistance IA à la rédaction des propositions (lot 9.9, 11-propositions.md §13) :
 * rédaction des sections « Contexte », « Enjeux », « Solution proposée » à partir
 * d'une prise de notes PSEUDONYMISÉE, recherche publique sur le prospect sur
 * option EXPLICITE (raison sociale et site web seulement), reformulation /
 * synthèse proposée et jamais appliquée sans « Remplacer ». Toute section écrite
 * par l'IA reste « à relire » : ni « prête », ni envoi avant validation humaine.
 */

export type AiSection = 'contexte' | 'enjeux' | 'solution';
const SECTIONS: [AiSection, string][] = [['contexte', 'Contexte'], ['enjeux', 'Enjeux'], ['solution', 'Solution proposée']];

export interface AiDraftResult {
  proposal: ProposalDetail;
  provider: string;
  pointsToVerify: string[];
  research: { sector: string; size: string; summary: string; recentNews: { title: string; date: string }[] } | null;
  sources: AiSource[];
  warnings: string[];
}
export interface AiRephraseResult { text: string; changes: string[]; provider: string; warnings: string[] }

/** Disponibilité de l'IA pour l'éditeur (proposition, fournisseur, raison d'indisponibilité). */
export interface ProposalAiState { proposalId: string; enabled: boolean; reason: string | null; provider: string | null }
export const ProposalAiContext = createContext<ProposalAiState>({ proposalId: '', enabled: false, reason: null, provider: null });

export function useProposalAiState(proposalId: string, active: boolean): ProposalAiState {
  const a = useAiAvailability(active);
  if (!active) return { proposalId, enabled: false, reason: null, provider: null };
  if (a.isLoading) return { proposalId, enabled: false, reason: null, provider: null };
  const reason = aiUnavailableReason(a.data);
  return { proposalId, enabled: reason === null, reason, provider: a.data?.provider ?? null };
}

export function AiDraftButton({ disabledReason, onDone }: { disabledReason: string | null; onDone: (d: ProposalDetail) => void }) {
  const ai = useContext(ProposalAiContext);
  const [open, setOpen] = useState(false);
  const reason = ai.reason ?? disabledReason;
  return (
    <>
      <Button size="sm" variant="secondary" disabled={!ai.enabled || !!disabledReason} onClick={() => setOpen(true)}>Rédiger avec l’IA</Button>
      {reason && <AiUnavailable reason={reason} />}
      {open && <AiDraftDialog onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  );
}

function AiDraftDialog({ onClose, onDone }: { onClose: () => void; onDone: (d: ProposalDetail) => void }) {
  const ai = useContext(ProposalAiContext);
  const [notes, setNotes] = useState('');
  const [sections, setSections] = useState<AiSection[]>(['contexte', 'enjeux', 'solution']);
  const [research, setResearch] = useState(false);
  const [website, setWebsite] = useState('');
  const draft = useMutation({
    mutationFn: () => apiPost<AiDraftResult>(`/v1/proposals/${encodeURIComponent(ai.proposalId)}/ai/draft`, {
      notes: notes.trim(),
      sections,
      publicResearch: research,
      ...(research && website.trim() ? { website: website.trim() } : {}),
    }),
    onSuccess: (r) => onDone(r.proposal),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (notes.trim().length >= 20 && sections.length) draft.mutate();
  };
  const r = draft.data;
  return (
    <Modal
      open
      onClose={onClose}
      title="Rédiger avec l’IA"
      width={680}
      footer={r ? (
        <Button onClick={onClose}>Fermer la rédaction</Button>
      ) : (
        <>
          <Button variant="secondary" onClick={onClose}>Annuler</Button>
          <Button type="submit" form="ia-redaction" disabled={draft.isPending || notes.trim().length < 20 || sections.length === 0}>
            {draft.isPending ? 'Rédaction en cours…' : 'Lancer la rédaction'}
          </Button>
        </>
      )}
    >
      {r ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="rounded border border-warn bg-warn-bg px-3 py-2 text-13 text-warn">
            Sections écrites et marquées « Généré par IA — à relire » : relisez-les et validez-les une à une avant de marquer la proposition prête.
          </p>
          {r.pointsToVerify.length > 0 && (
            <div>
              <p className="font-button text-ink">Points à vérifier</p>
              <ul className="ml-4 list-disc text-13">{r.pointsToVerify.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}
          {r.research && (
            <div className="flex flex-col gap-1 text-13">
              <p className="font-button text-ink">Recherche publique sur l’entreprise</p>
              {r.research.sector && <p>Secteur : {r.research.sector}</p>}
              {r.research.size && <p>Taille : {r.research.size}</p>}
              <p>{r.research.summary}</p>
              {r.research.recentNews.length > 0 && (
                <ul className="ml-4 list-disc">{r.research.recentNews.map((n) => <li key={n.title}>{n.date ? `${n.date} — ` : ''}{n.title}</li>)}</ul>
              )}
            </div>
          )}
          <AiSources sources={r.sources} warnings={r.warnings} />
        </div>
      ) : (
        <form id="ia-redaction" onSubmit={submit} className="flex flex-col gap-3">
          <AiPrivacyNotice provider={ai.provider} />
          <div className="flex flex-col gap-[5px]">
            <label htmlFor="ia-notes" className="text-xs+ font-button text-ink-muted">Prise de notes</label>
            <textarea id="ia-notes" className="min-h-[140px] w-full rounded border border-line-strong px-3 py-2 text-sm" value={notes} onChange={(e) => setNotes(e.target.value)} />
            <p className="text-xs text-ink-faint">20 caractères au moins : besoins, parc, enjeux exprimés par le client.</p>
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs+ font-button text-ink-muted">Sections à rédiger</legend>
            {SECTIONS.map(([k, label]) => (
              <label key={k} className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={sections.includes(k)} onChange={(e) => setSections((s) => (e.target.checked ? SECTIONS.map(([x]) => x).filter((x) => x === k || s.includes(x)) : s.filter((x) => x !== k)))} />
                {label}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-col gap-2 rounded border border-line p-3">
            <label className="inline-flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={research} onChange={(e) => setResearch(e.target.checked)} />
              <span>Recherche publique sur l’entreprise (seules la raison sociale et l’adresse du site sont transmises)</span>
            </label>
            {research && (
              <div className="flex flex-col gap-[5px]">
                <label htmlFor="ia-site" className="text-xs+ font-button text-ink-muted">Site web de l’entreprise</label>
                <Input id="ia-site" type="url" placeholder="https://" value={website} onChange={(e) => setWebsite(e.target.value)} />
              </div>
            )}
          </div>
          <p className="text-xs text-ink-faint">Les sections existantes portant ces clés sont remplacées ; aucune donnée personnelle ni aucun montant n’est transmis en clair.</p>
          <ErrorNote>{errorMessage(draft.error)}</ErrorNote>
        </form>
      )}
    </Modal>
  );
}

/** Reformulation / synthèse d'un texte : suggestion, appliquée seulement par « Remplacer ». */
export function AiRephrase({ label, text, onReplace }: { label: string; text: string; onReplace: (t: string) => void }) {
  const ai = useContext(ProposalAiContext);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'reformuler' | 'synthetiser'>('reformuler');
  const run = useMutation({
    mutationFn: () => apiPost<AiRephraseResult>(`/v1/proposals/${encodeURIComponent(ai.proposalId)}/ai/rephrase`, { text, mode }),
  });
  if (!ai.enabled || !text.trim()) return null;
  if (!open) {
    return <div><Button size="sm" variant="ghost" onClick={() => { run.reset(); setOpen(true); }}>Reformuler avec l’IA — {label}</Button></div>;
  }
  const name = `ia-mode-${label.replace(/\W+/g, '-')}`;
  return (
    <section aria-label={`Suggestion IA — ${label}`} className="flex flex-col gap-2 rounded border border-info bg-info-bg p-3 text-13">
      <div role="radiogroup" aria-label="Type de suggestion" className="flex flex-wrap items-center gap-4">
        <label className="inline-flex items-center gap-2"><input type="radio" name={name} checked={mode === 'reformuler'} onChange={() => setMode('reformuler')} /> Reformuler</label>
        <label className="inline-flex items-center gap-2"><input type="radio" name={name} checked={mode === 'synthetiser'} onChange={() => setMode('synthetiser')} /> Synthétiser</label>
        <Button size="sm" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Patientez…' : 'Proposer'}</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Fermer</Button>
      </div>
      <ErrorNote>{errorMessage(run.error)}</ErrorNote>
      {run.data && (
        <>
          <div className="whitespace-pre-wrap rounded border border-line bg-surface px-3 py-2 text-sm text-ink">{run.data.text}</div>
          {run.data.changes.length > 0 && <ul className="ml-4 list-disc text-ink">{run.data.changes.map((c) => <li key={c}>{c}</li>)}</ul>}
          <AiSources sources={[]} warnings={run.data.warnings} />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => { onReplace(run.data!.text); setOpen(false); }}>Remplacer</Button>
            <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>Ignorer</Button>
          </div>
        </>
      )}
    </section>
  );
}
