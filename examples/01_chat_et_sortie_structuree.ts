/**
 * GetAgent — 01 · Chat & Sortie structurée
 *
 * Les bases : instancier un agent, lancer un échange simple, puis forcer
 * une réponse JSON validée par un schéma Zod.
 *
 * Lancer :  npx tsx examples/01_chat_et_sortie_structuree.ts
 */
import { z } from "zod";
import { Agent } from "../src/index.js";

async function main() {
  console.log("══ 01 · Chat & Sortie structurée ══\n");

  const agent = new Agent({
    name: "Assistant",
    systemPrompt: "Tu es un assistant concis et précis.",
    // Adaptez model / baseUrl à votre backend compatible OpenAI :
    // model: "Qwen3.5-9B.gguf",
    // baseUrl: "http://localhost:8080/v1",
    // apiKey: "no-key",
    showThinking: true
  });

  // ── 1. Échange texte simple ──────────────────────────────────────────────
  console.log("» Question libre :");
  const reponse = await agent.run("Explique le protocole MCP en une phrase.");
  console.log(reponse, "\n");

  agent.clearHistory();

  // ── 2. Sortie structurée validée par Zod ─────────────────────────────────
  const FicheFilm = z.object({
    titre: z.string(),
    synopsis: z.string(),
    annee: z.number(),
    genres: z.array(z.string()),
    note: z.number().min(0).max(10),
  });

  console.log("» Extraction structurée :\n");
  console.log("» Donne-moi une fiche pour le film Interstellar.")
  const fiche = await agent.run(
    "Donne-moi une fiche pour le film Interstellar.",
    { schema: FicheFilm, maxRetries: 2 }
  );

  // `fiche` est typé et garanti conforme au schéma
  console.log(fiche);

  await agent.shutdown();
  console.log("\n✅ Terminé.");
}

main().catch(console.error);
