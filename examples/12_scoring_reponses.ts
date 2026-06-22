/**
 * GetAgent — 12 · Scoring de réponses (LLM-as-judge)
 *
 * Noter la qualité des réponses d'un agent avec un second agent « juge » qui
 * renvoie un score structuré (validé par Zod), puis enchaîner une boucle
 * d'auto-amélioration : produire → noter → si sous le seuil, régénérer en
 * tenant compte du retour du juge.
 *
 * Idées d'intégration :
 *  - monitoring qualité (logguer le score de chaque réponse en prod)
 *  - garde-fou : ne renvoyer la réponse que si global >= seuil
 *  - boucle de raffinement (implémentée ici)
 *
 * Lancer :  npx tsx examples/12_scoring_reponses.ts
 */
import { z } from "zod";
import { Agent } from "../src/index.js";

// ── Schéma de l'évaluation renvoyée par le juge ─────────────────────────────
const EvaluationSchema = z.object({
  pertinence: z.number().min(0).max(10).describe("La réponse traite-t-elle bien la question ?"),
  exactitude: z.number().min(0).max(10).describe("Les informations sont-elles correctes ?"),
  clarte: z.number().min(0).max(10).describe("La réponse est-elle claire et bien structurée ?"),
  global: z.number().min(0).max(10).describe("Note globale, synthèse des critères"),
  pointsFaibles: z.array(z.string()).describe("Défauts concrets à corriger"),
  suggestions: z.string().describe("Conseil actionnable pour améliorer la réponse"),
});

type Evaluation = z.infer<typeof EvaluationSchema>;

// ── Agent producteur : répond à la question ─────────────────────────────────
const producteur = new Agent({
  name: "Producteur",
  systemPrompt: "Tu réponds aux questions de façon utile, exacte et concise.",
});

// ── Agent juge : évalue une réponse selon des critères ──────────────────────
const juge = new Agent({
  name: "Juge",
  systemPrompt:
    "Tu es un évaluateur rigoureux et cohérent. Tu notes la qualité d'une réponse " +
    "à une question, critère par critère, sur une échelle de 0 à 10. Sois strict : " +
    "réserve les notes >= 8 aux réponses réellement excellentes.",
  temperature: 0, // scoring le plus déterministe/stable possible
});

/** Évalue une réponse vis-à-vis de sa question. */
async function evaluer(question: string, reponse: string): Promise<Evaluation> {
  juge.clearHistory(); // chaque évaluation est indépendante
  return juge.run(
    `Question posée :\n${question}\n\nRéponse à évaluer :\n${reponse}\n\n` +
      `Évalue cette réponse selon les critères demandés.`,
    { schema: EvaluationSchema, maxRetries: 2 }
  ) as Promise<Evaluation>;
}

async function main() {
  console.log("══ 12 · Scoring de réponses (LLM-as-judge) ══\n");

  const question = "Explique en quoi le protocole MCP est utile pour un agent IA.";
  const SEUIL = 8;          // note globale visée
  const MAX_TENTATIVES = 3; // garde-fou anti-boucle

  let reponse = "";
  let evaluation: Evaluation | null = null;
  let retour = ""; // feedback du juge réinjecté au producteur

  for (let tentative = 1; tentative <= MAX_TENTATIVES; tentative++) {
    console.log(`\n── Tentative ${tentative}/${MAX_TENTATIVES} ──`);

    // 1) Produire (en tenant compte du retour précédent, s'il y en a un)
    producteur.clearHistory();
    const prompt = retour
      ? `${question}\n\nAméliore ta réponse en tenant compte de ce retour :\n${retour}`
      : question;
    reponse = String(await producteur.run(prompt));
    console.log("🟦 Réponse :", reponse.replace(/\s+/g, " ").slice(0, 160), "…");

    // 2) Noter
    evaluation = await evaluer(question, reponse);
    console.log(
      `🟨 Scores  : pertinence=${evaluation.pertinence} exactitude=${evaluation.exactitude} ` +
        `clarté=${evaluation.clarte} → global=${evaluation.global}/10`
    );
    if (evaluation.pointsFaibles.length) {
      console.log("   Points faibles :", evaluation.pointsFaibles.join(" ; "));
    }

    // 3) Décider : seuil atteint ?
    if (evaluation.global >= SEUIL) {
      console.log(`\n✅ Seuil atteint (>= ${SEUIL}) en ${tentative} tentative(s).`);
      break;
    }
    retour = evaluation.suggestions;
    console.log("🔁 Sous le seuil — régénération avec le retour du juge.");
  }

  console.log("\n" + "═".repeat(55));
  console.log("RÉPONSE FINALE RETENUE :\n");
  console.log(reponse);
  console.log("\nNote globale :", evaluation?.global, "/10");

  await Promise.all([producteur.shutdown(), juge.shutdown()]);
  console.log("\n✅ Terminé.");
}

main().catch(console.error);
