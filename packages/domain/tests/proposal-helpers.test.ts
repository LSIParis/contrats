import { describe, test, expect } from 'vitest';
import {
  MERGE_TAG_CATALOG,
  findMergeTags,
  renderMergeTags,
  unknownMergeTags,
  formatMergeValue,
} from '../src/proposal/merge-tags.js';
import { formatProposalNumber, parseProposalNumber } from '../src/proposal/numbering.js';
import { decideFollowUp, planFollowUps, FOLLOW_UP_MIN_SPACING_MS } from '../src/proposal/follow-ups.js';
import { truncateIp } from '../src/proposal/tracking.js';

describe('balises de fusion', () => {
  test('repère les balises, espaces tolérés', () => {
    expect(findMergeTags('Bonjour {{contact.nom}}, {{ client.raisonSociale }} !')).toEqual([
      'contact.nom',
      'client.raisonSociale',
    ]);
  });

  test('les balises minimales du brief sont au catalogue', () => {
    for (const t of [
      'client.raisonSociale', 'client.siren', 'contact.civilite', 'contact.nom', 'commercial.nom',
      'proposition.numero', 'proposition.dateExpiration', 'parc.nbPostes', 'parc.nbServeurs',
      'parc.nbEquipementsReseau', 'parc.nbUtilisateursM365', 'tarif.totalPonctuelHT', 'tarif.totalMensuelHT',
      'tarif.totalEngagementHT', 'engagement.dureeMois',
    ]) {
      expect(MERGE_TAG_CATALOG[t], t).toBeDefined();
    }
  });

  test('une balise inconnue est signalée', () => {
    expect(unknownMergeTags('{{client.motDePasse}} {{client.siren}}')).toEqual(['client.motDePasse']);
  });

  test('rendu typé : texte échappé, montant en euros, date française ; balise sans valeur conservée et listée', () => {
    const r = renderMergeTags(
      'Pour {{client.raisonSociale}} : {{tarif.totalMensuelHT}} HT jusqu’au {{proposition.dateExpiration}}, {{parc.nbPostes}} postes, {{contact.nom}}',
      {
        'client.raisonSociale': 'Dupont & Fils <SARL>',
        'tarif.totalMensuelHT': 151500,
        'proposition.dateExpiration': '2026-10-31',
        'parc.nbPostes': 50,
      },
      { html: true },
    );
    expect(r.text).toContain('Dupont &amp; Fils &lt;SARL&gt;');
    expect(r.text).toMatch(/1\s515,00\s€/);
    expect(r.text).toContain('31/10/2026');
    expect(r.text).toContain('50 postes');
    expect(r.text).toContain('{{contact.nom}}');
    expect(r.unresolved).toEqual(['contact.nom']);
  });

  test('formatMergeValue refuse une valeur mal typée plutôt que de l’afficher', () => {
    expect(formatMergeValue('parc.nbPostes', 'beaucoup')).toBeNull();
    expect(formatMergeValue('tarif.totalMensuelHT', 12.5)).toBeNull(); // centimes entiers attendus
  });
});

describe('numérotation', () => {
  test('PROP-AAAA-NNNN', () => {
    expect(formatProposalNumber(2026, 7)).toBe('PROP-2026-0007');
    expect(formatProposalNumber(2026, 12345)).toBe('PROP-2026-12345');
    expect(parseProposalNumber('PROP-2026-0042')).toEqual({ year: 2026, sequence: 42 });
    expect(parseProposalNumber('CT-2026-0042')).toBeNull();
  });
});

describe('relances', () => {
  const sentAt = new Date('2026-10-01T09:00:00Z');
  const expiresAt = new Date('2026-10-31T00:00:00Z');
  const cfg = { noOpenAfterDays: 3, noDecisionAfterDays: 7, beforeExpiryDays: 2 };

  test('planification par défaut : J+3, J+7, J-2', () => {
    const plan = planFollowUps(sentAt, expiresAt, cfg);
    expect(plan.map((p) => [p.kind, p.dueAt.toISOString()])).toEqual([
      ['NO_OPEN', '2026-10-04T09:00:00.000Z'],
      ['NO_DECISION', '2026-10-08T09:00:00.000Z'],
      ['BEFORE_EXPIRY', '2026-10-29T00:00:00.000Z'],
    ]);
  });

  const base = {
    status: 'SENT' as const,
    enabled: true,
    firstViewedAt: null,
    clientRespondedAt: null,
    lastFollowUpSentAt: null,
    expiresAt,
  };
  const now = new Date('2026-10-05T10:00:00Z');

  test('J+3 sans ouverture : envoyée', () => {
    expect(decideFollowUp('NO_OPEN', { ...base }, now)).toEqual({ action: 'SEND' });
  });

  test('ouverte entre-temps : la relance « sans ouverture » est sans objet', () => {
    expect(decideFollowUp('NO_OPEN', { ...base, status: 'VIEWED', firstViewedAt: now }, now)).toMatchObject({ action: 'SKIP' });
  });

  test('suspendue dès qu’une réponse arrive', () => {
    expect(decideFollowUp('NO_DECISION', { ...base, status: 'VIEWED', clientRespondedAt: now }, now)).toMatchObject({
      action: 'SKIP',
    });
    expect(decideFollowUp('NO_DECISION', { ...base, status: 'IN_DISCUSSION' }, now)).toMatchObject({ action: 'SKIP' });
  });

  test('désactivables', () => {
    expect(decideFollowUp('NO_OPEN', { ...base, enabled: false }, now)).toMatchObject({ action: 'SKIP' });
  });

  test('jamais plus d’une relance par 48 h : reportée', () => {
    const last = new Date(now.getTime() - 24 * 3600_000);
    expect(decideFollowUp('NO_DECISION', { ...base, lastFollowUpSentAt: last }, now)).toEqual({
      action: 'POSTPONE',
      until: new Date(last.getTime() + FOLLOW_UP_MIN_SPACING_MS),
    });
  });

  test('après l’échéance ou hors des statuts ouverts : sans objet', () => {
    expect(decideFollowUp('BEFORE_EXPIRY', { ...base }, new Date('2026-11-01T00:00:00Z'))).toMatchObject({ action: 'SKIP' });
    expect(decideFollowUp('NO_OPEN', { ...base, status: 'ACCEPTED' }, now)).toMatchObject({ action: 'SKIP' });
  });
});

describe('suivi de lecture : IP tronquée', () => {
  test('IPv4 → /24, IPv6 → /48, entrée invalide → null', () => {
    expect(truncateIp('203.0.113.42')).toBe('203.0.113.0');
    expect(truncateIp('::ffff:203.0.113.42')).toBe('203.0.113.0');
    expect(truncateIp('2001:db8:abcd:12:1:2:3:4')).toBe('2001:db8:abcd::');
    expect(truncateIp('pas une ip')).toBeNull();
    expect(truncateIp(null)).toBeNull();
  });
});
