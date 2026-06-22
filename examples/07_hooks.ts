/**
 * GetAgent — 07 · Hooks / Middleware
 *
 * Intercepter le cycle de vie de l'agent :
 *  - beforeLLMCall  : modifier les messages envoyés au LLM
 *  - afterLLMCall   : observer chaque réponse (audit)
 *  - beforeToolCall : valider/transformer les arguments (false = annuler)
 *  - afterToolCall  : enrichir/remplacer le résultat d'un outil
 *
 * Lancer :  npx tsx examples/07_hooks.ts
 */
import { z } from "zod";
import { Agent, createTool, type AgentHooks } from "../src/index.js";

const traduirePrix = createTool(
  "prix_local",
  "Retourne le prix d'un produit dans une devise donnée.",
  z.object({ produit: z.string(), devise: z.string() }),
  ({ produit, devise }) => ({ produit, devise, prix: 42 })
);

// Journal d'audit alimenté par les hooks
const audit: string[] = [];

const hooks: AgentHooks = {
  beforeLLMCall: (messages) => {
    audit.push(`beforeLLMCall · ${messages.length} message(s)`);
    return messages; // renvoyer void garderait les messages d'origine
  },

  afterLLMCall: (content, toolCalls) => {
    audit.push(
      toolCalls?.length
        ? `afterLLMCall · outils=${toolCalls.map((t) => t.function.name).join(",")}`
        : `afterLLMCall · texte="${(content ?? "").slice(0, 40)}…"`
    );
  },

  beforeToolCall: (toolName, args) => {
    audit.push(`beforeToolCall · ${toolName}(${JSON.stringify(args)})`);
    // Normalise la devise en majuscules avant exécution
    if (toolName === "prix_local" && typeof args.devise === "string") {
      args.devise = args.devise.toUpperCase();
    }
    return args; // renvoyer `false` annulerait l'appel
  },

  afterToolCall: (toolName, _args, result) => {
    audit.push(`afterToolCall · ${toolName} → ${JSON.stringify(result)}`);
    // Enrichit le résultat retourné au LLM
    if (toolName === "prix_local") return { ...result, source: "catalogue-interne" };
    return result;
  },
};

async function main() {
  console.log("══ 07 · Hooks ══\n");

  const agent = new Agent({
    name: "AgentHooké",
    systemPrompt: "Tu réponds en t'appuyant sur tes outils.",
    tools: [traduirePrix],
    hooks,
  });

  const reponse = await agent.run("Quel est le prix du produit 'Clavier' en eur ?");
  console.log("\n💬 Réponse :", reponse);

  console.log("\n📋 Journal d'audit :");
  audit.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));

  await agent.shutdown();
  console.log("\n✅ Terminé.");
}

main().catch(console.error);
