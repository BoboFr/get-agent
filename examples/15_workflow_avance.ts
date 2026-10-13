/**
 * GetAgent — 15 · Workflow avancé (parallèle, retry, trace, reprise)
 *
 * Analyse d'un avis client par deux agents qui travaillent EN PARALLÈLE,
 * puis synthèse. Le workflow est sauvegardé après chaque étape : relancer
 * le script avec le même RUN_ID reprend là où il s'était arrêté.
 *
 *            ┌─ sentiment (agent A) ─┐
 *   analyser ┤                       ├─► synthese ──► END
 *            └─ themes    (agent B) ─┘
 *
 * Lancer :  npx tsx examples/15_workflow_avance.ts
 */
import { z } from "zod";
import { Agent, END, FileCheckpointAdapter, Workflow, WorkflowError } from "../src/index.js";

const EtatSchema = z.object({
  avis: z.string(),
  sentiment: z.enum(["positif", "neutre", "negatif"]).optional(),
  themes: z.array(z.string()).default([]),
  synthese: z.string().default(""),
});

const sentimentAgent = new Agent({
  name: "Sentiment",
  systemPrompt: "Tu classes le sentiment d'un avis client.",
  temperature: 0,
});
const themesAgent = new Agent({
  name: "Thèmes",
  systemPrompt: "Tu extrais les thèmes abordés dans un avis client (2 à 4 mots-clés).",
  temperature: 0,
});
const redacteur = new Agent({
  name: "Rédacteur",
  systemPrompt: "Tu rédiges une synthèse d'une phrase pour l'équipe support.",
});

// fromSchema : les champs avec .default() deviennent facultatifs dans run().
const workflow = Workflow.fromSchema(EtatSchema, {
  name: "Analyse d'avis",
  verbose: true,
  strict: true, // chaque étape doit mener explicitement à une autre ou à END
  checkpoint: new FileCheckpointAdapter(".workflow-checkpoints"),
  hooks: {
    onStepEnd: (step, { durationMs }) => console.log(`  ⏱️  ${step} : ${Math.round(durationMs)} ms`),
  },
});

workflow
  // Les deux branches tournent en même temps : la durée de l'étape ≈ la plus lente des deux.
  .addParallelStep(
    "analyser",
    {
      sentiment: async (state) => {
        sentimentAgent.clearHistory();
        const { sentiment } = await sentimentAgent.run(state.avis, {
          schema: z.object({ sentiment: z.enum(["positif", "neutre", "negatif"]) }),
        });
        return { sentiment };
      },
      themes: async (state) => {
        themesAgent.clearHistory();
        const { themes } = await themesAgent.run(state.avis, {
          schema: z.object({ themes: z.array(z.string()) }),
        });
        return { themes };
      },
    },
    { retries: 1, timeoutMs: 120_000 } // un appel LLM raté est retenté une fois
  )
  .addStep("synthese", async (state, ctx) => {
    redacteur.clearHistory();
    const synthese = await redacteur.run(
      `Avis : ${state.avis}\nSentiment : ${state.sentiment}\nThèmes : ${state.themes.join(", ")}`,
      { signal: ctx.signal } // annule l'appel LLM si le workflow est interrompu
    );
    return { synthese };
  })
  .setStart("analyser")
  .addEdge("analyser", "synthese")
  .addEdge("synthese", END);

async function main() {
  console.log("══ 15 · Workflow avancé ══\n");
  const runId = process.env.RUN_ID ?? `avis-${Date.now()}`;

  try {
    const { state, trace } = await workflow.runWithTrace(
      { avis: "Livraison rapide, mais le produit est arrivé rayé et le SAV ne répond pas." },
      { runId }
    );
    console.log("\n📋 Résultat :", state);
    console.log("🧭 Étapes   :", trace.map((t) => `${t.step} → ${t.next ?? "fin"}`).join(" | "));
  } catch (err) {
    if (err instanceof WorkflowError) {
      console.error(`\n❌ Échec à l'étape '${err.step}' : ${err.message}`);
      console.error(`   Relancez avec RUN_ID=${runId} pour reprendre via workflow.resume().`);
    } else {
      throw err;
    }
  } finally {
    await Promise.all([sentimentAgent.shutdown(), themesAgent.shutdown(), redacteur.shutdown()]);
  }
}

// Avec RUN_ID défini, on reprend le run existant au lieu d'en démarrer un nouveau.
if (process.env.RUN_ID) {
  workflow
    .resume(process.env.RUN_ID)
    .then(({ state }) => console.log("📋 Résultat (repris) :", state))
    .catch(console.error);
} else {
  main().catch(console.error);
}
