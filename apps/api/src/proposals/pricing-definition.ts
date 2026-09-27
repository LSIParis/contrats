import { z } from 'zod';
import type {
  ProposalChoice,
  ProposalPricingDefinition,
  ProposalPricingLine,
  ProposalRule,
} from '@lsi/pricing';

/**
 * Tableau de prix d'une proposition : validation Zod (forme de l'annexe C,
 * `prisma/seed/proposal-templates/schema.ts`) et passerelles base ↔ moteur.
 *
 * Le schéma est la même grammaire que les fichiers du seed : un tableau
 * modifié dans l'interface reste un tableau que le moteur sait calculer.
 */

const Key = z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i, 'clé kebab-case attendue').max(64);
const Cents = z.number().int().nonnegative().max(1_000_000_000);
const PriceStatus = z.enum(['VALIDATED', 'TO_VALIDATE']);
const MergeTag = z.string().regex(/^\{\{[a-zA-Z0-9_.]+\}\}$/);

const Quantity = z
  .object({
    default: z.union([z.number().int().nonnegative(), MergeTag]),
    min: z.number().int().nonnegative(),
    max: z.number().int().positive().optional(),
    maxFrom: Key.optional(),
    linkedTo: Key.optional(),
    editableByClient: z.boolean(),
  })
  .strict();

const Line = z
  .object({
    key: Key,
    label: z.string().min(1).max(300),
    description: z.string().max(1000).optional(),
    kind: z.enum(['REQUIRED', 'OPTIONAL', 'SETUP', 'INFO']),
    unit: z.string().min(1).max(60),
    recurrence: z.enum(['ONE_TIME', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'INFO']),
    quantity: Quantity.optional(),
    pricing: z.union([
      z.object({ unitPriceCents: Cents }).strict(),
      z.object({ dependsOn: Key, byChoice: z.record(z.string(), Cents) }).strict(),
    ]),
    priceFrom: z.boolean().optional(),
    priceStatus: PriceStatus,
    priceStatusByChoice: z.record(z.string(), PriceStatus).optional(),
    priceSource: z.string().max(300).optional(),
    setupLineKey: Key.optional(),
    indexation: z.object({ index: z.literal('SYNTEC'), a: z.number().min(0).max(1), b: z.number().min(0).max(1) }).strict().optional(),
    group: z.enum(['RECURRING', 'SETUP', 'OPTIONS', 'YEARLY', 'OUT_OF_SCOPE']),
  })
  .strict();

const Choice = z
  .object({
    key: Key,
    label: z.string().min(1).max(200),
    options: z
      .array(
        z
          .object({
            value: z.string().min(1).max(40),
            label: z.string().min(1).max(200),
            description: z.string().max(500).optional(),
            default: z.boolean().optional(),
            commitmentMonths: z.number().int().positive().max(120).optional(),
          })
          .strict(),
      )
      .min(2)
      .max(10),
    editableByClient: z.boolean(),
    priceStatus: PriceStatus.optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

const Rule = z.discriminatedUnion('type', [
  z.object({ type: z.literal('MINIMUM_MONTHLY'), key: Key, amountCents: Cents, label: z.string(), priceStatus: PriceStatus, priceSource: z.string().optional() }).strict(),
  z.object({ type: z.literal('REQUIRES'), key: Key, line: Key, requires: z.array(Key).min(1), message: z.string() }).strict(),
  z.object({ type: z.literal('REQUIRED_IF_ANY'), key: Key, line: Key, ifAny: z.array(Key).min(1), message: z.string() }).strict(),
  z.object({ type: z.literal('AUTO_INCLUDE'), key: Key, line: Key, when: Key }).strict(),
  z.object({ type: z.literal('AT_LEAST_ONE'), key: Key, lines: z.array(Key).min(2), message: z.string() }).strict(),
  z
    .object({
      type: z.literal('DISCOUNT_PERCENT'),
      key: Key,
      percent: z.number().positive().max(100),
      appliesTo: z.array(Key).min(1),
      when: Key,
      label: z.string(),
      priceStatus: PriceStatus,
      priceSource: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('PRESELECT_CHOICE'),
      key: Key,
      choice: Key,
      field: z.string(),
      ranges: z.array(z.object({ min: z.number().int().optional(), max: z.number().int().optional(), value: z.string() }).strict()).min(2),
    })
    .strict(),
]);

export const PricingDefinitionSchema = z
  .object({
    choices: z.array(Choice).max(10),
    lines: z.array(Line).min(1).max(100),
    rules: z.array(Rule).max(50),
    vatRatePercent: z.number().min(0).max(100),
  })
  .strict()
  .superRefine((d, ctx) => {
    const keys = new Set<string>();
    for (const l of d.lines) {
      if (keys.has(l.key)) ctx.addIssue({ code: 'custom', message: `ligne en double : ${l.key}` });
      keys.add(l.key);
    }
    for (const l of d.lines) {
      if (l.kind !== 'INFO' && !l.quantity) ctx.addIssue({ code: 'custom', message: `ligne ${l.key} : quantité requise` });
      if ('dependsOn' in l.pricing) {
        const c = d.choices.find((x) => x.key === (l.pricing as { dependsOn: string }).dependsOn);
        const expected = c?.options.map((o) => o.value).sort().join(',');
        const got = Object.keys(l.pricing.byChoice).sort().join(',');
        if (!c || expected !== got) ctx.addIssue({ code: 'custom', message: `ligne ${l.key} : byChoice doit couvrir exactement les valeurs du choix` });
      }
    }
    for (const c of d.choices) {
      if (c.options.filter((o) => o.default).length !== 1) ctx.addIssue({ code: 'custom', message: `choix ${c.key} : exactement une option par défaut` });
    }
    if (d.choices.filter((c) => c.options.some((o) => o.commitmentMonths)).length !== 1) {
      ctx.addIssue({ code: 'custom', message: 'un et un seul choix doit porter la durée d’engagement' });
    }
  });

/** Lignes et sections de modèle (Prisma) → définition du moteur. */
export function templateDefinition(t: {
  pricingChoices: unknown;
  pricingRules: unknown;
  vatRatePercent: { toString(): string };
  lines: readonly {
    key: string; label: string; description: string | null; kind: string; unit: string; recurrence: string; group: string;
    quantity: unknown; pricing: unknown; priceFrom: boolean; priceStatus: string; priceStatusByChoice: unknown;
    priceSource: string; setupLineKey: string | null; indexation: unknown; position: number;
  }[];
}): ProposalPricingDefinition {
  const lines = [...t.lines]
    .sort((a, b) => a.position - b.position)
    .map((l) => {
      const line: Record<string, unknown> = {
        key: l.key,
        label: l.label,
        kind: l.kind,
        unit: l.unit,
        recurrence: l.recurrence,
        group: l.group,
        pricing: l.pricing,
        priceFrom: l.priceFrom,
        priceStatus: l.priceStatus,
        priceSource: l.priceSource,
      };
      if (l.description) line.description = l.description;
      if (l.quantity) line.quantity = l.quantity;
      if (l.priceStatusByChoice) line.priceStatusByChoice = l.priceStatusByChoice;
      if (l.setupLineKey) line.setupLineKey = l.setupLineKey;
      if (l.indexation) line.indexation = l.indexation;
      return line as unknown as ProposalPricingLine;
    });
  return {
    choices: (t.pricingChoices ?? []) as ProposalChoice[],
    lines,
    rules: (t.pricingRules ?? []) as ProposalRule[],
    vatRatePercent: Number(t.vatRatePercent.toString()),
  };
}

/**
 * Statuts « à valider » levés depuis la création de la proposition : un
 * élément encore TO_VALIDATE dans la version est considéré VALIDÉ si le
 * modèle l'a validé depuis ET que son prix n'a pas changé (même `pricing`,
 * même montant de règle). Aucune validation ne « contamine » un prix modifié.
 */
export function withTemplateValidations(
  def: ProposalPricingDefinition,
  template: ProposalPricingDefinition | null,
): ProposalPricingDefinition {
  if (!template) return def;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const tLines = new Map(template.lines.map((l) => [l.key, l]));
  const tRules = new Map(template.rules.map((r) => [r.key, r]));
  const tChoices = new Map(template.choices.map((c) => [c.key, c]));
  return {
    ...def,
    lines: def.lines.map((l) => {
      const t = tLines.get(l.key);
      if (!t || !same(t.pricing, l.pricing)) return l;
      const next: ProposalPricingLine = {
        ...l,
        priceStatus: l.priceStatus === 'TO_VALIDATE' && t.priceStatus === 'VALIDATED' ? 'VALIDATED' : l.priceStatus,
      };
      if (l.priceStatusByChoice && t.priceStatusByChoice) {
        const merged: Record<string, 'VALIDATED' | 'TO_VALIDATE'> = {};
        for (const [k, s] of Object.entries(l.priceStatusByChoice)) {
          merged[k] = s === 'TO_VALIDATE' && t.priceStatusByChoice[k] === 'VALIDATED' ? 'VALIDATED' : s;
        }
        return { ...next, priceStatusByChoice: merged };
      }
      return next;
    }),
    rules: def.rules.map((r) => {
      const t = tRules.get(r.key);
      if (!t || !('priceStatus' in r) || !('priceStatus' in t)) return r;
      const comparable = (x: ProposalRule) => ({ ...x, priceStatus: undefined, priceSource: undefined });
      if (!same(comparable(t), comparable(r))) return r;
      return r.priceStatus === 'TO_VALIDATE' && t.priceStatus === 'VALIDATED' ? ({ ...r, priceStatus: 'VALIDATED' } as ProposalRule) : r;
    }),
    choices: def.choices.map((c) => {
      const t = tChoices.get(c.key);
      return t && c.priceStatus === 'TO_VALIDATE' && t.priceStatus !== 'TO_VALIDATE' ? { ...c, priceStatus: 'VALIDATED' } : c;
    }),
  };
}

/**
 * Statuts « à valider » d'une définition modifiée par le commercial : il ne
 * peut PAS s'auto-valider un prix. Un élément dont le prix est inchangé garde
 * son statut ; un prix modifié ou une ligne / règle nouvelle est TO_VALIDATE
 * (validation par un administrateur, tracée).
 */
export function enforcePriceStatuses(next: ProposalPricingDefinition, prev: ProposalPricingDefinition): ProposalPricingDefinition {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const prevLines = new Map(prev.lines.map((l) => [l.key, l]));
  const prevRules = new Map(prev.rules.map((r) => [r.key, r]));
  const prevChoices = new Map(prev.choices.map((c) => [c.key, c]));
  return {
    ...next,
    lines: next.lines.map((l) => {
      const p = prevLines.get(l.key);
      if (p && same(p.pricing, l.pricing)) {
        const { priceStatusByChoice: _drop, ...rest } = l;
        return { ...rest, priceStatus: p.priceStatus, ...(p.priceStatusByChoice ? { priceStatusByChoice: p.priceStatusByChoice } : {}) };
      }
      const { priceStatusByChoice: _drop, ...rest } = l;
      return { ...rest, priceStatus: 'TO_VALIDATE' as const };
    }),
    rules: next.rules.map((r) => {
      if (!('priceStatus' in r)) return r;
      const p = prevRules.get(r.key);
      const comparable = (x: ProposalRule) => ({ ...x, priceStatus: undefined, priceSource: undefined });
      if (p && 'priceStatus' in p && same(comparable(p), comparable(r))) return { ...r, priceStatus: p.priceStatus } as ProposalRule;
      return { ...r, priceStatus: 'TO_VALIDATE' } as ProposalRule;
    }),
    choices: next.choices.map((c) => {
      const p = prevChoices.get(c.key);
      return { ...c, priceStatus: p?.priceStatus ?? 'VALIDATED' };
    }),
  };
}

/** Validation d'un élément « à valider » d'une proposition (administrateur). */
export function validateInDefinition(
  def: ProposalPricingDefinition,
  target: { scope: 'LINE' | 'RULE' | 'CHOICE'; key: string; choiceValue?: string | undefined },
): ProposalPricingDefinition | null {
  if (target.scope === 'LINE') {
    const l = def.lines.find((x) => x.key === target.key);
    if (!l) return null;
    if (l.priceStatusByChoice) {
      if (!target.choiceValue || l.priceStatusByChoice[target.choiceValue] !== 'TO_VALIDATE') return null;
      const byChoice = { ...l.priceStatusByChoice, [target.choiceValue]: 'VALIDATED' as const };
      const all = Object.values(byChoice).every((v) => v === 'VALIDATED');
      return { ...def, lines: def.lines.map((x) => (x.key === l.key ? { ...x, priceStatusByChoice: byChoice, ...(all ? { priceStatus: 'VALIDATED' as const } : {}) } : x)) };
    }
    if (l.priceStatus !== 'TO_VALIDATE') return null;
    return { ...def, lines: def.lines.map((x) => (x.key === l.key ? { ...x, priceStatus: 'VALIDATED' as const } : x)) };
  }
  if (target.scope === 'RULE') {
    const r = def.rules.find((x) => x.key === target.key);
    if (!r || !('priceStatus' in r) || r.priceStatus !== 'TO_VALIDATE') return null;
    return { ...def, rules: def.rules.map((x) => (x.key === r.key ? ({ ...x, priceStatus: 'VALIDATED' } as ProposalRule) : x)) };
  }
  const c = def.choices.find((x) => x.key === target.key);
  if (!c || c.priceStatus !== 'TO_VALIDATE') return null;
  return { ...def, choices: def.choices.map((x) => (x.key === c.key ? { ...x, priceStatus: 'VALIDATED' as const } : x)) };
}
