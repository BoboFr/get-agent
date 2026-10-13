/**
 * GetAgent — 03 · Toolkits (modules d'outils réutilisables)
 *
 * Un Toolkit regroupe des outils, un prompt système et des hooks de cycle de vie.
 * (Pour les Agent Skills au format SKILL.md, voir l'exemple 16.)
 * Démontre : toolkit statique, préfixage des outils, ajout/suppression à chaud.
 *
 * Lancer :  npx tsx examples/03_toolkits.ts
 */
import { z } from "zod";
import { Agent, createTool, createToolkit } from "../src/index.js";

// ── Outils du toolkit « finance » ─────────────────────────────────────────────
const tva = createTool(
  "tva",
  "Calcule le prix TTC à partir d'un prix HT.",
  z.object({ ht: z.number(), taux: z.number().default(20) }),
  ({ ht, taux }) => ({ ttc: Number((ht * (1 + taux / 100)).toFixed(2)), taux })
);

const remise = createTool(
  "remise",
  "Applique un pourcentage de remise à un prix.",
  z.object({ prix: z.number(), pourcent: z.number() }),
  ({ prix, pourcent }) => ({ prixRemise: Number((prix * (1 - pourcent / 100)).toFixed(2)) })
);

// ── Outil du toolkit « horloge » ──────────────────────────────────────────────
const maintenant = createTool(
  "maintenant",
  "Retourne la date et l'heure courantes au format ISO.",
  z.object({}),
  () => ({ iso: new Date().toISOString() })
);

// ── Définition des toolkits ───────────────────────────────────────────────────
const finance = createToolkit({
  name: "finance",
  description: "Calculs commerciaux : TVA et remises",
  tools: [tva, remise],
  // Préfixe activé par défaut → outils exposés : finance_tva, finance_remise
  systemPrompt: "Pour tout calcul de prix, utilise finance_tva et finance_remise.",
  initialize: async () => console.log("  ✓ toolkit finance prêt"),
  shutdown: async () => console.log("  ✓ toolkit finance arrêté"),
});

const horloge = createToolkit({
  name: "horloge",
  description: "Utilitaires de date et heure",
  tools: [maintenant],
  prefixToolNames: false, // l'outil garde son nom d'origine : maintenant
});

async function main() {
  console.log("══ 03 · Toolkits ══\n");

  const agent = new Agent({
    name: "AssistantToolkits",
    systemPrompt: "Tu es un assistant équipé d'outils spécialisés.",
    toolkits: [finance],
    verbose: true,
  });

  console.log("Outils au démarrage :", agent.getRegisteredTools().map((t) => t.name));

  // ── Ajout dynamique d'un toolkit ──
  await agent.addToolkit(horloge);
  console.log("Après ajout d'horloge :", agent.getRegisteredTools().map((t) => t.name));

  const r1 = await agent.run("Un article coûte 80€ HT. Quel est son prix TTC à 20% ?");
  console.log("\n💬", r1);

  // ── Suppression à chaud (déclenche le hook shutdown du toolkit) ──
  await agent.removeToolkit("finance");
  console.log("\nAprès retrait de finance :", agent.getRegisteredTools().map((t) => t.name));

  await agent.shutdown();
  console.log("\n✅ Terminé.");
}

main().catch(console.error);
