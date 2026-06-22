/**
 * GetAgent — 08 · Human-in-the-Loop (approbation d'outils)
 *
 * Un outil marqué `requiresApproval = true` déclenche le callback
 * `onApprovalRequired` avant son exécution. Retourner true autorise,
 * false annule (l'agent reçoit alors un résultat « cancelled »).
 *
 * Lancer :  npx tsx examples/08_human_in_the_loop.ts
 * (par défaut l'approbation est automatique ; passez `interactif`
 *  pour confirmer chaque action au clavier :
 *   npx tsx examples/08_human_in_the_loop.ts interactif)
 */
import { z } from "zod";
import * as readline from "node:readline/promises";
import { Agent, createTool } from "../src/index.js";

// Outil sans risque
const listerFichiers = createTool(
  "lister_fichiers",
  "Liste les fichiers d'un dossier (simulé).",
  z.object({ dossier: z.string() }),
  ({ dossier }) => ({ dossier, fichiers: ["rapport.csv", "backup.sql", "notes.md"] })
);

// Outil sensible
const supprimerFichier = createTool(
  "supprimer_fichier",
  "Supprime définitivement un fichier.",
  z.object({ chemin: z.string() }),
  ({ chemin }) => {
    console.log(`   [supprimer_fichier] suppression simulée de ${chemin}`);
    return { success: true, supprime: chemin };
  }
);
supprimerFichier.requiresApproval = true; // ← nécessite une approbation humaine

async function demanderConfirmation(toolName: string, args: unknown): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const rep = (await rl.question(
    `\n⚠️  Autoriser ${toolName}(${JSON.stringify(args)}) ? (o/n) : `
  )).trim().toLowerCase();
  rl.close();
  return rep === "o" || rep === "oui" || rep === "y";
}

async function main() {
  console.log("══ 08 · Human-in-the-Loop ══\n");

  const interactif = process.argv.includes("interactif");

  const agent = new Agent({
    name: "GestionnaireFichiers",
    systemPrompt:
      "Tu gères des fichiers. Liste-les d'abord, puis supprime ce qui est demandé.",
    tools: [listerFichiers, supprimerFichier],
    onApprovalRequired: async (toolName, args) => {
      if (interactif) return demanderConfirmation(toolName, args);
      // Mode non interactif : on refuse par sécurité et on journalise
      console.log(`\n🚫 Approbation refusée automatiquement pour ${toolName}(${JSON.stringify(args)})`);
      return false;
    },
  });

  const reponse = await agent.run(
    "Liste les fichiers de /data puis supprime backup.sql."
  );
  console.log("\n💬 Réponse :\n", reponse);

  await agent.shutdown();
  console.log("\n✅ Terminé.  (astuce : relancez avec l'argument `interactif`)");
}

main().catch(console.error);
