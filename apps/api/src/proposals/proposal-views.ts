import type { ProposalPricingDefinition, ProposalQuote } from '@lsi/pricing';

/**
 * Vues JSON du tableau de prix : ce que l'interface affiche, SANS aucun
 * calcul côté navigateur (brief §12.4 : le front affiche, le serveur calcule).
 * Les montants restent des bigint (centimes) : le BigIntInterceptor les
 * sérialise en chaînes.
 */
export function quoteView(q: ProposalQuote) {
  return {
    choices: q.choices,
    quantities: q.quantities,
    selectedOptions: q.selectedOptions,
    commitmentMonths: q.commitmentMonths,
    lines: q.lines,
    infoLines: q.infoLines,
    totals: { oneTime: q.oneTime, monthly: q.monthly, quarterly: q.quarterly, yearly: q.yearly, commitment: q.commitment },
    errors: q.errors,
    blockingValidations: q.blockingValidations,
  };
}

/**
 * Définition affichable côté CLIENT : libellés, unités, bornes, prix unitaires
 * et ce qui est modifiable. Ni source des prix, ni statut de validation
 * (informations internes).
 */
export function publicDefinitionView(def: ProposalPricingDefinition) {
  return {
    vatRatePercent: def.vatRatePercent,
    choices: def.choices.map((c) => ({
      key: c.key,
      label: c.label,
      editableByClient: c.editableByClient,
      options: c.options.map((o) => ({ value: o.value, label: o.label, description: o.description ?? null, default: !!o.default })),
    })),
    lines: def.lines.map((l) => ({
      key: l.key,
      label: l.label,
      description: l.description ?? null,
      kind: l.kind,
      unit: l.unit,
      recurrence: l.recurrence,
      group: l.group,
      priceFrom: !!l.priceFrom,
      pricing: l.pricing,
      quantity: l.quantity
        ? {
            min: l.quantity.min,
            max: l.quantity.max ?? null,
            maxFrom: l.quantity.maxFrom ?? null,
            linkedTo: l.quantity.linkedTo ?? null,
            editableByClient: l.quantity.editableByClient,
          }
        : null,
    })),
  };
}
