/**
 * GetAgent — 06 · Streaming & REPL
 *
 * Trois modes de sortie temps réel :
 *  - runStream            : flux de texte token par token
 *  - runStreamStructured  : flux + objet final validé par Zod
 *  - repl                 : boucle interactive en terminal
 *
 * Lancer :  npx tsx examples/06_streaming_et_repl.ts
 * (passez `repl` en argument pour démarrer la session interactive :
 *   npx tsx examples/06_streaming_et_repl.ts repl)
 */
import { z } from "zod";
import { Agent } from "../src/index.js";

async function main() {
  console.log("══ 06 · Streaming & REPL ══\n");

  const agent = new Agent({
    name: "Conteur",
    systemPrompt: "Tu es un assistant vif et créatif.",
    showThinking: false, // n'émet pas les blocs <think> dans le flux
  });

  // ── Mode REPL interactif (si l'argument `repl` est fourni) ────────────────
  if (process.argv.includes("repl")) {
    await agent.repl({ stream: true, prompt: "Vous" });
    await agent.shutdown();
    return;
  }

  // ── 1. Streaming texte ────────────────────────────────────────────────────
  console.log("» runStream :");
  for await (const chunk of agent.runStream("Écris un haïku sur le code.")) {
    process.stdout.write(chunk);
  }
  console.log("\n");

  agent.clearHistory();

  // ── 2. Streaming + sortie structurée ──────────────────────────────────────
  const Idee = z.object({
    nom: z.string(),
    pitch: z.string(),
    motsCles: z.array(z.string()),
  });

  console.log("» runStreamStructured (flux) :");
  const { stream, result } = agent.runStreamStructured(
    "Propose une idée d'app mobile, en JSON {nom, pitch, motsCles}.",
    { schema: Idee, maxRetries: 2 }
  );

  for await (const chunk of stream) {
    process.stdout.write(chunk);
  }

  const idee = await result;
  console.log("\n\n» Objet validé :", idee);

  await agent.shutdown();
  console.log("\n✅ Terminé.  (astuce : relancez avec l'argument `repl`)");
}

main().catch(console.error);
