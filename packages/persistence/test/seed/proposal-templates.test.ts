import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SEED_DIR, SeedValidationError, loadSeed } from "../../prisma/seed/proposal-templates/load";
import {
  blockingValidations,
  evaluate,
  listPendingValidations,
  runControlCases,
} from "../../prisma/seed/proposal-templates/reference-pricing";
import { createMemorySeedRepository, type MemoryStore } from "../../prisma/seed/proposal-templates/repository";
import { SeedConflictError, seedProposalTemplates } from "../../prisma/seed/proposal-templates/seed-proposal-templates";

const seed = loadSeed();
const tpl = (slug: string) => seed.templates.find((t) => t.slug === slug)!;

function copySeed(mutate: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "seed-"));
  cpSync(SEED_DIR, dir, { recursive: true });
  mutate(dir);
  return dir;
}
function editJson(dir: string, file: string, fn: (j: any) => void) {
  const p = join(dir, file);
  const j = JSON.parse(readFileSync(p, "utf8"));
  fn(j);
  writeFileSync(p, JSON.stringify(j, null, 2));
}

describe("validation des fichiers", () => {
  it("charge les quatre modèles et la bibliothèque", () => {
    expect(seed.templates.map((t) => t.slug)).toEqual(["infogerance", "supervision", "rssi", "sauvegarde-en-ligne"]);
    expect(seed.library.length).toBeGreaterThanOrEqual(5);
  });

  it("refuse une référence de bibliothèque inconnue", () => {
    const dir = copySeed((d) => editJson(d, "rssi.json", (j) => (j.sections[9].libraryKey = "inconnu")));
    expect(() => loadSeed(dir)).toThrow(SeedValidationError);
  });

  it("refuse un prix par choix incomplet", () => {
    const dir = copySeed((d) =>
      editJson(d, "infogerance.json", (j) => delete j.pricing.lines[0].pricing.byChoice["36"]),
    );
    expect(() => loadSeed(dir)).toThrow(/byChoice doit couvrir/);
  });

  it("refuse une balise de fusion non autorisée", () => {
    const dir = copySeed((d) =>
      editJson(d, "supervision.json", (j) => (j.sections[2].body += " {{client.motDePasse}}")),
    );
    expect(() => loadSeed(dir)).toThrow(/balise non autorisée/);
  });

  it("refuse un montant non entier (centimes)", () => {
    const dir = copySeed((d) =>
      editJson(d, "infogerance.json", (j) => (j.pricing.lines[0].pricing.byChoice["24"] = 25.5)),
    );
    expect(() => loadSeed(dir)).toThrow(SeedValidationError);
  });
});

describe("cas de contrôle chiffrés", () => {
  for (const slug of ["infogerance", "supervision", "rssi", "sauvegarde-en-ligne"]) {
    it(`${slug} : tous les cas de contrôle passent`, () => {
      expect(runControlCases(tpl(slug))).toEqual([]);
    });
  }

  it("infogérance 50 postes / 2 serveurs / 5 réseau : 1 515,00 € et 1 362,50 € HT par mois", () => {
    const q = { "poste-travail": 50, serveur: 2, "equipement-reseau": 5 };
    expect(evaluate(tpl("infogerance"), { choices: { engagement: "24" }, quantities: q }).monthlyCents).toBe(151500);
    expect(evaluate(tpl("infogerance"), { choices: { engagement: "36" }, quantities: q }).monthlyCents).toBe(136250);
  });

  it("RSSI : remise combinée de 10 % portée par une ligne distincte", () => {
    const ev = evaluate(tpl("rssi"), { choices: { formule: "TPE_PME" }, selectedOptions: ["dpo"] });
    expect(ev.lines.find((l) => l.key === "remise-combinee")?.totalCents).toBe(-15500);
    expect(ev.monthlyCents).toBe(139500);
  });

  it("RSSI : formule présélectionnée selon l'effectif", () => {
    expect(evaluate(tpl("rssi"), { context: { "client.effectif": 12 } }).choices.formule).toBe("TPE_PME");
    expect(evaluate(tpl("rssi"), { context: { "client.effectif": 120 } }).choices.formule).toBe("PME");
    expect(evaluate(tpl("rssi"), { context: { "client.effectif": 800 } }).choices.formule).toBe("ETI");
  });

  it("supervision : contrôle des sauvegardes ajouté dès qu'un serveur est supervisé", () => {
    const ev = evaluate(tpl("supervision"), { quantities: { "serveur-supervise": 1, "equipement-reseau": 0 } });
    expect(ev.lines.some((l) => l.key === "controle-sauvegardes")).toBe(true);
  });

  it("supervision : au moins un équipement est exigé", () => {
    const ev = evaluate(tpl("supervision"), { quantities: { "serveur-supervise": 0, "equipement-reseau": 0 } });
    expect(ev.errors).toContain("Indiquez au moins un équipement à superviser.");
  });

  it("infogérance : Intune / Defender refusé sans l'option tenant, et plafonné au nombre de postes", () => {
    const base = { "poste-travail": 5, serveur: 0, "equipement-reseau": 0 };
    const sans = evaluate(tpl("infogerance"), { quantities: { ...base, "m365-poste-premium": 3 }, selectedOptions: ["m365-poste-premium"] });
    expect(sans.errors.join()).toMatch(/nécessite l'option Gestion du tenant/);
    const trop = evaluate(tpl("infogerance"), {
      quantities: { ...base, "m365-poste-premium": 6 },
      selectedOptions: ["m365-tenant", "m365-poste-premium"],
    });
    expect(trop.errors.join()).toMatch(/supérieure à celle de poste-travail/);
  });

  it("infogérance : quantités par défaut issues des balises de fusion", () => {
    const ev = evaluate(tpl("infogerance"), {
      context: { "parc.nbPostes": 8, "parc.nbServeurs": 1, "parc.nbEquipementsReseau": 2 },
    });
    expect(ev.errors).toEqual([]);
    expect(ev.monthlyCents).toBe(8 * 2500 + 9500 + 2 * 1500);
  });
});

describe("sauvegarde en ligne", () => {
  const vide = { poste: 0, serveur: 0, hyperviseur: 0, nas: 0, "m365-utilisateur": 0, stockage: 1 };

  it("au moins un élément à sauvegarder est exigé", () => {
    const ev = evaluate(tpl("sauvegarde-en-ligne"), { quantities: vide });
    expect(ev.errors.join()).toMatch(/au moins un élément/);
  });

  it("le stockage est facturé au To, avec tarif préférentiel sur 36 mois", () => {
    const q = { ...vide, serveur: 1, stockage: 3 };
    const m24 = evaluate(tpl("sauvegarde-en-ligne"), { choices: { engagement: "24" }, quantities: q }).monthlyCents;
    const m36 = evaluate(tpl("sauvegarde-en-ligne"), { choices: { engagement: "36" }, quantities: q }).monthlyCents;
    expect(m24).toBe(2700 + 3 * 2900);
    expect(m36).toBe(2500 + 3 * 2600);
  });

  it("la seconde copie ne peut pas dépasser le volume principal", () => {
    const ev = evaluate(tpl("sauvegarde-en-ligne"), {
      quantities: { ...vide, serveur: 1, stockage: 2, "copie-secondaire": 3 },
      selectedOptions: ["copie-secondaire"],
    });
    expect(ev.errors.length).toBeGreaterThan(0);
  });

  it("une proposition de sauvegarde ne peut pas être envoyée en l'état", () => {
    const b = blockingValidations(tpl("sauvegarde-en-ligne"), { quantities: { ...vide, serveur: 1 } });
    expect(b.map((p) => p.key)).toEqual(expect.arrayContaining(["serveur", "stockage", "conservation"]));
  });
});

describe("prix à valider", () => {
  it("la supervision a des prix à valider, l'infogérance uniquement ses niveaux de service", () => {
    expect(listPendingValidations(tpl("supervision")).length).toBeGreaterThan(5);
    expect(listPendingValidations(tpl("infogerance"))).toEqual([
      { scope: "SECTION", key: "niveaux-de-service", label: "Niveaux de service" },
    ]);
  });

  it("RSSI : la formule PME bloque l'envoi, la formule ETI sans section Organisation non", () => {
    const pme = blockingValidations(tpl("rssi"), { choices: { formule: "PME" }, selectedOptions: ["dpo"] });
    expect(pme.map((p) => p.key)).toEqual(expect.arrayContaining(["rssi-forfait", "dpo", "mise-en-place"]));
    const eti = blockingValidations(tpl("rssi"), { choices: { formule: "ETI" }, selectedOptions: ["dpo"] }, ["organisation"]);
    expect(eti).toEqual([]);
  });

  it("une proposition de supervision ne peut pas être envoyée en l'état", () => {
    const b = blockingValidations(tpl("supervision"), { quantities: { "serveur-supervise": 1, "equipement-reseau": 0 } });
    expect(b.length).toBeGreaterThan(0);
  });
});

describe("seed idempotent", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = {
      tenants: new Map([["lsi-maintenance", "t1"]]),
      contractTemplates: new Set(["t1:infogerance", "t1:supervision", "t1:rssi-externalise", "t1:sauvegarde-en-ligne"]),
      library: new Map(),
      templates: new Map(),
    };
  });

  it("crée tout au premier passage puis ne change rien au second", async () => {
    const repo = createMemorySeedRepository(store);
    const r1 = await seedProposalTemplates(repo, { tenantSlug: "lsi-maintenance" });
    expect(Object.values(r1.templates)).toEqual(["CREATED", "CREATED", "CREATED", "CREATED"]);
    expect(r1.warnings).toEqual([]);
    const r2 = await seedProposalTemplates(repo, { tenantSlug: "lsi-maintenance" });
    expect(Object.values(r2.templates)).toEqual(["UNCHANGED", "UNCHANGED", "UNCHANGED", "UNCHANGED"]);
    expect(Object.values(r2.library).every((o) => o === "UNCHANGED")).toBe(true);
    expect([...store.templates.values()].every((t) => t.writes === 1)).toBe(true);
  });

  it("ne réécrase jamais un modèle modifié dans l'interface", async () => {
    const repo = createMemorySeedRepository(store);
    await seedProposalTemplates(repo, { tenantSlug: "lsi-maintenance" });
    store.templates.get("t1:rssi")!.userModifiedAt = new Date();
    const dir = copySeed((d) => editJson(d, "rssi.json", (j) => ((j.seedVersion = 2), (j.name = "RSSI v2"))));
    const r = await seedProposalTemplates(repo, { tenantSlug: "lsi-maintenance", seed: loadSeed(dir) });
    expect(r.templates.rssi).toBe("SKIPPED_MODIFIED");
    expect(store.templates.get("t1:rssi")!.template.name).toBe("RSSI externalisé");
  });

  it("--force restaure la version du seed d'un modèle modifié", async () => {
    const repo = createMemorySeedRepository(store);
    await seedProposalTemplates(repo, { tenantSlug: "lsi-maintenance" });
    const rec = store.templates.get("t1:rssi")!;
    rec.userModifiedAt = new Date();
    const r = await seedProposalTemplates(repo, { tenantSlug: "lsi-maintenance", force: true });
    expect(r.templates.rssi).toBe("UPDATED");
    expect(store.templates.get("t1:rssi")!.userModifiedAt).toBeNull();
  });

  it("met à jour quand seedVersion augmente", async () => {
    const repo = createMemorySeedRepository(store);
    await seedProposalTemplates(repo, { tenantSlug: "lsi-maintenance" });
    const dir = copySeed((d) => editJson(d, "rssi.json", (j) => ((j.seedVersion = 2), (j.name = "RSSI v2"))));
    const r = await seedProposalTemplates(repo, { tenantSlug: "lsi-maintenance", seed: loadSeed(dir) });
    expect(r.templates.rssi).toBe("UPDATED");
    expect(store.templates.get("t1:rssi")!.template.name).toBe("RSSI v2");
  });

  it("refuse un contenu modifié sans incrément de seedVersion, sans rien écrire", async () => {
    const repo = createMemorySeedRepository(store);
    await seedProposalTemplates(repo, { tenantSlug: "lsi-maintenance" });
    const dir = copySeed((d) => editJson(d, "infogerance.json", (j) => (j.name = "Autre nom")));
    await expect(
      seedProposalTemplates(repo, { tenantSlug: "lsi-maintenance", seed: loadSeed(dir) }),
    ).rejects.toThrow(SeedConflictError);
    expect(store.templates.get("t1:infogerance")!.writes).toBe(1);
  });

  it("refuse d'écrire si un cas de contrôle échoue", async () => {
    const dir = copySeed((d) =>
      editJson(d, "infogerance.json", (j) => (j.controlCases[0].expected.monthlyCents = 154500)),
    );
    await expect(
      seedProposalTemplates(createMemorySeedRepository(store), { tenantSlug: "lsi-maintenance", seed: loadSeed(dir) }),
    ).rejects.toThrow(/Cas de contrôle en échec/);
    expect(store.templates.size).toBe(0);
  });

  it("signale un contrat type manquant sans bloquer", async () => {
    store.contractTemplates.delete("t1:rssi-externalise");
    const r = await seedProposalTemplates(createMemorySeedRepository(store), { tenantSlug: "lsi-maintenance" });
    expect(r.warnings.join()).toMatch(/rssi-externalise/);
    expect(r.templates.rssi).toBe("CREATED");
  });

  it("mode --dry-run : rapport sans écriture", async () => {
    const r = await seedProposalTemplates(createMemorySeedRepository(store), { tenantSlug: "lsi-maintenance", dryRun: true });
    expect(r.templates.infogerance).toBe("CREATED");
    expect(store.templates.size).toBe(0);
  });
});
