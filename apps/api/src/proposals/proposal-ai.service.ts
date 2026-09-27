import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { withScope, type Scope } from '@lsi/persistence';
import { pseudonymize, type PseudonymizationMap } from '@lsi/domain';
import { AiGateway } from '../ai-drafting/ai-gateway.service.js';
import { knownEntitiesOf } from '../ai-drafting/contract-ai.service.js';
import { reidentifyDeep } from '../ai-drafting/drafting-pseudonymization.js';
import { PROPOSAL_AI_SECTIONS, SCHEMA_NAMES } from '../ai-drafting/drafting-schemas.js';
import { ProposalsService } from './proposals.service.js';

const SECTION_TITLES: Record<(typeof PROPOSAL_AI_SECTIONS)[number], string> = {
  contexte: 'Contexte',
  enjeux: 'Enjeux',
  solution: 'Solution proposée',
};

export const ProposalAiDraftSchema = z
  .object({
    notes: z.string().trim().min(20, 'Prise de notes trop courte (20 caractères au moins).').max(12_000),
    sections: z.array(z.enum(PROPOSAL_AI_SECTIONS)).min(1).max(3).default(['contexte', 'enjeux', 'solution']),
    /**
     * Recherche publique sur l'entreprise : option EXPLICITE, à chaque demande
     * (brief §12.3). Ne transmet que la raison sociale et le site web.
     */
    publicResearch: z.boolean().default(false),
    website: z.url().max(300).refine((u) => /^https?:\/\//.test(u), 'Adresse http(s) attendue.').optional(),
  })
  .strict();
export type ProposalAiDraft = z.infer<typeof ProposalAiDraftSchema>;

export const ProposalAiRephraseSchema = z
  .object({ text: z.string().trim().min(1).max(12_000), mode: z.enum(['reformuler', 'synthetiser']) })
  .strict();

/**
 * Assistance IA à la rédaction d'une proposition (lot 9.9, brief §12.3).
 *
 * - Notes du commercial PSEUDONYMISÉES (client, contacts, SIREN, montants…).
 * - Recherche publique facultative : un appel SÉPARÉ qui ne reçoit que la
 *   raison sociale et le site web ; sa synthèse est pseudonymisée avant
 *   d'être jointe aux notes.
 * - Sections écrites marquées « générée par IA » : l'envoi est bloqué
 *   jusqu'à leur validation humaine ; sources conservées avec la section.
 */
@Injectable()
export class ProposalAiService {
  constructor(private readonly gateway: AiGateway, private readonly proposals: ProposalsService) {}

  async draft(scope: Scope, id: string, input: ProposalAiDraft, now: Date) {
    await this.proposals.assertEnabled(scope);
    const ctx = await this.context(scope, id);
    let map: PseudonymizationMap = {};
    const p = (t: string) => { const x = pseudonymize(t, ctx.known, { map }); map = x.map; return x.text; };

    let research: { sector: string; size: string; summary: string; recentNews: { title: string; date: string }[] } | null = null;
    const sources: { url: string; title: string }[] = [];
    const warnings: string[] = [];
    if (input.publicResearch) {
      const r = await this.gateway.call(scope, { operation: 'PROSPECT_RESEARCH', contractId: null, schemaName: SCHEMA_NAMES.companyResearch },
        (prov, selection) => prov.researchCompany({
          companyName: ctx.companyName,
          ...(input.website ? { website: input.website } : {}),
          ...(selection ? { selection } : {}),
        }), now);
      research = r.data;
      sources.push(...r.sources.map((s) => ({ url: s.url, title: s.title })));
      warnings.push(...r.warnings);
    }

    const researchText = research
      ? [research.sector && `Secteur : ${research.sector}`, research.size && `Taille : ${research.size}`, research.summary,
        ...research.recentNews.map((n) => `Actualité${n.date ? ` (${n.date})` : ''} : ${n.title}`)].filter(Boolean).join('\n')
      : undefined;
    const r = await this.gateway.call(scope, { operation: 'PROPOSAL_DRAFT', contractId: null, schemaName: SCHEMA_NAMES.proposalDraft },
      (prov, selection) => prov.draftProposalSections({
        offer: p(ctx.offer),
        sections: input.sections,
        notes: p(input.notes),
        ...(researchText ? { research: p(researchText) } : {}),
        knownEntities: ctx.known,
        ...(selection ? { selection } : {}),
      }), now);
    sources.push(...r.sources.map((s) => ({ url: s.url, title: s.title })));
    warnings.push(...r.warnings);
    const out = reidentifyDeep(r.data, map);

    const wanted = new Set(input.sections);
    const drafted = out.sections
      .filter((s) => wanted.has(s.key))
      .map((s) => ({ key: s.key, title: s.title || SECTION_TITLES[s.key], markdown: s.text }));
    const detail = await this.proposals.applyAiSections(scope, id, drafted, dedupe(sources), now);
    return { proposal: detail, provider: r.provider, pointsToVerify: out.pointsToVerify, research, sources: dedupe(sources), warnings };
  }

  /** Reformulation ou synthèse : suggestion SEULEMENT, jamais appliquée. */
  async rephrase(scope: Scope, id: string, input: z.infer<typeof ProposalAiRephraseSchema>, now: Date) {
    await this.proposals.assertEnabled(scope);
    const ctx = await this.context(scope, id);
    const { text, map } = pseudonymize(input.text, ctx.known);
    const r = await this.gateway.call(scope, { operation: 'PROPOSAL_REPHRASE', contractId: null, schemaName: SCHEMA_NAMES.proposalRephrase },
      (prov, selection) => prov.rephraseProposalText({ text, mode: input.mode, knownEntities: ctx.known, ...(selection ? { selection } : {}) }), now);
    return { provider: r.provider, warnings: r.warnings, ...reidentifyDeep(r.data, map) };
  }

  private async context(scope: Scope, id: string) {
    return withScope(scope, async (tx) => {
      const p = await tx.proposal.findUnique({
        where: { id },
        include: { customer: { include: { contacts: true } }, template: { select: { name: true } } },
      });
      if (!p) throw new NotFoundException('Proposition introuvable');
      const contacts = p.customer.contacts;
      return {
        offer: p.template?.name ?? p.title,
        companyName: p.customer.legalName ?? p.customer.name,
        known: knownEntitiesOf(p.customer, contacts.map((k) => `${k.firstName} ${k.lastName}`), contacts),
      };
    });
  }
}

function dedupe(sources: { url: string; title: string }[]) {
  return [...new Map(sources.map((s) => [s.url, s])).values()];
}
