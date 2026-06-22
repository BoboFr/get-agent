/**
 * GetAgent — 13 · Scoring orchestré en Workflow
 *
 * Variante « production » de l'exemple 12 : le cycle produire → noter → raffiner
 * est exprimé comme un graphe d'étapes (Workflow) plutôt qu'une boucle manuelle.
 *
 *   produire ──► noter ──┬─(global >= seuil)──────────► publier ──► END
 *                        ├─(tentatives >= max)────────► publier ──► END
 *                        └─(sinon : raffiner)──────────► produire (boucle)
 *
 * Avantages vs boucle manuelle : transitions explicites, garde-fou anti-boucle
 * intégré (maxSteps), état centralisé et validé par Zod.
 *
 * Lancer :  npx tsx examples/13_scoring_workflow.ts
 */
import { z } from "zod";
import { Agent, Workflow } from "../src/index.js";

// ── Évaluation renvoyée par le juge ─────────────────────────────────────────
const EvaluationSchema = z.object({
  pertinence: z.number().min(0).max(10),
  exactitude: z.number().min(0).max(10),
  clarte: z.number().min(0).max(10),
  global: z.number().min(0).max(10),
  pointsFaibles: z.array(z.string()),
  suggestions: z.string(),
});
type Evaluation = z.infer<typeof EvaluationSchema>;

// ── État partagé du workflow ────────────────────────────────────────────────
const EtatSchema = z.object({
  question: z.string(),
  brouillon: z.string().default(""),
  evaluation: EvaluationSchema.nullable().default(null),
  tentatives: z.number().default(0),
  seuil: z.number().default(8),
  maxTentatives: z.number().default(3),
});
type Etat = z.infer<typeof EtatSchema>;

// ── Agents : un producteur, un juge ─────────────────────────────────────────
const producteur = new Agent({
  name: "Producteur",
  systemPrompt: "Tu réponds aux questions de façon utile, exacte et concise.",
});

const juge = new Agent({
  name: "Juge",
  systemPrompt:
    "Tu es un évaluateur rigoureux et cohérent. Tu notes une réponse de 0 à 10 par " +
    "critère. Sois strict : réserve les notes >= 8 aux réponses réellement excellentes.",
  temperature: 0,
});

// ── Définition du workflow ──────────────────────────────────────────────────
const workflow = new Workflow<Etat>({
  name: "Scoring & Raffinement",
  stateSchema: EtatSchema,
  verbose: true,
  maxSteps: 12, // garde-fou : (produire+noter) × maxTentatives + marge
});

workflow
  .addStep("produire", async (state) => {
    producteur.clearHistory();
    const retour = state.evaluation?.suggestions;
    const prompt = retour
      ? `${state.question}\n\nAméliore ta réponse en tenant compte de ce retour :\n${retour}`
      : state.question;
    const brouillon = String(await producteur.run(prompt));
    console.log(`\n  🟦 Brouillon #${state.tentatives + 1} : ${brouillon.replace(/\s+/g, " ").slice(0, 120)}…`);
    return { brouillon, tentatives: state.tentatives + 1 };
  })
  .addStep("noter", async (state) => {
    juge.clearHistory();
    const evaluation = (await juge.run(
      `Question :\n${state.question}\n\nRéponse à évaluer :\n${state.brouillon}\n\nÉvalue-la.`,
      { schema: EvaluationSchema, maxRetries: 2 }
    )) as Evaluation;
    console.log(
      `  🟨 Score : pertinence=${evaluation.pertinence} exactitude=${evaluation.exactitude} ` +
      `clarté=${evaluation.clarte} → global=${evaluation.global}/10`
    );
    return { evaluation };
  })
  .addStep("publier", (state) => {
    const g = state.evaluation?.global ?? 0;
    const verdict = g >= state.seuil ? "✅ validée" : "⚠️ publiée par défaut (seuil non atteint)";
    console.log(`\n  📤 Réponse ${verdict} après ${state.tentatives} tentative(s).`);
    return {};
  });

workflow
  .setStart("produire")
  .addEdge("produire", "noter")
  .addConditionalEdge("noter", (state) => {
    const global = state.evaluation?.global ?? 0;
    if (global >= state.seuil) return "publier";           // objectif atteint
    if (state.tentatives >= state.maxTentatives) return "publier"; // plus de tentatives
    console.log("  🔁 Sous le seuil → raffinement.");
    return "produire";                                     // boucle de reprise
  })
  .addEdge("publier", "END");

async function main() {
  console.log("══ 13 · Scoring orchestré (Workflow) ══");

  const final = await workflow.run({
    question: "Explique en quoi l'IA est utile en entreprise.",
    brouillon: "",
    evaluation: null,
    tentatives: 0,
    seuil: 8,
    maxTentatives: 3,
  });

  console.log("\n" + "═".repeat(55));
  console.log("RÉPONSE FINALE :\n");
  console.log(final.brouillon);
  console.log("\nNote globale :", final.evaluation?.global, "/10");
  console.log("Tentatives   :", final.tentatives);

  await Promise.all([producteur.shutdown(), juge.shutdown()]);
  console.log("\n✅ Terminé.");
}

main().catch(console.error);
