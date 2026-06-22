/**
 * GetAgent — 11 · Chat multi-tours en streaming
 *
 * L'agent conserve son historique entre les appels `runStream()` successifs : il
 * se souvient donc du contexte des tours précédents, tout en diffusant ses
 * réponses token par token. Cet exemple montre :
 *  - une conversation à plusieurs messages diffusée en temps réel (streaming)
 *  - la mémoire entre les tours
 *  - l'inspection de l'historique via getHistory()
 *  - le redémarrage d'une conversation avec clearHistory()
 *  - l'injection d'un historique pré-rempli (tableau de Message)
 *
 * Lancer :  npx tsx examples/11_chat_conversation.ts
 */
import { Agent, type Message } from "../src/index.js";

async function main() {
  console.log("══ 11 · Chat multi-tours (streaming) ══\n");

  const agent = new Agent({
    name: "Compagnon",
    systemPrompt:
      "Tu es un compagnon de conversation chaleureux et concis. " +
      "Tu te souviens de ce que dit l'utilisateur au fil de l'échange.",
    showThinking: true, // diffuse le raisonnement (<think>…</think>) dans le flux
  });

  // Petit utilitaire : diffuse la réponse de l'agent token par token.
  const streamReponse = async (input: string | Message[]) => {
    process.stdout.write("🤖 ");
    for await (const chunk of agent.runStream(input)) {
      process.stdout.write(chunk);
    }
    process.stdout.write("\n\n");
  };

  // ── 1. Conversation : chaque runStream() s'ajoute à l'historique ──────────
  const tours = [
    "Salut ! Je m'appelle Gaëtan et j'adore la randonnée.",
    "Quel est mon prénom, déjà ?",
    "Suggère-moi une activité pour ce week-end en fonction de ce que tu sais de moi.",
  ];

  for (const message of tours) {
    console.log(`👤 ${message}`);
    await streamReponse(message);
  }

  // ── 2. Inspecter l'historique accumulé ────────────────────────────────────
  const historique = agent.getHistory();
  console.log("─".repeat(50));
  console.log(`📜 Historique : ${historique.length} message(s)`);
  for (const m of historique) {
    const apercu = (m.content ?? "[appel d'outil]").replace(/\s+/g, " ").slice(0, 60);
    console.log(`   [${m.role.padEnd(9)}] ${apercu}`);
  }

  // ── 3. Repartir de zéro pour une nouvelle discussion ──────────────────────
  agent.clearHistory();
  console.log("\n" + "─".repeat(50));
  console.log("🔄 Historique effacé — nouvelle conversation\n");
  console.log("👤 Te souviens-tu de mon prénom ?");
  await streamReponse("Te souviens-tu de mon prénom ?"); // l'agent ne sait plus : l'historique est vide

  // ── 4. Démarrer avec un historique pré-rempli ─────────────────────────────
  console.log("─".repeat(50));
  console.log("🌱 Conversation amorcée avec un historique fourni\n");

  const contextePrealable: Message[] = [
    { role: "system", content: "Tu es un assistant culinaire spécialisé en cuisine italienne." },
    { role: "user", content: "Je suis allergique aux fruits de mer." },
    { role: "assistant", content: "C'est noté : je n'utiliserai aucun fruit de mer dans mes suggestions." },
  ];

  // Passer un tableau de Message remplace l'historique courant et poursuit l'échange
  console.log("👤 Propose-moi un plat de pâtes simple.");
  await streamReponse([
    ...contextePrealable,
    { role: "user", content: "Propose-moi un plat de pâtes simple." },
  ]);

  await agent.shutdown();
  console.log("✅ Terminé.");
}

main().catch(console.error);
