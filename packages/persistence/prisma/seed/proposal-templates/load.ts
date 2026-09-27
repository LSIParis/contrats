/**
 * Chargement et validation des fichiers de seed des modèles de proposition.
 * Aucune écriture en base ici : tout est validé avant la première requête.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContentLibrarySeed,
  ProposalTemplateSeed,
  type LibraryItemSeed,
  type PricingLine,
} from "./schema";

export const SEED_DIR = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_FILES = ["infogerance.json", "supervision.json", "rssi.json", "sauvegarde.json"] as const;
export const LIBRARY_FILE = "content-library.json";

/** Balises de fusion autorisées dans les modèles livrés. */
export const ALLOWED_MERGE_TAGS = new Set([
  "client.raisonSociale",
  "client.siren",
  "client.effectif",
  "contact.civilite",
  "contact.nom",
  "commercial.nom",
  "proposition.numero",
  "proposition.dateExpiration",
  "parc.nbPostes",
  "parc.nbServeurs",
  "parc.nbEquipementsReseau",
  "parc.nbUtilisateursM365",
  "tarif.totalPonctuelHT",
  "tarif.totalMensuelHT",
  "tarif.totalEngagementHT",
  "engagement.dureeMois",
]);

export class SeedValidationError extends Error {
  constructor(public readonly file: string, public readonly issues: string[]) {
    super(`${file} : ${issues.length} erreur(s)\n - ${issues.join("\n - ")}`);
    this.name = "SeedValidationError";
  }
}

/** Sérialisation JSON à clés triées : base du checksum, indépendante de l'ordre des clés. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k, v]) => v !== undefined && k !== "$schema")
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function checksum(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function readJson(dir: string, file: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dir, file), "utf8"));
  } catch (e) {
    throw new SeedValidationError(file, [`lecture ou JSON invalide : ${(e as Error).message}`]);
  }
}

function duplicates(keys: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const k of keys) (seen.has(k) ? dup : seen).add(k);
  return [...dup];
}

function mergeTagsIn(text: string | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map((m) => m[1]!);
}

/** Contrôles de cohérence que Zod ne peut pas exprimer (références croisées). */
export function crossCheck(t: ProposalTemplateSeed, library: Map<string, LibraryItemSeed>): string[] {
  const issues: string[] = [];
  const lines = new Map(t.pricing.lines.map((l) => [l.key, l]));
  const choices = new Map(t.pricing.choices.map((c) => [c.key, c]));

  for (const [what, keys] of [
    ["section", t.sections.map((s) => s.key)],
    ["ligne", t.pricing.lines.map((l) => l.key)],
    ["choix", t.pricing.choices.map((c) => c.key)],
    ["règle", t.pricing.rules.map((r) => r.key)],
  ] as const) {
    for (const d of duplicates([...keys])) issues.push(`${what} en double : ${d}`);
  }

  for (const kind of ["PRICING", "TERMS", "SIGNATURE", "COVER"] as const) {
    const n = t.sections.filter((s) => s.kind === kind).length;
    if (n !== 1) issues.push(`il faut exactement une section ${kind} (trouvé ${n})`);
  }

  for (const s of t.sections) {
    if (s.libraryKey && !library.has(s.libraryKey))
      issues.push(`section ${s.key} : contenu de bibliothèque inconnu ${s.libraryKey}`);
    for (const tag of [...mergeTagsIn(s.body), ...mergeTagsIn(s.guidance)])
      if (!ALLOWED_MERGE_TAGS.has(tag)) issues.push(`section ${s.key} : balise non autorisée {{${tag}}}`);
  }

  for (const c of t.pricing.choices) {
    const defaults = c.options.filter((o) => o.default).length;
    if (defaults !== 1) issues.push(`choix ${c.key} : exactement une option par défaut attendue (${defaults})`);
    for (const d of duplicates(c.options.map((o) => o.value))) issues.push(`choix ${c.key} : valeur en double ${d}`);
  }
  const commitmentChoices = t.pricing.choices.filter((c) => c.options.some((o) => o.commitmentMonths));
  if (commitmentChoices.length !== 1) issues.push(`un et un seul choix doit porter la durée d'engagement`);
  else if (commitmentChoices[0]!.options.some((o) => !o.commitmentMonths))
    issues.push(`choix ${commitmentChoices[0]!.key} : chaque option doit préciser commitmentMonths`);

  const checkLineRef = (ctx: string, key: string | undefined, kind?: PricingLine["kind"]) => {
    if (!key) return;
    const ref = lines.get(key);
    if (!ref) issues.push(`${ctx} : ligne inconnue ${key}`);
    else if (kind && ref.kind !== kind) issues.push(`${ctx} : ${key} doit être de type ${kind}`);
  };

  for (const l of t.pricing.lines) {
    const ctx = `ligne ${l.key}`;
    if (l.kind === "INFO" && l.quantity) issues.push(`${ctx} : une ligne INFO n'a pas de quantité`);
    if (l.kind !== "INFO" && !l.quantity) issues.push(`${ctx} : quantité requise`);
    if (l.kind === "INFO" && l.recurrence !== "INFO") issues.push(`${ctx} : récurrence INFO attendue`);
    if (l.kind === "SETUP" && (l.recurrence !== "ONE_TIME" || !l.quantity?.linkedTo))
      issues.push(`${ctx} : une ligne SETUP est ponctuelle et liée à une autre ligne`);
    if (l.kind !== "SETUP" && l.quantity?.linkedTo) issues.push(`${ctx} : linkedTo réservé aux lignes SETUP`);
    checkLineRef(ctx, l.setupLineKey, "SETUP");
    checkLineRef(ctx, l.quantity?.linkedTo);
    checkLineRef(ctx, l.quantity?.maxFrom);
    if (typeof l.quantity?.default === "string") {
      const tag = mergeTagsIn(l.quantity.default)[0];
      if (!tag || !ALLOWED_MERGE_TAGS.has(tag)) issues.push(`${ctx} : balise de quantité non autorisée`);
    }
    if ("dependsOn" in l.pricing) {
      const c = choices.get(l.pricing.dependsOn);
      if (!c) issues.push(`${ctx} : choix inconnu ${l.pricing.dependsOn}`);
      else {
        const expected = c.options.map((o) => o.value).sort().join(",");
        const got = Object.keys(l.pricing.byChoice).sort().join(",");
        if (expected !== got) issues.push(`${ctx} : byChoice doit couvrir exactement ${expected} (trouvé ${got})`);
        if (l.priceStatusByChoice) {
          const gotS = Object.keys(l.priceStatusByChoice).sort().join(",");
          if (gotS !== expected) issues.push(`${ctx} : priceStatusByChoice doit couvrir exactement ${expected}`);
        }
      }
    } else if (l.priceStatusByChoice) {
      issues.push(`${ctx} : priceStatusByChoice sans dependsOn`);
    }
  }

  for (const r of t.pricing.rules) {
    const ctx = `règle ${r.key}`;
    switch (r.type) {
      case "REQUIRES":
        checkLineRef(ctx, r.line);
        r.requires.forEach((k) => checkLineRef(ctx, k));
        break;
      case "REQUIRED_IF_ANY":
        checkLineRef(ctx, r.line, "OPTIONAL");
        r.ifAny.forEach((k) => checkLineRef(ctx, k));
        break;
      case "AUTO_INCLUDE":
        checkLineRef(ctx, r.line);
        checkLineRef(ctx, r.when);
        break;
      case "AT_LEAST_ONE":
        r.lines.forEach((k) => checkLineRef(ctx, k));
        break;
      case "DISCOUNT_PERCENT":
        checkLineRef(ctx, r.when);
        for (const k of r.appliesTo) {
          checkLineRef(ctx, k);
          if (lines.get(k) && lines.get(k)!.recurrence !== "MONTHLY")
            issues.push(`${ctx} : la remise ne s'applique qu'à des lignes mensuelles (${k})`);
        }
        break;
      case "PRESELECT_CHOICE": {
        const c = choices.get(r.choice);
        if (!c) issues.push(`${ctx} : choix inconnu ${r.choice}`);
        else
          for (const range of r.ranges)
            if (!c.options.some((o) => o.value === range.value))
              issues.push(`${ctx} : valeur ${range.value} absente du choix ${r.choice}`);
        break;
      }
      case "MINIMUM_MONTHLY":
        break;
    }
  }
  if (t.pricing.rules.filter((r) => r.type === "MINIMUM_MONTHLY").length > 1)
    issues.push("au plus une règle MINIMUM_MONTHLY");

  for (const cc of t.controlCases) {
    for (const k of Object.keys(cc.choices)) if (!choices.has(k)) issues.push(`cas « ${cc.name} » : choix inconnu ${k}`);
    for (const k of [...Object.keys(cc.quantities), ...cc.selectedOptions])
      if (!lines.has(k)) issues.push(`cas « ${cc.name} » : ligne inconnue ${k}`);
  }
  return issues;
}

export interface LoadedSeed {
  library: LibraryItemSeed[];
  templates: ProposalTemplateSeed[];
}

export function loadSeed(dir: string = SEED_DIR): LoadedSeed {
  const libParsed = ContentLibrarySeed.safeParse(readJson(dir, LIBRARY_FILE));
  if (!libParsed.success)
    throw new SeedValidationError(
      LIBRARY_FILE,
      libParsed.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`),
    );
  const libDup = duplicates(libParsed.data.items.map((i) => i.key));
  if (libDup.length) throw new SeedValidationError(LIBRARY_FILE, libDup.map((d) => `clé en double : ${d}`));
  const library = new Map(libParsed.data.items.map((i) => [i.key, i]));

  const templates: ProposalTemplateSeed[] = [];
  for (const file of TEMPLATE_FILES) {
    const parsed = ProposalTemplateSeed.safeParse(readJson(dir, file));
    if (!parsed.success)
      throw new SeedValidationError(
        file,
        parsed.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`),
      );
    const issues = crossCheck(parsed.data, library);
    if (issues.length) throw new SeedValidationError(file, issues);
    templates.push(parsed.data);
  }
  const slugDup = duplicates(templates.map((t) => t.slug));
  if (slugDup.length) throw new SeedValidationError("proposal-templates", slugDup.map((d) => `slug en double : ${d}`));
  return { library: libParsed.data.items, templates };
}
