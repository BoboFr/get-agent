/**
 * GetAgent — 04 · Serveurs MCP (Model Context Protocol)
 *
 * L'agent se connecte à un/des serveur(s) MCP via stdio et expose
 * automatiquement leurs outils. Ici, le serveur officiel « filesystem ».
 *
 * Prérequis : npx doit pouvoir récupérer le serveur MCP. Adaptez le chemin
 * autorisé (dernier argument) à un dossier réel de votre machine.
 *
 * Lancer :  npx tsx examples/04_mcp.ts
 */
import { Agent } from "../src/index.js";

async function main() {
  console.log("══ 04 · Serveurs MCP ══\n");

  const agent = new Agent({
    name: "AgentFichiers",
    systemPrompt: "Tu aides l'utilisateur à explorer ses fichiers via les outils MCP disponibles.",
    mcpServers: [
      {
        name: "filesystem",
        command: "npx",
        // Le dernier argument est le dossier autorisé — adaptez-le.
        args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
      },
    ],
    verbose: true,
  });

  // initialize() est implicite au premier run(), mais on l'appelle ici
  // pour pouvoir lister les outils MCP avant l'échange.
  await agent.initialize();
  console.log("Outils exposés par MCP :", agent.getRegisteredTools().map((t) => t.name), "\n");

  const reponse = await agent.run(
    "Liste les fichiers présents à la racine du dossier autorisé."
  );
  console.log("\n💬 Réponse :\n", reponse);

  await agent.shutdown(); // ferme proprement les connexions MCP
  console.log("\n✅ Terminé.");
}

main().catch(console.error);
