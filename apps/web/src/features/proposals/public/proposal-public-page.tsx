import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BrandChip, LegalFooter } from '../../../ui/layout.js';
import { Badge } from '../../../ui/badge.js';
import { Button, buttonClass } from '../../../ui/button.js';
import { Icon } from '../../../ui/icons.js';
import { Spinner } from '../../../ui/spinner.js';
import { DecisionPanel, OtpGate } from './decision-panel.js';
import { PricingTable } from './pricing-table.js';
import { base, formatDate, PublicApiError, publicApi, type PublicComment, type PublicView, type Selection } from './public-api.js';
import { useReadingTracker } from './use-reading-tracker.js';

/**
 * Page web publique d'une proposition — `/p/:token` (brief §12.5).
 *
 * Hors session (lien personnel par destinataire), jamais indexée (l'API et la route
 * posent `X-Robots-Tag: noindex`), aucune ressource ni traceur tiers, bannière
 * d'information sur le suivi de lecture. Responsive, mobile d'abord.
 */
const STATUS_TONE: Record<string, 'info' | 'success' | 'warn' | 'danger' | 'neutral'> = {
  SENT: 'info', VIEWED: 'info', IN_DISCUSSION: 'warn', ACCEPTED: 'success', PENDING_SIGNATURE: 'warn',
  SIGNED: 'success', CONVERTED: 'success', EXPIRED: 'danger', DECLINED: 'danger', WITHDRAWN: 'neutral',
};

export function ProposalPublicPage() {
  const { token = '' } = useParams();
  const qc = useQueryClient();
  const key = ['proposition-publique', token];
  const q = useQuery({ queryKey: key, queryFn: () => publicApi.view(token), retry: false });
  const view = q.data;
  const content = view?.content ?? null;
  useReadingTracker(token, !!content, content?.sections.map((s) => s.key) ?? []);

  if (q.isLoading) return <Frame><Spinner label="Chargement de la proposition…" /></Frame>;
  if (q.error) return <Frame><LinkError error={q.error} /></Frame>;
  if (!view) return null;

  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const onSelection = async (change: Partial<Selection>) => {
    const r = await publicApi.select(token, change);
    qc.setQueryData<PublicView>(key, (old) =>
      old?.content ? { ...old, content: { ...old.content, pricing: { ...old.content.pricing, selection: r.selection, quote: r.quote } } } : old,
    );
  };

  return (
    <Frame>
      <header className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5 shadow-sm sm:p-7">
        <div className="flex flex-wrap items-center gap-2 text-13 text-ink-muted">
          <span>Proposition n° {view.proposal.number}</span>
          <span aria-hidden="true">·</span>
          <span>version {view.proposal.versionNumber}</span>
          <Badge tone={STATUS_TONE[view.proposal.status] ?? 'neutral'}>{view.proposal.statusLabel}</Badge>
        </div>
        <h1 className="text-22 sm:text-[26px]">{view.proposal.title}</h1>
        <p className="text-sm text-ink-muted">
          Pour {view.recipient.fullName}
          {view.proposal.expiresAt && !view.expired && <> · valable jusqu’au {formatDate(view.proposal.expiresAt)}</>}
        </p>
        <div>
          <a
            className={buttonClass('secondary', 'sm')}
            href={`${base(token)}/pdf`}
            referrerPolicy="no-referrer"
            rel="noreferrer"
          >
            <Icon name="download" /> Télécharger en PDF
          </a>
        </div>
      </header>

      <p role="note" className="flex items-start gap-2 rounded-lg border border-line bg-info-bg px-4 py-3 text-13 text-info">
        <Icon name="info" /> <span>{view.trackingNotice}</span>
      </p>

      <StateBanner view={view} />

      {!content ? (
        view.otp.required && !view.otp.verified ? (
          <section className="rounded-lg border border-line bg-surface p-5 shadow-sm">
            <h2 className="mb-3 text-17">Accès sécurisé</h2>
            <OtpGate token={token} intro="Cette proposition est confidentielle : un code à usage unique vous est envoyé par e-mail pour la consulter." onVerified={refresh} />
          </section>
        ) : null
      ) : (
        content.sections.map((s) => (
          <section
            key={s.key}
            id={`section-${s.key}`}
            data-section-key={s.key}
            aria-labelledby={`titre-${s.key}`}
            className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5 shadow-sm sm:p-7"
          >
            <h2 id={`titre-${s.key}`} className="text-17">{s.title}</h2>
            {s.aiPendingReview && <p className="text-xs text-warn">Contenu rédigé avec assistance IA, en cours de relecture.</p>}
            {/* HTML produit ET assaini par le serveur (texte échappé, liste blanche de balises) : aucun script possible. */}
            <div className="proposition-contenu flex flex-col gap-2 text-sm leading-relaxed [&_h2]:text-15 [&_h3]:text-15 [&_li]:ml-5 [&_table]:w-full [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc" dangerouslySetInnerHTML={{ __html: s.html }} />
            {s.kind === 'PRICING' && (
              <PricingTable pricing={content.pricing} editable={!!view.actions?.canConfigure} onChange={onSelection} />
            )}
            {s.kind === 'SIGNATURE' && <DecisionPanel token={token} view={view} onDone={refresh} />}
            {view.actions?.canComment && <SectionComments token={token} sectionKey={s.key} comments={view.comments} onPosted={refresh} />}
          </section>
        ))
      )}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-page">
      <div className="border-b border-line bg-surface px-4 py-3 sm:px-7"><BrandChip /></div>
      <main id="contenu" className="mx-auto flex w-full max-w-[900px] flex-1 flex-col gap-4 px-4 py-6 sm:px-6">{children}</main>
      <LegalFooter />
    </div>
  );
}

function LinkError({ error }: { error: unknown }) {
  const e = error instanceof PublicApiError ? error : null;
  const message =
    e?.code === 'LINK_REVOKED'
      ? 'Ce lien n’est plus valable : la proposition a été modifiée ou vous a été renvoyée. Utilisez le dernier lien reçu par e-mail.'
      : e?.code === 'LINK_EXPIRED'
        ? 'Ce lien a expiré. Contactez votre interlocuteur LSI-Maintenance pour recevoir une proposition à jour.'
        : e?.status === 429
          ? 'Trop de requêtes : réessayez dans un instant.'
          : 'Ce lien de proposition est introuvable. Vérifiez l’adresse reçue par e-mail.';
  return (
    <section role="alert" className="rounded-lg border border-line bg-surface p-6 text-center shadow-sm">
      <h1 className="mb-2 text-17">Proposition indisponible</h1>
      <p className="text-sm text-ink-muted">{message}</p>
    </section>
  );
}

function StateBanner({ view }: { view: PublicView }) {
  const st = view.proposal.status;
  let text: string | null = null;
  let tone = 'border-line bg-surface text-ink';
  if (view.superseded) text = 'Une nouvelle version de cette proposition est en préparation : cette version ne peut plus être acceptée.';
  else if (view.expired) {
    text = `Cette proposition a expiré${view.proposal.expiresAt ? ` le ${formatDate(view.proposal.expiresAt)}` : ''}. Elle ne peut plus être acceptée : contactez votre interlocuteur LSI-Maintenance pour la réactiver.`;
    tone = 'border-danger bg-danger-bg text-danger';
  } else if (st === 'DECLINED') text = 'Vous avez décliné cette proposition. Merci de votre retour.';
  else if (st === 'WITHDRAWN') text = 'Cette proposition a été retirée par LSI-Maintenance.';
  else if (st === 'ACCEPTED') text = 'Proposition acceptée : la signature électronique va suivre.';
  else if (st === 'PENDING_SIGNATURE') text = 'Proposition acceptée : signature électronique en cours.';
  else if (st === 'SIGNED' || st === 'CONVERTED') {
    text = 'Proposition signée. Merci de votre confiance.';
    tone = 'border-success bg-success-bg text-success';
  }
  if (!text) return null;
  return <p role="status" className={`rounded-lg border px-4 py-3 text-sm ${tone}`}>{text}</p>;
}

function SectionComments({ token, sectionKey, comments, onPosted }: { token: string; sectionKey: string; comments: PublicComment[]; onPosted: () => void }) {
  const mine = comments.filter((c) => c.sectionKey === sectionKey || (c.parentId && comments.some((p) => p.id === c.parentId && p.sectionKey === sectionKey)));
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `question-${sectionKey}`;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await publicApi.comment(token, { body: body.trim(), sectionKey });
      setBody('');
      setOpen(false);
      onPosted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      {mine.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Questions et réponses">
          {mine.map((c) => (
            <li key={c.id} className={`rounded px-3 py-2 text-13 ${c.authorKind === 'INTERNAL' ? 'ml-6 bg-mint-50' : 'bg-slate-50'}`}>
              <span className="font-button">{c.authorName}</span> <span className="text-ink-faint">— {formatDate(c.createdAt)}</span>
              <p className="whitespace-pre-line">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      {!open ? (
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setOpen(true)}>
          <Icon name="message" /> Poser une question
        </Button>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
          <label htmlFor={id} className="text-xs+ font-button text-ink-muted">Votre question sur cette section</label>
          <textarea id={id} rows={3} maxLength={5000} required value={body} onChange={(e) => setBody(e.target.value)} className="w-full rounded border border-line-strong bg-surface px-2.5 py-2 text-sm" />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !body.trim()}>Envoyer</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
          </div>
          {error && <p role="alert" className="text-13 text-danger">{error}</p>}
        </form>
      )}
    </div>
  );
}
