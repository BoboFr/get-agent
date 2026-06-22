/**
 * GetAgent — 09 · Multi-agents (Agent-as-Tool)
 *
 * `createAgentTool` encapsule un agent en tant qu'outil, qu'un agent
 * orchestrateur peut appeler pour déléguer des tâches spécialisées.
 *
 *   Orchestrateur
 *     ├── rédacteur   (sous-agent exposé comme outil)
 *     └── relecteur   (sous-agent exposé comme outil)
 *
 * Lancer :  npx tsx examples/09_multi_agents.ts
 */
import { Agent, createAgentTool } from "../src/index.js";

// ── Sous-agents spécialisés ─────────────────────────────────────────────────
const redacteur = new Agent({
  name: "Rédacteur",
  systemPrompt:
    "Tu rédiges un court paragraphe (3-4 phrases) clair et engageant sur le sujet demandé. " +
    "Réponds uniquement avec le paragraphe.",
});

const relecteur = new Agent({
  name: "Relecteur",
  systemPrompt:
    "Tu corriges et améliores le texte fourni (style, clarté, orthographe). " +
    "Réponds uniquement avec la version améliorée.",
});

// ── Exposition comme outils ─────────────────────────────────────────────────
const outilRediger = createAgentTool(redacteur, {
  name: "rediger",
  description: "Rédige un court paragraphe sur un sujet donné.",
  keepHistory: false, // historique réinitialisé à chaque appel
});

const outilRelire = createAgentTool(relecteur, {
  name: "relire",
  description: "Améliore et corrige un texte existant.",
  keepHistory: false,
});

// ── Orchestrateur ───────────────────────────────────────────────────────────
const orchestrateur = new Agent({
  name: "Orchestrateur",
  systemPrompt:
    "Tu coordonnes des agents spécialisés. Pour produire du contenu, appelle d'abord " +
    "l'outil `rediger`, puis passe le résultat à l'outil `relire`. Renvoie le texte final.",
  tools: [outilRediger, outilRelire],
  verbose: true,
});

async function main() {
  console.log("══ 09 · Multi-agents ══\n");

  const reponse = await orchestrateur.run(
    "Produis un paragraphe abouti sur les bénéfices du protocole MCP pour les agents IA."
  );
  console.log("\n💬 Texte final :\n", reponse);

  // Nettoyage des trois agents
  await Promise.all([
    orchestrateur.shutdown(),
    redacteur.shutdown(),
    relecteur.shutdown(),
  ]);
  console.log("\n✅ Terminé.");
}

main().catch(console.error);
