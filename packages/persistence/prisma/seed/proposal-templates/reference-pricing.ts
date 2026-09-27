/**
 * Évaluateur de référence des tableaux de prix des modèles livrés.
 *
 * Rôle : spécification exécutable. Il sert à vérifier la cohérence des fichiers de seed
 * (cas de contrôle chiffrés) et de référence pour le moteur de tarification de l'application :
 * le moteur réel doit produire exactement les mêmes totaux sur les `controlCases`
 * (voir `runControlCases`). Il n'est pas utilisé en production.
 *
 * Règles de calcul :
 * - montants en centimes HT entiers ; total de ligne = prix unitaire × quantité ;
 * - remise en pourcentage arrondie au centime (demi supérieur), portée par une ligne négative ;
 * - complément de minimum mensuel ajouté si le mensuel après remise est inférieur au minimum ;
 * - total sur la durée = mensuel × mois + trimestriel × (mois / 3) + annuel × (mois / 12),
 *   hors frais ponctuels.
 */
import type { PriceStatus, PricingLine, ProposalTemplateSeed, Rule } from "./schema";

export interface Selection {
  choices?: Record<string, string>;
  quantities?: Record<string, number>;
  selectedOptions?: string[];
  /** Valeurs des balises de fusion (quantités par défaut, présélection). */
  context?: Record<string, number | string>;
}

export interface EvaluatedLine {
  key: string;
  label: string;
  recurrence: PricingLine["recurrence"] | "DISCOUNT" | "MINIMUM";
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  priceStatus: PriceStatus;
}

export interface Evaluation {
  choices: Record<string, string>;
  commitmentMonths: number;
  lines: EvaluatedLine[];
  monthlyCents: number;
  quarterlyCents: number;
  yearlyCents: number;
  oneTimeCents: number;
  commitmentTotalCents: number;
  errors: string[];
}

export function resolveChoices(t: ProposalTemplateSeed, sel: Selection): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of t.pricing.choices) out[c.key] = c.options.find((o) => o.default)!.value;
  for (const r of t.pricing.rules) {
    if (r.type !== "PRESELECT_CHOICE") continue;
    const v = Number(sel.context?.[r.field]);
    if (!Number.isFinite(v)) continue;
    const hit = r.ranges.find((x) => (x.min ?? -Infinity) <= v && v <= (x.max ?? Infinity));
    if (hit) out[r.choice] = hit.value;
  }
  return { ...out, ...(sel.choices ?? {}) };
}

export function unitPrice(l: PricingLine, choices: Record<string, string>): number {
  if ("unitPriceCents" in l.pricing) return l.pricing.unitPriceCents;
  const v = choices[l.pricing.dependsOn];
  const p = v === undefined ? undefined : l.pricing.byChoice[v];
  if (p === undefined) throw new Error(`ligne ${l.key} : pas de prix pour ${l.pricing.dependsOn}=${v}`);
  return p;
}

export function effectivePriceStatus(l: PricingLine, choices: Record<string, string>): PriceStatus {
  if (l.priceStatusByChoice && "dependsOn" in l.pricing) {
    const v = choices[l.pricing.dependsOn];
    if (v && l.priceStatusByChoice[v]) return l.priceStatusByChoice[v]!;
  }
  return l.priceStatus;
}

function rulesOf<T extends Rule["type"]>(t: ProposalTemplateSeed, type: T): Extract<Rule, { type: T }>[] {
  return t.pricing.rules.filter((r): r is Extract<Rule, { type: T }> => r.type === type);
}

export function evaluate(t: ProposalTemplateSeed, sel: Selection = {}): Evaluation {
  const errors: string[] = [];
  const choices = resolveChoices(t, sel);
  for (const c of t.pricing.choices)
    if (!c.options.some((o) => o.value === choices[c.key])) errors.push(`valeur invalide pour ${c.key} : ${choices[c.key]}`);

  const commitmentChoice = t.pricing.choices.find((c) => c.options.some((o) => o.commitmentMonths))!;
  const commitmentMonths =
    commitmentChoice.options.find((o) => o.value === choices[commitmentChoice.key])?.commitmentMonths ?? 0;

  const byKey = new Map(t.pricing.lines.map((l) => [l.key, l]));
  const selected = new Set(sel.selectedOptions ?? []);
  for (const k of selected)
    if (byKey.get(k)?.kind !== "OPTIONAL") errors.push(`${k} n'est pas une option sélectionnable`);

  const rawQty = (l: PricingLine): number => {
    if (sel.quantities && l.key in sel.quantities) return sel.quantities[l.key]!;
    const d = l.quantity!.default;
    if (typeof d === "number") return d;
    const tag = d.slice(2, -2);
    const v = Number(sel.context?.[tag]);
    if (!Number.isFinite(v)) {
      errors.push(`ligne ${l.key} : balise ${d} non résolue`);
      return 0;
    }
    return v;
  };

  // 1. Lignes incluses et quantités (hors SETUP)
  const included = new Map<string, number>();
  for (const l of t.pricing.lines) {
    if (l.kind === "REQUIRED" || (l.kind === "OPTIONAL" && selected.has(l.key))) included.set(l.key, rawQty(l));
  }
  for (const r of rulesOf(t, "REQUIRED_IF_ANY")) {
    if (r.ifAny.some((k) => (included.get(k) ?? 0) > 0) && !included.has(r.line))
      included.set(r.line, rawQty(byKey.get(r.line)!));
  }
  for (const r of rulesOf(t, "AUTO_INCLUDE")) {
    const target = byKey.get(r.line)!;
    if (included.has(r.when) && target.kind !== "SETUP" && !included.has(r.line)) included.set(r.line, rawQty(target));
  }
  // 2. Lignes SETUP : quantité = quantité de la ligne liée
  for (const l of t.pricing.lines) {
    if (l.kind !== "SETUP") continue;
    const linked = l.quantity!.linkedTo!;
    if (included.has(linked)) included.set(l.key, included.get(linked)!);
  }

  // 3. Bornes
  for (const [k, q] of included) {
    const l = byKey.get(k)!;
    const qd = l.quantity!;
    if (!Number.isInteger(q) || q < 0) errors.push(`ligne ${k} : quantité invalide ${q}`);
    const min = l.kind === "REQUIRED" ? qd.min : Math.max(qd.min, 0);
    if (l.kind !== "SETUP" && q < min) errors.push(`ligne ${k} : quantité ${q} < minimum ${min}`);
    if (qd.max !== undefined && q > qd.max) errors.push(`ligne ${k} : quantité ${q} > maximum ${qd.max}`);
    if (qd.maxFrom && q > (included.get(qd.maxFrom) ?? 0))
      errors.push(`ligne ${k} : quantité ${q} supérieure à celle de ${qd.maxFrom}`);
  }

  // 4. Règles de dépendance
  for (const r of rulesOf(t, "REQUIRES"))
    if (included.has(r.line) && r.requires.some((k) => !included.has(k))) errors.push(r.message);
  for (const r of rulesOf(t, "AT_LEAST_ONE"))
    if (!r.lines.some((k) => (included.get(k) ?? 0) > 0)) errors.push(r.message);

  // 5. Montants
  const lines: EvaluatedLine[] = [];
  for (const l of t.pricing.lines) {
    if (!included.has(l.key)) continue;
    const q = included.get(l.key)!;
    if (q === 0) continue;
    const u = unitPrice(l, choices);
    lines.push({
      key: l.key,
      label: l.label,
      recurrence: l.recurrence,
      quantity: q,
      unitPriceCents: u,
      totalCents: u * q,
      priceStatus: effectivePriceStatus(l, choices),
    });
  }
  const sum = (rec: EvaluatedLine["recurrence"]) =>
    lines.filter((x) => x.recurrence === rec).reduce((a, x) => a + x.totalCents, 0);

  for (const r of rulesOf(t, "DISCOUNT_PERCENT")) {
    if (!included.has(r.when)) continue;
    const base = lines.filter((x) => r.appliesTo.includes(x.key)).reduce((a, x) => a + x.totalCents, 0);
    const amount = Math.round((base * r.percent) / 100);
    if (amount > 0)
      lines.push({
        key: r.key,
        label: r.label,
        recurrence: "DISCOUNT",
        quantity: 1,
        unitPriceCents: -amount,
        totalCents: -amount,
        priceStatus: r.priceStatus,
      });
  }

  let monthlyCents = sum("MONTHLY") + sum("DISCOUNT");
  for (const r of rulesOf(t, "MINIMUM_MONTHLY")) {
    if (monthlyCents < r.amountCents) {
      const complement = r.amountCents - monthlyCents;
      lines.push({
        key: r.key,
        label: r.label,
        recurrence: "MINIMUM",
        quantity: 1,
        unitPriceCents: complement,
        totalCents: complement,
        priceStatus: r.priceStatus,
      });
      monthlyCents = r.amountCents;
    }
  }
  const quarterlyCents = sum("QUARTERLY");
  const yearlyCents = sum("YEARLY");
  const oneTimeCents = sum("ONE_TIME");
  if (quarterlyCents && commitmentMonths % 3) errors.push("durée non multiple de 3 mois avec une ligne trimestrielle");
  if (yearlyCents && commitmentMonths % 12) errors.push("durée non multiple de 12 mois avec une ligne annuelle");
  const commitmentTotalCents =
    monthlyCents * commitmentMonths +
    quarterlyCents * Math.floor(commitmentMonths / 3) +
    yearlyCents * Math.floor(commitmentMonths / 12);

  return {
    choices,
    commitmentMonths,
    lines,
    monthlyCents,
    quarterlyCents,
    yearlyCents,
    oneTimeCents,
    commitmentTotalCents,
    errors,
  };
}

export interface PendingValidation {
  scope: "LINE" | "RULE" | "SECTION" | "CHOICE";
  key: string;
  label: string;
  /** Valeur de choix concernée quand le statut dépend du choix. */
  choiceValue?: string;
}

/**
 * Éléments « à valider » d'un modèle, tous choix confondus : alimente l'écran d'administration.
 */
export function listPendingValidations(t: ProposalTemplateSeed): PendingValidation[] {
  const out: PendingValidation[] = [];
  for (const l of t.pricing.lines) {
    if (l.priceStatusByChoice) {
      for (const [v, s] of Object.entries(l.priceStatusByChoice))
        if (s === "TO_VALIDATE") out.push({ scope: "LINE", key: l.key, label: l.label, choiceValue: v });
    } else if (l.priceStatus === "TO_VALIDATE") out.push({ scope: "LINE", key: l.key, label: l.label });
  }
  for (const r of t.pricing.rules)
    if ("priceStatus" in r && r.priceStatus === "TO_VALIDATE") out.push({ scope: "RULE", key: r.key, label: r.label });
  for (const s of t.sections)
    if (s.validationStatus === "TO_VALIDATE") out.push({ scope: "SECTION", key: s.key, label: s.title });
  for (const c of t.pricing.choices)
    if (c.priceStatus === "TO_VALIDATE") out.push({ scope: "CHOICE", key: c.key, label: c.label });
  return out;
}

/**
 * Éléments « à valider » qui bloquent une proposition concrète (passage à PRÊTE interdit
 * tant que la liste n'est pas vide). Sections facultatives retirées : passer `excludedSections`.
 */
export function blockingValidations(
  t: ProposalTemplateSeed,
  sel: Selection,
  excludedSections: string[] = [],
): PendingValidation[] {
  const ev = evaluate(t, sel);
  const out: PendingValidation[] = [];
  const byKey = new Map(t.pricing.lines.map((l) => [l.key, l]));
  for (const x of ev.lines) {
    if (x.priceStatus !== "TO_VALIDATE") continue;
    const l = byKey.get(x.key);
    out.push({ scope: l ? "LINE" : "RULE", key: x.key, label: x.label });
  }
  for (const s of t.sections)
    if (s.validationStatus === "TO_VALIDATE" && !excludedSections.includes(s.key))
      out.push({ scope: "SECTION", key: s.key, label: s.title });
  for (const c of t.pricing.choices)
    if (c.priceStatus === "TO_VALIDATE") out.push({ scope: "CHOICE", key: c.key, label: c.label });
  return out;
}

export type PricingEvaluator = (
  t: ProposalTemplateSeed,
  sel: Selection,
) => Pick<Evaluation, "monthlyCents" | "oneTimeCents" | "yearlyCents" | "commitmentTotalCents" | "errors">;

/** Compare un évaluateur (référence ou moteur réel adapté) aux cas de contrôle du modèle. */
export function runControlCases(t: ProposalTemplateSeed, evaluator: PricingEvaluator = evaluate): string[] {
  const failures: string[] = [];
  for (const cc of t.controlCases) {
    const ev = evaluator(t, { choices: cc.choices, quantities: cc.quantities, selectedOptions: cc.selectedOptions });
    if (ev.errors.length) failures.push(`${t.slug} / ${cc.name} : ${ev.errors.join(" ; ")}`);
    for (const [k, expected] of Object.entries(cc.expected)) {
      const got = ev[k as keyof typeof cc.expected];
      if (expected !== undefined && got !== expected)
        failures.push(`${t.slug} / ${cc.name} : ${k} attendu ${expected}, obtenu ${got}`);
    }
  }
  return failures;
}
