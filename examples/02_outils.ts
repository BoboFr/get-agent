/**
 * GetAgent — 02 · Outils (Tools)
 *
 * Donner des capacités à l'agent via `createTool`. Les arguments sont validés
 * automatiquement par Zod avant l'exécution de la fonction.
 *
 * Lancer :  npx tsx examples/02_outils.ts
 */
import { z } from "zod";
import { Agent, createTool } from "../src/index.js";
import type { AgentHooks } from '../src/index.js'

// ── Outil 1 : conversion de devise (taux simulés) ───────────────────────────
const convertirDevise = createTool(
  "convertir_devise",
  "Convertit un montant d'une devise vers une autre (EUR, USD, GBP).",
  z.object({
    montant: z.number().describe("Le montant à convertir"),
    de: z.enum(["EUR", "USD", "GBP"]).describe("Devise source"),
    vers: z.enum(["EUR", "USD", "GBP"]).describe("Devise cible"),
  }),
  ({ montant, de, vers }) => {
    const enEUR: Record<string, number> = { EUR: 1, USD: 0.92, GBP: 1.17 };
    const resultat = (montant * enEUR[de]) / enEUR[vers];
    console.log("resultat", resultat);
    return { resultat: Number(resultat.toFixed(2)), de, vers };
  }
);

// ── Outil 2 : recherche météo (données simulées) ────────────────────────────
const meteo = createTool(
  "meteo",
  "Retourne la météo actuelle d'une ville.",
  z.object({ ville: z.string().describe("Nom de la ville") }),
  ({ ville }) => ({
    ville,
    temperature: 19,
    condition: "Partiellement nuageux",
  })
);

const hooks: AgentHooks = {
  beforeToolCall(toolName, args) {
    console.log(`Tool "${toolName}" with args ${JSON.stringify(args)}`);
  },
}

async function main() {
  console.log("══ 02 · Outils ══\n");

  const agent = new Agent({
    name: "AssistantOutillé",
    systemPrompt: "Tu utilises tes outils dès que c'est utile pour répondre précisément.",
    tools: [convertirDevise, meteo],
    parallelTools: true, // les appels d'outils indépendants partent en parallèle
    verbose: true,        // affiche le détail des appels d'outils
    showThinking: true,
    hooks
  });

  const stream = agent.runStream(
    "Combien font 250 USD en euros, et quelle météo fait-il à Orléans ?"
  );

  for await (const event of stream) {
    process.stdout.write(event);
  }

  console.log("\n✅ Terminé.");
}

main().catch(console.error);
