import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { uuidv7, withScope, type Scope } from '@lsi/persistence';
import { hiddenTagHtml, signatureBlockTags, documentFooterHtml, type DocumentRenderer } from '@lsi/domain';
import type { ProposalQuote } from '@lsi/pricing';
import { DOCUMENT_RENDERER } from '../documents/renderer.token.js';
import { DOCUMENT_STORAGE, assertKeyMatchesScope, type DocumentStorage } from '../documents/document-storage.port.js';
import { pricingTableHtml, proposalHtmlDocument, renderSections, sha256Hex } from './proposal-content.js';
import { computeState, loadProposal, loadTemplateDefinition, type ProposalSettings } from './proposal-state.js';

export interface SignerForPdf {
  readonly roleLabel: string;
  readonly fullName: string;
  readonly party: 'LSI' | 'CLIENT';
}

/**
 * Documents d'une proposition (brief §12.5, §12.6) :
 *   - PDF de la VERSION, rendu et haché une fois à l'envoi, stocké en
 *     écriture unique : « export PDF à tout moment, identique au contenu de la
 *     version » ;
 *   - PDF de SIGNATURE, rendu à l'acceptation : version + options RETENUES
 *     (PricingSnapshot) + CGV + zone de signature (balises DocuSeal). Son
 *     empreinte est calculée AVANT l'envoi à DocuSeal.
 * Clés `t/<tenant>/c/<client>/proposals/…`, vérifiées par assertKeyMatchesScope.
 */
@Injectable()
export class ProposalDocumentsService {
  constructor(
    @Inject(DOCUMENT_RENDERER) private readonly renderer: DocumentRenderer,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
  ) {}

  private key(scope: { tenantId: string; customerId: string }, proposalId: string, rest: string): string {
    const k = `t/${scope.tenantId}/c/${scope.customerId}/proposals/${proposalId}/${rest}`;
    assertKeyMatchesScope(k, scope);
    return k;
  }

  /** HTML d'une version (aperçu interne, page publique, PDF). */
  async versionHtml(scope: Scope, proposalId: string, settings: ProposalSettings, now: Date, versionId?: string) {
    return withScope(scope, async (tx) => {
      const loaded = await loadProposal(tx, proposalId, versionId);
      const state = computeState(loaded, settings, now, { templateDefinition: await loadTemplateDefinition(tx, loaded.proposal.templateId) });
      const values = loaded.version.lockedAt ? (loaded.version.mergeValues as Record<string, string | number>) : state.mergeValues;
      const sections = renderSections(state.sections, values, loaded.version.terms);
      return {
        loaded,
        state,
        html: proposalHtmlDocument({ number: loaded.proposal.number, title: loaded.version.title, sections, pricingHtml: pricingTableHtml(state.quote) }),
      };
    });
  }

  /**
   * PDF de la version. Version figée : rendu UNE fois puis relu du stockage
   * (empreinte vérifiée) ; brouillon : rendu à la volée, jamais stocké.
   */
  async versionPdf(scope: Scope, proposalId: string, settings: ProposalSettings, now: Date, versionId?: string) {
    const { loaded, html } = await this.versionHtml(scope, proposalId, settings, now, versionId);
    const { proposal, version } = loaded;
    const obj = { tenantId: proposal.tenantId, customerId: proposal.customerId };
    const filename = `${proposal.number}-v${version.versionNumber}.pdf`;
    if (version.pdfObjectKey && version.pdfSha256) {
      const pdf = await this.storage.get(version.pdfObjectKey, obj);
      if (!pdf) throw new NotFoundException('PDF de la version introuvable dans le stockage');
      if (sha256Hex(pdf) !== version.pdfSha256) throw new Error(`empreinte du PDF ${version.pdfObjectKey} incohérente`);
      return { pdf, sha256: version.pdfSha256, filename };
    }
    const rendered = await this.renderer.render({
      html,
      documentTitle: `${proposal.number} — ${version.title}`,
      footerHtml: documentFooterHtml(proposal.number, ''),
    });
    if (!version.lockedAt) return { pdf: rendered.pdf, sha256: rendered.sha256, filename };

    const key = this.key(obj, proposal.id, `versions/${version.id}/proposition.pdf`);
    await this.storage.put(key, rendered.pdf, obj, 'application/pdf');
    await withScope(scope, async (tx) => {
      // Écriture UNIQUE : si un rendu concurrent a déjà posé son PDF, on garde le sien.
      const n = await tx.proposalVersion.updateMany({
        where: { id: version.id, pdfSha256: null },
        data: { pdfObjectKey: key, pdfSha256: rendered.sha256 },
      });
      if (n.count === 1) {
        await tx.storedDocument.createMany({
          data: [{
            id: uuidv7(), tenantId: proposal.tenantId, customerId: proposal.customerId, proposalId: proposal.id,
            kind: 'PROPOSAL_PDF', origin: 'GENERATED', objectKey: key, filename, contentType: 'application/pdf',
            sizeBytes: BigInt(rendered.pdf.length), sha256: rendered.sha256, createdAt: now,
          }],
          skipDuplicates: true,
        });
      }
    });
    return { pdf: rendered.pdf, sha256: rendered.sha256, filename };
  }

  /**
   * PDF final de signature : contenu de la version acceptée + tableau de prix
   * FIGÉ + CGV + zone de signature (une balise signature + date par rôle).
   */
  async signaturePdf(
    scope: Scope,
    proposalId: string,
    signatureRequestId: string,
    quote: ProposalQuote,
    signers: readonly SignerForPdf[],
    settings: ProposalSettings,
    now: Date,
  ) {
    const { loaded, state } = await this.versionHtml(scope, proposalId, settings, now);
    const { proposal, version } = loaded;
    const values = (version.mergeValues ?? state.mergeValues) as Record<string, string | number>;
    const sections = renderSections(state.sections, values, version.terms);
    const signatureHtml = `<table style="width:100%"><tr>${signers
      .map((s) => {
        const tags = signatureBlockTags(s.roleLabel);
        return `<td style="width:50%;vertical-align:top;padding:8px"><strong>${s.party === 'LSI' ? 'Pour LSI Maintenance' : 'Bon pour accord — le client'}</strong>` +
          `<div>${escape(s.fullName)}</div><div style="margin-top:12px">Signature :</div><div style="height:64px">${hiddenTagHtml(tags.signature)}</div>` +
          `<div>Date : ${hiddenTagHtml(tags.date)}</div></td>`;
      })
      .join('')}</tr></table>`;
    const html = proposalHtmlDocument({
      number: proposal.number,
      title: `${version.title} — bon pour accord`,
      sections,
      pricingHtml: pricingTableHtml(quote),
      signatureHtml,
    });
    const rendered = await this.renderer.render({ html, documentTitle: `${proposal.number} — bon pour accord`, footerHtml: documentFooterHtml(proposal.number, '') });
    const obj = { tenantId: proposal.tenantId, customerId: proposal.customerId };
    const key = this.key(obj, proposal.id, `signature/${signatureRequestId}/bon-pour-accord.pdf`);
    await this.storage.put(key, rendered.pdf, obj, 'application/pdf');
    await withScope(scope, (tx) =>
      tx.storedDocument.createMany({
        data: [{
          id: uuidv7(), tenantId: proposal.tenantId, customerId: proposal.customerId, proposalId: proposal.id,
          kind: 'PROPOSAL_PDF', origin: 'GENERATED', objectKey: key, filename: `${proposal.number}-bon-pour-accord.pdf`,
          contentType: 'application/pdf', sizeBytes: BigInt(rendered.pdf.length), sha256: rendered.sha256, createdAt: now,
        }],
        skipDuplicates: true,
      }),
    );
    return { pdf: rendered.pdf, sha256: rendered.sha256, key, filename: `${proposal.number}-bon-pour-accord.pdf` };
  }

  async read(obj: { tenantId: string; customerId: string }, key: string): Promise<Buffer | null> {
    return this.storage.get(key, obj);
  }

  async put(obj: { tenantId: string; customerId: string }, key: string, data: Buffer): Promise<void> {
    assertKeyMatchesScope(key, obj);
    await this.storage.put(key, data, obj, 'application/pdf');
  }
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
