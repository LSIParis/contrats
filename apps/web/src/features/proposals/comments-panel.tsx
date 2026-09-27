import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../../lib/api.js';
import { allows } from '../../lib/permissions.js';
import type { Me } from '../../lib/queries.js';
import { Badge } from '../../ui/badge.js';
import { Button } from '../../ui/button.js';
import { ErrorNote } from '../../ui/region-card.js';
import { Select } from '../../ui/select.js';
import { Spinner } from '../../ui/spinner.js';
import { proposalsApi, type ProposalComment, type ProposalDetail } from './proposal-api.js';
import { formatDateTime } from './proposal-labels.js';

/**
 * Questions et commentaires du client, par section, et réponses du commercial
 * (brief §12.5). Une question du client ouvre la discussion (EN_DISCUSSION) ;
 * la réponse est visible sur la page publique.
 */
export function CommentsPanel({ detail, me }: { detail: ProposalDetail; me: Me | undefined }) {
  const pid = detail.proposal.id;
  const q = useQuery({ queryKey: ['proposal-comments', pid], queryFn: () => proposalsApi.comments(pid) });
  const canWrite = allows(me, 'proposals.write');
  const title = (k: string | null) => detail.version.sections.find((s) => s.key === k)?.title ?? k;
  const items = q.data?.items ?? [];
  const roots = items.filter((c) => !c.parentId || !items.some((x) => x.id === c.parentId));
  const repliesOf = (id: string) => items.filter((c) => c.parentId === id);

  return (
    <section aria-label="Questions et commentaires" className="flex flex-col gap-4">
      {q.isLoading ? <Spinner /> : q.error ? <ErrorNote>{errorMessage(q.error)}</ErrorNote> : roots.length === 0 ? (
        <p className="text-13 text-ink-muted">Aucune question du client pour l’instant.</p>
      ) : (
        roots.map((c) => (
          <article key={c.id} aria-label={`Message de ${c.authorName}`} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4 shadow-sm">
            <Message c={c} section={c.sectionKey ? title(c.sectionKey) : null} />
            {repliesOf(c.id).map((r) => (
              <div key={r.id} className="ml-6 border-l-2 border-line pl-3"><Message c={r} section={null} /></div>
            ))}
            {canWrite && <ReplyBox proposalId={pid} parent={c} />}
          </article>
        ))
      )}
      {canWrite && <ReplyBox proposalId={pid} parent={null} sections={detail.version.sections.map((s) => ({ key: s.key, title: s.title }))} />}
    </section>
  );
}

function Message({ c, section }: { c: ProposalComment; section: string | null | undefined }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-13">
        <span className="font-button text-ink">{c.authorName}</span>
        <Badge tone={c.authorKind === 'CLIENT' ? 'info' : 'neutral'}>{c.authorKind === 'CLIENT' ? 'Client' : 'LSI Maintenance'}</Badge>
        <span className="text-ink-faint">{formatDateTime(c.createdAt)}</span>
        {section && <span className="text-ink-muted">Section : {section}</span>}
      </div>
      <p className="whitespace-pre-wrap text-sm">{c.body}</p>
    </div>
  );
}

function ReplyBox({ proposalId, parent, sections }: { proposalId: string; parent: ProposalComment | null; sections?: { key: string; title: string }[] }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [sectionKey, setSectionKey] = useState('');
  const send = useMutation({
    mutationFn: () => proposalsApi.reply(proposalId, {
      body: body.trim(),
      ...(parent ? { parentId: parent.id } : {}),
      ...(parent?.sectionKey ? { sectionKey: parent.sectionKey } : sectionKey ? { sectionKey } : {}),
    }),
    onSuccess: () => {
      setBody('');
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['proposal-comments', proposalId] });
    },
  });
  const id = parent ? `reponse-${parent.id}` : 'nouveau-message';
  if (parent && !open) {
    return <div><Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Répondre à {parent.authorName}</Button></div>;
  }
  return (
    <div className={`flex flex-col gap-2 ${parent ? '' : 'rounded-lg border border-line bg-surface p-4 shadow-sm'}`}>
      {!parent && <p className="text-13 font-button text-ink">Nouveau message au client</p>}
      {!parent && sections && (
        <div className="flex flex-col gap-[5px]">
          <label htmlFor="message-section" className="text-xs+ font-button text-ink-muted">Section concernée</label>
          <Select id="message-section" className="max-w-[320px]" value={sectionKey} onChange={(e) => setSectionKey(e.target.value)}>
            <option value="">Proposition entière</option>
            {sections.map((s) => <option key={s.key} value={s.key}>{s.title}</option>)}
          </Select>
        </div>
      )}
      <label htmlFor={id} className="text-xs+ font-button text-ink-muted">{parent ? 'Votre réponse' : 'Message'}</label>
      <textarea id={id} className="min-h-[72px] w-full rounded border border-line-strong px-2.5 py-2 text-sm" value={body} onChange={(e) => setBody(e.target.value)} />
      <ErrorNote>{errorMessage(send.error)}</ErrorNote>
      <div className="flex gap-2">
        <Button size="sm" disabled={!body.trim() || send.isPending} onClick={() => send.mutate()}>{parent ? 'Envoyer la réponse' : 'Envoyer le message'}</Button>
        {parent && <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>Annuler</Button>}
      </div>
    </div>
  );
}
