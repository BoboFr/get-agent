/**
 * GetAgent — 05 · Workflow (graphe d'étapes avec état)
 *
 * Un workflow orchestre des étapes reliées par des arêtes simples ou
 * conditionnelles, autour d'un état partagé validé par Zod.
 *
 * Scénario : pipeline de modération de commentaire avec boucle de reprise.
 *
 * Lancer :  npx tsx examples/05_workflow.ts
 */
import { z } from "zod";
import { Workflow } from "../src/index.js";

const EtatSchema = z.object({
  commentaire: z.string(),
  motsInterdits: z.array(z.string()).default([]),
  tentatives: z.number().default(0),
  statut: z.enum(["en_cours", "publie", "rejete"]).default("en_cours"),
});

type Etat = z.infer<typeof EtatSchema>;

const workflow = new Workflow<Etat>({
  name: "Modération",
  stateSchema: EtatSchema,
  verbose: true,
  maxSteps: 20,
});

const BLACKLIST = ["spam", "arnaque", "scandale"];

workflow
  .addStep("analyser", (state) => {
    const trouves = BLACKLIST.filter((m) =>
      state.commentaire.toLowerCase().includes(m)
    );
    return { motsInterdits: trouves, tentatives: state.tentatives + 1 };
  })
  .addStep("nettoyer", (state) => {
    // Censure les mots interdits puis on relancera l'analyse
    let texte = state.commentaire;
    for (const mot of state.motsInterdits) {
      texte = texte.replace(new RegExp(mot, "gi"), "***");
    }
    return { commentaire: texte };
  })
  .addStep("publier", () => ({ statut: "publie" as const }))
  .addStep("rejeter", () => ({ statut: "rejete" as const }));

workflow
  .setStart("analyser")
  // Si propre → publier ; sinon nettoyer (sauf si trop de tentatives → rejeter)
  .addConditionalEdge("analyser", (state) => {
    if (state.motsInterdits.length === 0) return "publier";
    if (state.tentatives >= 3) return "rejeter";
    return "nettoyer";
  })
  .addEdge("nettoyer", "analyser") // boucle de reprise
  .addEdge("publier", "END")
  .addEdge("rejeter", "END");

async function main() {
  console.log("══ 05 · Workflow ══\n");

  const resultat = await workflow.run({
    commentaire: "Super produit, mais attention au spam dans les avis !",
    motsInterdits: [],
    tentatives: 0,
    statut: "en_cours",
  });

  console.log("\n📋 Résultat final :");
  console.log("   Statut       :", resultat.statut);
  console.log("   Tentatives   :", resultat.tentatives);
  console.log("   Commentaire  :", resultat.commentaire);
  console.log("\n✅ Terminé.");
}

main().catch(console.error);
