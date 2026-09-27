/**
 * Numéro de proposition `PROP-AAAA-NNNN` (brief §12.1), séquence par tenant
 * et par année. La SÉQUENCE est attribuée en base (compteur atomique, voir
 * `proposal_sequences`) ; ce module ne fait que formater et relire.
 */
export function formatProposalNumber(year: number, sequence: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new Error(`Année invalide : ${year}`);
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error(`Séquence invalide : ${sequence}`);
  return `PROP-${year}-${String(sequence).padStart(4, '0')}`;
}

export function parseProposalNumber(n: string): { year: number; sequence: number } | null {
  const m = /^PROP-(\d{4})-(\d{4,})$/.exec(n);
  return m ? { year: Number(m[1]), sequence: Number(m[2]) } : null;
}
